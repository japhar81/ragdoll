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
- `skippedVectors` (number, only emitted when > 0) — count of rows
  whose vector was missing / empty / wrong-length and was therefore
  omitted from the indexed doc. The doc itself still indexes; only
  the vector field is dropped.

## Gotchas

- `idField` is read from each doc to derive the OpenSearch `_id`. Without
  it, OpenSearch auto-generates one — fine for fresh ingestion, terrible
  for idempotent re-runs.
- `createKnnIndex: true` provisions a kNN-enabled mapping if the index is
  missing. Requires `vectorField` and `dimensions`. The index is created
  with the configured `distance` metric.
- **Vector hygiene.** A `vectors[i]` that's `undefined`, `null`, an
  empty array, or wrong-length (when `dimensions` is set) is DROPPED
  rather than written. Earlier behaviour wrote the bad value through,
  which OpenSearch's knn_vector field reported as `'null'` in its bulk
  error preview — masking the real upstream issue (usually an Ollama
  context-overflow on the first chunk). The skipped count surfaces on
  the `skippedVectors` output and in execution metadata so operators
  can find and re-embed the affected rows.
- Endpoint resolution mirrors OpenSearch Input.

## Typical position

Loader → Chunker → Embedder → (OpenSearch Output)
