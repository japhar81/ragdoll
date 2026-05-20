# OpenSearch Vector Retriever

kNN search against an OpenSearch knn_vector index. Embeds the question
on-demand when no `queryVector` is provided, so it works as a drop-in
replacement for the Qdrant retriever against the OpenSearch backend.

## Inputs

- `queryVector: number[]` (preferred) — skip the embed step.
- otherwise the question is embedded with the configured `provider` /
  `model` and the `apiKey` secret.

## Outputs

- `documents` — `Array<{ id, score, ...payload }>` ordered by kNN score
  descending.

## Gotchas

- The target `index` must have a `knn_vector` mapping. Use OpenSearch
  Output with `createKnnIndex: true` to provision one.
- Tenant filtering is applied via the underlying vector store wrapper,
  using the execution's `tenantId`. The optional `filter` config can
  layer additional exact-match clauses on top.
- A vector dim mismatch between the query and the indexed vectors yields
  a kNN error from OpenSearch — keep the embedding model identical to
  the one used at ingestion.

## Typical position

Source → (OpenSearch Vector Retriever) → Reranker / Prompt template
