# Qdrant Vector Store

Same job as Vector Upsert — ensure-collection + upsert — but with a
`vector_store` category so it slots into the "Storage" group of the
palette and accepts an `apiKey` *secret* (rather than a plain config
string) for the Qdrant client.

## Inputs

- `vectors` (`number[][]`) — required.
- `chunks` (`Array<{ text?, index?, id?, ...metadata }>`) — zipped with
  `vectors` to form each point's payload.

## Outputs

- `upserted` (number) — count of points written; `0` if `vectors` is empty.
- `collection` (string) — the resolved collection name.

## Gotchas

- Same dimensionality and tenancy rules as Vector Upsert apply.
- Prefer this one when wiring a hosted Qdrant cluster: the API key lives
  in Secrets, never the pipeline spec.
- Falls back to the in-memory store when `url` is empty — useful for
  smoke tests, not for production state.

## Typical position

Loader → Chunker → Embedder → (Qdrant Vector Store)
