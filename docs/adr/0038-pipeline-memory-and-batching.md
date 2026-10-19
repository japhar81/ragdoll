# ADR-0038 — Pipeline memory bounds + batch-by-reference (M2 scaling)

## Status

Accepted — Phase 0 + Phase 1 implemented.

## Context

RAGdoll passes a single JSON structure between pipeline steps — typically a
collection of documents — and each step runs to completion before its whole
output becomes the next step's input. Two consequences of the executor
(`packages/runtime/src/index.ts`):

1. **Per-node materialization.** Every plugin returns its *complete* output
   before the next step starts (`execute(input) → { outputs }`). A source emits
   `{ documents: [...all...] }`; a transform reads and rebuilds the whole array;
   the sink receives the whole array. No plugin streams.
2. **Whole-run retention.** The executor kept **every** node's full output in an
   in-memory `outputs` map for the entire run and never evicted it — so peak
   worker RAM was the *sum* of all steps' payloads.

A crude test (≈32k mixed docs, ~1 GB total, incl. ~1k × 1 MB docs) peaked a
worker at ~3.6 GB RSS and dropped to ~125 MB when idle. A DoclingDocument blob
is a few KB to ~2 MB (≈half of a large one is base64 inline images). We expect
corpora with 100,000s of documents, so "load the whole thing into RAM" does not
scale.

### Options considered

- **Executor output eviction** — free consumed outputs. Solves #2 only; cheap.
- **True streaming** (async iterators between nodes, a per-plugin "stream"
  checkbox) — solves #1 for linear in-process chains, but is a full
  plugin-contract rewrite, the external/sidecar HTTP boundary can't stream
  without a new chunked protocol, fan-in/out + back-pressure are hard, and it
  gives no resumability or reprocessing.
- **Batch-by-reference** — stage a collection to durable paged storage and pass
  a small handle; a batch iterator runs a sub-pipeline per page via the existing
  `runSubgraph`. Solves #1 and #2, reuses in-production primitives
  (`runSubgraph` powers `for_loop`/`foreach`; `ingestStateStore` powers
  `delta_filter`), works for in-process AND sidecar plugins (the inner
  sub-pipeline runs anything), and delivers resumability + "reprocess previously
  staged content" for free.

## Decision

### Phase 0 — bound retention + fail loud (runtime)

- **Output eviction.** A node's output is freed from the in-run `outputs` map
  once all its consumers have resolved. Gated on an explicit `output` node (so
  terminal selection is unambiguous); the output node + its direct sources are
  protected, and leaves are never decremented. Pure hygiene — an evicted output
  is provably unread (`onOutputEvicted` test hook proves it).
- **Doc-count cap.** A step whose output holds more than `maxNodeOutputDocs`
  documents (largest top-level array, measured by `.length` — never serialized,
  since serializing a multi-GB output to measure bytes would itself OOM) fails
  with `NodeOutputTooLargeError` instead of silently OOM-killing the pod (which
  takes down *every* in-flight run on it). Wired from
  `RAGDOLL_MAX_NODE_OUTPUT_DOCS` on the worker + API; `0`/unset disables.

### Phase 1 — batch-by-reference (`packages/collection-store` + two plugins)

- **Collection store.** A collection staged out of RAM into durable, *paged*
  storage, addressed by a small `CollectionHandle` (`{ id, pageCount, count,
  root }`). Filesystem backing writes JSONL pages under `<root>/<id>/` and reads
  one page at a time; an in-memory backing exists for tests only. In k8s
  `<root>` MUST be a durable, shared mount (PVC / object-store) for cross-run
  reprocessing and multi-worker resume — set `RAGDOLL_COLLECTION_DIR`.
- **`stage_collection`** writes an in-memory documents array to a paged
  collection and emits the handle; everything downstream flows the handle.
- **`foreach_batch`** runs a body sub-pipeline once per batch, reading a staged
  handle one page at a time (or slicing an array) with bounded `concurrency`,
  and — with a `resumeKey` — checkpoints committed batches in `ingestStateStore`
  so a re-run skips them. Peak memory ≈ `pageSize × concurrency × docSize`,
  independent of corpus size. Output is a bounded summary (counts + failed batch
  indexes), never every batch result.

Fan-out is the `concurrency` knob; "reprocess previously staged content" is just
re-running `foreach_batch` on a persisted handle. Both are in-process plugins
(they use `runSubgraph`); the *inner* sub-pipeline may contain any plugin,
including Python-sidecar ones.

## Consequences

- A linear ingest at scale becomes: `source → stage_collection → foreach_batch(
  body: transform → embed → sink)`. Memory is flat regardless of corpus size,
  and a failed 100k-doc run resumes from the last committed batch.
- `stage_collection` still materializes its input array once (it received it
  from the source) — the staging point is the memory handoff, and everything
  downstream is bounded. The remaining source-side win (a crawler that stages
  incrementally and emits a handle directly, so the array is never fully held)
  is a follow-on; the handle contract is already in place for it.
- Eviction only helps when there's an `output` node (the norm); without one it
  is disabled (safe). It does not by itself fix a 3-node linear run dominated by
  source materialization — that's what Phase 1 addresses.
- Durability/sharing of the collection root is a deployment requirement; the fs
  backing is pluggable (an object-store backing is a drop-in follow-on).
- True streaming (Phase 2) remains an option for in-process linear hot paths,
  deferred and scoped — the batching foundation covers the scaling need without
  the contract rewrite.

## Verification

- Runtime: eviction frees intermediates + keeps the terminal output correct; the
  cap throws attributed to the node, with boundary + disable cases
  (`packages/runtime/test/scaling-phase0.test.ts`).
- Store + plugins: round-trip + fresh-instance durability; stage paging; batching
  math; staged-handle bounded reads; bounded concurrency; resume/skip +
  checkpoint; fail-fast (commits finished batches) + continueOnError; and an
  end-to-end `DagExecutor` run proving every doc is processed in bounded pages
  (`packages/collection-store/test/`, `plugins/builtin-rag/test/batching*.test.ts`).

## References

- `packages/runtime/src/index.ts` — eviction, `NodeOutputTooLargeError`,
  `maxNodeOutputDocs`, `onOutputEvicted`.
- `packages/collection-store/src/index.ts` — `CollectionHandle` / store backings.
- `plugins/builtin-rag/src/plugins/batching.ts` — `stage_collection` /
  `foreach_batch`.
