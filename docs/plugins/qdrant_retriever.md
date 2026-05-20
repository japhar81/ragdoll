# Qdrant Retriever

Top-K vector retrieval against a Qdrant collection — or the in-memory
fallback store when no Qdrant URL is configured. Embeds the question
on-demand if no pre-computed `queryVector` is supplied, so the simplest
query pipeline can be `input → retriever → prompt → llm` with no separate
embedder node.

## Inputs

- `queryVector: number[]` — use this directly when provided.
- otherwise `question: string` (top-level or under `input.question`) is
  embedded using the node's `provider`/`model` config + `apiKey` secret.

## Outputs

- `documents` — `Array<{ id, score, ...payload }>` ordered by descending
  score. The payload object is whatever was stored on the point at upsert
  time (typically `text`, `chunkIndex`, plus any metadata).

## Gotchas

- All queries are filtered by `context.tenantId` server-side, so a node
  cannot cross tenant boundaries even with a malformed filter.
- `url` left empty selects the in-process in-memory store. Great for local
  dev, useless across worker restarts — it forgets everything.
- The optional `filter` config is a Qdrant payload filter, not a
  `must`/`should` bool. See Qdrant docs for shape.

## Typical position

Source → (Qdrant Retriever) → Reranker / Prompt template → LLM
