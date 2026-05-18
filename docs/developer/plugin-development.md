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

## Declaring config / secrets schemas (schema-driven forms)

The web UI renders a real config/secrets form from the manifest instead of a
JSON textarea (see ADR 0008). Populate these manifest fields so the form is
accurate:

- `configSchema` — a `JsonSchemaLike` describing exactly what `execute` reads
  from `config`. Use `enum` for fixed choices, `default` to seed the control
  with the plugin's runtime default, and `description` for inline help.
- `secretsSchema` — declare only if the plugin reads `secrets`. Mark secret
  fields with `format: "secret-ref"`; the UI renders a secret picker and only a
  *reference* (never raw key material) is stored in node config.
- `ui.formHints` — per-field rendering hints keyed by property name, e.g.
  `{ temperature: { widget: "range", min: 0, max: 2, step: 0.1 },
  apiKey: { widget: "secret" } }`. Values are opaque to the control plane.
- `ui.icon` / `ui.color` / `ui.paletteGroup` — palette presentation metadata.

`JsonSchemaLike` is the dependency-free subset in `@ragdoll/plugin-sdk`:
`{ type?, properties?, required?, items?, additionalProperties?, description?,
enum?, default?, format? }`. No JSON-Schema library is used.

```ts
manifest: {
  // ...
  configSchema: {
    type: "object",
    properties: {
      provider: { type: "string", enum: ["openai", "anthropic", "ollama"], default: "ollama" },
      temperature: { type: "number", default: 0.2 }
    },
    additionalProperties: false
  },
  secretsSchema: {
    type: "object",
    properties: {
      apiKey: { type: "string", format: "secret-ref", description: "Provider API key" }
    }
  },
  ui: {
    formHints: {
      temperature: { widget: "range", min: 0, max: 2, step: 0.1 },
      apiKey: { widget: "secret" }
    }
  }
}
```

Keep the schema in lockstep with what `execute` actually reads — the schema is
the contract the UI builds the form from.

### Optional custom editor (`ui.module`, Tier-2 seam)

For the rare plugin that needs a bespoke editor, a manifest may set
`ui.module`: an ESM module URL. The module default-exports (or exports a named
`ConfigEditor`) a React component with the signature:

```ts
(props: {
  value: Record<string, unknown>;
  schema?: JsonSchemaLike;
  onChange: (next: Record<string, unknown>) => void;
}) => ReactNode
```

`value` is the controlled non-secret config; call `onChange` with the full next
config object on every edit; `schema` is the plugin's `configSchema` for
reference. Secret values are never passed to or returned from a custom editor —
it may only emit secret references. Custom editors are untrusted code: hosts
load them admin-only/registered and sandboxed, defaulting to the schema-driven
form otherwise. This is a typed contract seam only; see ADR 0008.

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
- `text_document_loader` (loader)
- `text_parser` (parser)
- `basic_text_chunker` (chunker)
- `provider_embeddings` (embedder)
- `qdrant_vector_store` (vector_store)
- `vector_upsert` (sink)
- `qdrant_retriever` (retriever)
- `score_reranker` (reranker)
- `basic_rag_prompt` (prompt_template)
- `provider_chat` (llm)
- `static_value_tool` (tool)
- `field_router` (router)
- `buffer_memory` (memory)
- `json_output_parser` (output_parser)
- `simple_keyword_guardrail` (guardrail)
- `simple_evaluator_stub` (evaluator)

Together with the `sample_uppercase_transformer` (transformer) plugin from
`plugins/sample-text`, every palette category has at least one built-in,
schema-bearing plugin so the visual builder always renders a real form.

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
