# Dataset Upsert

The v2-native write primitive. Same role as `vector_upsert` but reads
the backend (Qdrant / pgvector) from the resolved Dataset's
`backends.vector.provider` instead of from `config.url`. Lets you swap a
dataset from Qdrant to pgvector by editing the dataset row — no
pipeline edit, no re-deploy.

## Inputs

- `chunks` (`Array<{ text?, ...metadata }>`) — what to store alongside
  each vector.
- `vectors` (`number[][]`) — embedding vectors aligned 1:1 with `chunks`.

## Outputs

- `upserted` (number) — count of points written.

## Gotchas

- `node.dataset` MUST be wired (no legacy fallback — use
  `vector_upsert` for unscoped writes).
- Dimensions default to `vectors[0].length`. The collection's existing
  dimensions win on re-ensure; mismatch throws.
- Tenant scoping: each point is tagged with `context.tenantId` so a
  retrieval scoped to the wrong tenant never returns these rows, even
  if they share a collection.
- IDs: deterministic `${context.executionId}:${i}` by default; override
  with `config.idPrefix`. Re-running the same ingestion replays the same
  ids → ON CONFLICT updates instead of duplicating.

## Typical position

`filesystem_source → basic_text_chunker → provider_embeddings → dataset_upsert`
