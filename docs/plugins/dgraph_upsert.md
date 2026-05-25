# Dgraph Upsert

Writes nodes (and edges, encoded as nested-object arrays under the
predicate name) into a Dgraph instance. Tags every node with the
executing tenant id so multi-tenant isolation is enforced at the
storage layer.

Pairs with `dgraph_query` for retrieval — both plugins declare
`contract: 2` + `datasetModalities: ["graph"]`, so the Builder picker
only offers them datasets whose modalities include `graph`.

## Inputs

- `nodes` (required) — array of objects. Each may carry:
  - `uid` — real uid (e.g. `"0x1a"`) for upserts, or `"_:alias"` to
    request Dgraph mint a fresh uid the rest of the batch can refer
    to via the same alias.
  - `dgraph.type` — the node-type label (queryable via `type(<T>)`).
  - any number of predicate fields. Edges are objects-in-an-array
    under the predicate name (Dgraph's native shape): e.g.
    `{ uid: "_:alice", knows: [{ uid: "_:bob" }] }`.

## Outputs

- `upserted` — count of nodes accepted by the mutation.
- `uids` — map of `_:alias` → real uid that Dgraph minted on this
  call. Useful when a later node in the same batch wants to reference
  the alias.

## Config

- `url` (optional) — Dgraph HTTP endpoint. Falls back to the bound
  dataset's `backends.graph.url`, then to the platform's `DGRAPH_URL`
  env, then to the in-memory store (offline mode).
- `schema` (optional) — DQL schema fragment applied via `/alter`
  before the first write. Idempotent on Dgraph's side; use it to
  declare indexed predicates.

## Tenant isolation

Every node passed to `setJson` is stamped with `tenant_id` equal to
the executing tenant before the request. Reads via `dgraph_query`
should always filter on `eq(tenant_id, $tenant_id)`; the runtime
exposes the tenant id as a `$tenant_id` query variable.

## Cost shape

One `POST /mutate?commitNow=true` per pipeline run. Use bigger
batches (one upsert with N nodes) instead of many small ones — Dgraph
charges per round-trip, not per node.

## When to use

- You have structured relations (entities, edges, hierarchies) that
  outgrow a flat vector index.
- You need graph traversal at query time (k-hop neighbors, shortest
  path, etc.).
- You want the same corpus joined across multiple modalities — pair a
  `graph` modality with a `vector` modality on the same dataset slug
  and let `dgraph_query` complement `dataset_search`.

## When NOT to use

- Plain semantic search — `dataset_search` (vector mode) is cheaper.
- Append-only logs — a graph adds overhead for shapes a flat table
  handles better.

## Sample

See `examples/pipelines/github-knowledge-graph.yaml` for an end-to-end
ingest pipeline (`github_source` → `basic_text_chunker` →
`dgraph_upsert`).
