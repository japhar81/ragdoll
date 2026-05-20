# OpenSearch BM25 Retriever

Lexical search via OpenSearch's `multi_match` (best_fields) query. No
embeddings required — sharp where keyword matches matter, weaker on
paraphrases. Tenant-scoped by default.

## Inputs

- `question` (top-level or `input.question`, with fallback to `text`) —
  the query string scored against the configured `fields`.

## Outputs

- `documents` — `Array<{ id, score, ...source }>` ordered by BM25 score
  descending.

## Gotchas

- `tenantField` defaults to `"tenantId"`. To search across tenants
  intentionally, set it to an empty string — the default is sticky and
  will surprise you in shared-index setups.
- `fields` accepts the `field^boost` syntax OpenSearch supports
  (e.g. `["title^3", "body"]`).
- `filter` is a flat map: scalar values become `term`, arrays become
  `terms`.

## Typical position

Source → (OpenSearch BM25 Retriever) → Reranker / Prompt template
