# Plugin reference

Per-plugin narrative docs for every built-in node. Each page describes:

- **What it does** — short prose summary.
- **Inputs** — the shape this node reads off the incoming payload.
- **Outputs** — the shape it emits to downstream nodes.
- **Gotchas** — surprises, scope rules, fallback behavior.
- **Typical position** — where this node usually sits in a DAG.

Schema-derived sections — required configs, required secrets, every field's
type and default, and a copy-paste sample JSON — are NOT in the markdown.
They are computed at render time from the plugin's manifest by the Builder's
**Docs tab**, so adding a new config field to a plugin automatically updates
the in-app docs without a markdown edit.

## Where these are surfaced

- **Builder → Inspector → Docs tab**: bundled markdown plus live
  schema-derived sections for the selected node.
- **Repo browsing**: read them directly here for offline reference.

## Adding docs for a new plugin

1. Create `docs/plugins/<plugin_id>.md` (the file basename must match the
   manifest `id`).
2. Use the standard sections: brief intro, `## Inputs`, `## Outputs`,
   `## Gotchas`, `## Typical position`.
3. Rebuild the web app (`make refresh`). Docs are bundled into the JS at
   build time via vite's `import.meta.glob('?raw')` — no API change
   required.

## Source manifests

The plugins themselves live at:

- `plugins/builtin-rag/src/index.ts` — RAG primitives (chunkers, embedders,
  retrievers, prompt templates, LLM, parsers, guardrails, evaluators,
  memory, OpenSearch suite, webhook trigger/output).
- `plugins/sample-text/index.ts` — the example transformer.

External plugins served over HTTP/gRPC (see ADR-0007) get the same docs
treatment as long as their `id` matches a bundled markdown filename.

## Bundled docs

| Plugin id | Category | Doc |
| --- | --- | --- |
| basic_rag_prompt | prompt_template | [basic_rag_prompt.md](basic_rag_prompt.md) |
| basic_text_chunker | chunker | [basic_text_chunker.md](basic_text_chunker.md) |
| buffer_memory | memory | [buffer_memory.md](buffer_memory.md) |
| code_chunker | chunker | [code_chunker.md](code_chunker.md) |
| delta_filter | transformer | [delta_filter.md](delta_filter.md) |
| field_router | router | [field_router.md](field_router.md) |
| filesystem_source | datasource | [filesystem_source.md](filesystem_source.md) |
| for_loop | router | [for_loop.md](for_loop.md) |
| foreach | router | [foreach.md](foreach.md) |
| if_then | router | [if_then.md](if_then.md) |
| opensearch_delete | sink | [opensearch_delete.md](opensearch_delete.md) |
| json_output_parser | output_parser | [json_output_parser.md](json_output_parser.md) |
| manual_text_input | datasource | [manual_text_input.md](manual_text_input.md) |
| opensearch_bm25_retriever | retriever | [opensearch_bm25_retriever.md](opensearch_bm25_retriever.md) |
| opensearch_hybrid_retriever | retriever | [opensearch_hybrid_retriever.md](opensearch_hybrid_retriever.md) |
| opensearch_input | datasource | [opensearch_input.md](opensearch_input.md) |
| opensearch_output | sink | [opensearch_output.md](opensearch_output.md) |
| opensearch_vector_retriever | retriever | [opensearch_vector_retriever.md](opensearch_vector_retriever.md) |
| path_classifier | router | [path_classifier.md](path_classifier.md) |
| provider_chat | llm | [provider_chat.md](provider_chat.md) |
| provider_embeddings | embedder | [provider_embeddings.md](provider_embeddings.md) |
| qdrant_delete | sink | [qdrant_delete.md](qdrant_delete.md) |
| qdrant_retriever | retriever | [qdrant_retriever.md](qdrant_retriever.md) |
| qdrant_vector_store | vector_store | [qdrant_vector_store.md](qdrant_vector_store.md) |
| sample_uppercase_transformer | transformer | [sample_uppercase_transformer.md](sample_uppercase_transformer.md) |
| score_reranker | reranker | [score_reranker.md](score_reranker.md) |
| simple_evaluator_stub | evaluator | [simple_evaluator_stub.md](simple_evaluator_stub.md) |
| simple_keyword_guardrail | guardrail | [simple_keyword_guardrail.md](simple_keyword_guardrail.md) |
| static_value_tool | tool | [static_value_tool.md](static_value_tool.md) |
| text_document_loader | loader | [text_document_loader.md](text_document_loader.md) |
| text_parser | parser | [text_parser.md](text_parser.md) |
| vector_upsert | sink | [vector_upsert.md](vector_upsert.md) |
| webhook_output | sink | [webhook_output.md](webhook_output.md) |
| webhook_trigger | datasource | [webhook_trigger.md](webhook_trigger.md) |
| while_loop | router | [while_loop.md](while_loop.md) |
