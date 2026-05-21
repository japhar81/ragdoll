# Delta Filter

Compares the current set of input documents against persisted state for the
executing `(tenant, pipeline, stateKey)` bucket and emits **new** /
**modified** / **deleted** documents on three independent output ports.
Downstream branches wired to an empty port are skipped by the runtime.

This is the brain of delta-aware ingestion: pair it with `filesystem_source`
upstream and a chunker + embed + sink (plus a delete sink) downstream and
you have an incremental indexer.

## Inputs

- `documents` (required) — the current full set of source documents. Each
  must carry a `docId` (or `path`) so the filter can correlate against
  state. `mtime` and/or `sha256` is needed depending on `compareBy`.

## Outputs

Exactly which ports are live depends on the diff against state. Empty ports
emit `undefined`, which the runtime treats as a dead branch.

- `new` — documents the filter has never recorded before.
- `modified` — documents whose `mtime` and/or `sha256` differs from state.
- `deleted` — `{ docId }[]` for entries in state that are missing from
  the current run (i.e. the source file was deleted).
- `unchanged` — documents whose state matches; typically left unwired. Wire
  it only if you need to count or audit.

## Config

- `stateKey` (required) — bucket name. Use distinct keys to keep
  independent ingest paths (e.g. `code` vs `docs`) from colliding inside one
  pipeline.
- `compareBy` (default `mtime`):
  - **`mtime`** — re-emit when the file's mtime moved. Cheap and good
    enough for steady-state edit-and-run. Over-ingests after operations
    that bump mtimes without changing content (e.g. branch swaps).
  - **`hash`** — re-emit when the sha256 changed. Costs you a full read +
    digest per file on every run. Most precise.
  - **`mtime+hash`** — mtime as a fast gate, sha256 confirmation only when
    mtime moved. Best of both: most runs are mtime-cheap, branch swaps
    correctly resolve to "no change" because hashes match.

## Trade-offs

| Mode          | First-run cost | Steady-state cost | Branch-swap behaviour       |
|---------------|----------------|-------------------|-----------------------------|
| `mtime`       | low            | very low          | over-ingests                |
| `hash`        | high           | high              | correct                     |
| `mtime+hash`  | high           | very low          | correct                     |

`mtime` is the default because for most use cases the over-ingestion is
benign and the I/O savings are significant.

## State storage

The runtime hands the plugin an `ingestStateStore` auto-scoped to the
executing tenant + pipeline. Postgres backing stores the bucket in the
`ingest_state` table (migration 008). With no Postgres configured, the
plugin sees an empty state on every run — effectively treating everything
as new.

## Typical position

```
filesystem_source → delta_filter
  ├── new + modified → chunker → embed → vector store
  └── deleted        → vector store delete
```

## Gotchas

- The state bucket is replaced wholesale every run. Don't share one
  `stateKey` across two pipelines or they'll keep stomping each other.
- Deletes are detected purely by absence — a doc you rename will be
  emitted as one `deleted` + one `new`, not a rename. That's the right
  thing for vector stores (the embedding probably needs to move anyway).
