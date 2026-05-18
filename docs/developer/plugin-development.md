# Plugin Development

Plugins are versioned capabilities referenced by pipeline nodes. A node stores
only `category`, `id`, and `version`; business logic lives in the plugin
runtime.

## Required manifest fields

- `id`
- `name`
- `version`
- `category`
- `description`
- optional config, secrets, input, and output schemas
- optional capabilities and UI metadata

## In-process plugin

```ts
import type { InProcessPlugin } from "@ragdoll/plugin-sdk";

export const plugin: InProcessPlugin = {
  manifest: {
    id: "sample_uppercase_transformer",
    name: "Sample Uppercase Transformer",
    version: "1.0.0",
    category: "transformer",
    description: "Uppercases an input field."
  },
  async execute({ inputs, config }) {
    const field = String(config.field ?? "text");
    return { outputs: { ...inputs, [field]: String(inputs[field] ?? "").toUpperCase() } };
  }
};
```

See `plugins/sample-text/index.ts`.

## Auto-discovery

`packages/plugin-loader` builds the registry by scanning `Object.values()` of
the `plugins/builtin-rag` and `plugins/sample-text` module namespaces and
duck-typing each export as an `InProcessPlugin` (a `manifest` with a string
`id` plus an `execute` function). Adding a new exported plugin to either module
is picked up automatically with no loader edits. Plugins are keyed by
`category:id:version`.

## Built-in RAG plugins

`plugins/builtin-rag` ships an end-to-end RAG toolkit:

- `manual_text_input` (datasource)
- `basic_text_chunker` (chunker)
- `provider_embeddings` (embedder)
- `vector_upsert` (sink)
- `qdrant_retriever` (retriever)
- `basic_rag_prompt` (prompt_template)
- `provider_chat` (llm)
- `json_output_parser` (output_parser)
- `simple_keyword_guardrail` (guardrail)
- `simple_evaluator_stub` (evaluator)

`vector_upsert` and `qdrant_retriever` use the shared `VectorStore` (in-memory
singleton offline, Qdrant when configured), so an upsert followed by a retrieve
round-trips in-process and in tests.

## External plugins

External plugins register an HTTP or gRPC endpoint. The gateway contract is the
same shape as the in-process `execute`:

- request: context metadata, node metadata, inputs, resolved non-secret
  config, resolved secrets
- response: outputs, metadata, usage, artifacts

External execution is scaffolded in the SDK and should be enabled through a
plugin gateway with sandboxing, timeouts, mTLS, request signing, and payload
size limits.

## Security rules

- Never log raw secrets.
- Mark sensitive outputs so runtime redaction applies.
- Validate untrusted URLs and enforce allow/deny lists for datasource
  connectors.
- Avoid storing tenant credentials in plugin-local state.
