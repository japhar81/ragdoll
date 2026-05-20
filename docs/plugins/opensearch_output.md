# OpenSearch Output

Bulk-indexes documents (or chunk-derived docs) into an OpenSearch index.
Stamps each document with the execution's tenant id so a tenant-aware
retriever can filter cleanly. Can optionally provision a kNN-enabled
index for vector search.

## Inputs

Accepts either (or both):
- `documents` — `Array<Record<string, unknown>>`, indexed as-is.
- `chunks` + `vectors` — chunks indexed as docs; the parallel vector at
  `vectors[i]` is written to `vectorField` if configured.

## Outputs

- `indexed` (number) — count of documents the bulk API reported as
  written.

## Gotchas

- `idField` is read from each doc to derive the OpenSearch `_id`. Without
  it, OpenSearch auto-generates one — fine for fresh ingestion, terrible
  for idempotent re-runs.
- `createKnnIndex: true` provisions a kNN-enabled mapping if the index is
  missing. Requires `vectorField` and `dimensions`. The index is created
  with the configured `distance` metric.
- Endpoint resolution mirrors OpenSearch Input.

## Typical position

Loader → Chunker → Embedder → (OpenSearch Output)
