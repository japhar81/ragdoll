# Dataset Search

The v2-native retrieval primitive. Pin the node to a Dataset (via the
Builder's Inspector → Dataset section) and the runtime dispatches the
query to the right backend at execute time — Qdrant / pgvector behind
the `vectors` binding, OpenSearch behind the `keywords` binding (per
ADR-0023 §2). The plugin never names a collection itself; that came in
over Phase 5's dataset resolver.

## Inputs

- `question` (string) — natural-language query. Embedded on the fly via
  the provider in `config.provider` when no `queryVector` is supplied.
- `queryVector` (`number[]`) — pre-computed embedding. Skips on-the-fly
  embedding when present.

## Outputs

- `documents` — ranked array of `{ id, score, ...payload }`. Payload
  fields come from the stored chunk metadata.

## Gotchas

- `node.dataset` MUST be wired. The plugin throws "dataset_search
  requires node.dataset to be wired" otherwise — there's no legacy
  collection-name fallback (that's `qdrant_retriever`'s job).
- `config.mode` selects `"vector"` vs `"keyword"`. Datasets without
  the matching binding (`vectors` for vector mode, `keywords` for
  keyword mode) will throw — the plugin requires a binding it can
  resolve to a connection.
- Embedding cost: the on-the-fly embedding path calls the configured
  provider for each invocation. Set `config.provider: "ollama"` for
  local zero-cost embedding; OpenAI / Anthropic for hosted models.
- pgvector backend selection: when the Dataset's
  `bindings.vectors.connectionKind === "pgvector"` the plugin uses
  `PgVectorStore` regardless of `RAGDOLL_VECTOR_BACKEND` — the dataset
  wins.

## Typical position

`question → query_hyde → dataset_search → rerank_llm → basic_rag_prompt → provider_chat`
