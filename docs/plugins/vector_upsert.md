# Vector Upsert

Persists embedded chunks into a vector store (Qdrant or the in-memory
fallback). Ensures the target collection exists with the right dimensions
and distance metric before writing.

## Inputs

- `vectors` (`number[][]`) — required; one vector per point to upsert.
- `chunks` (`Array<{ text?, index?, id?, ...metadata }>`) — optional but
  recommended; zipped positionally with `vectors`. The chunk's `text`,
  `chunkIndex`, and any extra fields become the point payload.

## Outputs

- `upserted` (number) — count of points written. `0` short-circuits when
  `vectors` is empty.

## Gotchas

- `dimensions` is inferred from `vectors[0].length` if not set; mismatched
  vector sizes within one batch will trip the store.
- Each point's id is `chunk.id` when present, otherwise
  `${idPrefix ?? executionId}_${index}`. Stable ids let you re-run
  ingestion idempotently.
- `tenantId` from the execution context is stamped onto every point's
  payload — retrieval-side filtering depends on this.

## Typical position

Loader → Chunker → Embedder → (Vector Upsert)
