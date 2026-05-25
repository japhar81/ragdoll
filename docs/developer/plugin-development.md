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

### Storage-touching plugins (Builder picker + validation)

Plugins whose category is in `STORAGE_CATEGORIES`
(`vector_store` / `retriever` / `sink` / `loader`) participate in the
dataset-binding system. Two manifest fields drive the Builder UX and
the validator:

- `contract: 1 | 2` — `1` (default) is the legacy "name your own
  collection in `config.collection`" path; `2` opts in to the
  dataset-aware contract where the runtime resolves a
  `ResolvedDataset` from `node.dataset.slug` (+ optional `alias`)
  using the (tenant, env) the run was bound to. ADR 0019 covers the
  full delta.
- `datasetModalities?: ("vector" | "text" | "graph" | "image")[]` —
  declares which backend slots the plugin needs inside the resolved
  dataset. The Builder's slug picker hides datasets that don't
  declare every required modality, and the validator emits
  `dataset_modality_mismatch` if a pinned slug lacks one. Hybrid
  plugins (e.g. `opensearch_hybrid_retriever`) list `["vector", "text"]`.
  Plugins that pick modality from config at runtime (e.g.
  `dataset_search`) leave this undeclared so the picker doesn't
  pre-filter.

The validator also fires `missing_required_dataset` on any v2 storage
node without a `node.dataset.slug`. Save still works; Publish /
Deploy / Run are blocked until the badge clears.

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

## Declaring input / output ports

Ports give your plugin **named, independently-wireable** inputs and outputs.
Without declared ports, the runtime falls back to legacy wiring (flat-merge
upstream outputs into the downstream `inputs` bag plus a per-source-node
wrapper). With declared ports:

- The builder draws one handle per port on the corresponding edge of the
  node card, labelled with the port name.
- Edges carry `fromPort` / `toPort`, and the runtime delivers
  `upstream.outputs[fromPort]` directly to `inputs[toPort]`.
- An output port your plugin doesn't emit on (i.e. the key is absent from
  the returned `outputs` map) is a **dead branch** — downstream nodes wired
  to it are recorded as `skipped` and don't run.

Use ports whenever your plugin has multiple distinct outputs that should be
wireable to different downstream nodes, or when its inputs come from
specific named slots rather than a free-form payload bag.

```ts
manifest: {
  // ...
  inputPorts: [
    { name: "documents", required: true, description: "Retrieved docs" },
    { name: "question",  required: true, description: "User question" }
  ],
  outputPorts: [
    { name: "messages", description: "Chat-style messages ready for an LLM" }
  ]
}
```

### Port semantics

- `name` — unique per side (input or output).
- `required` — when true on an input port, a node lacking a live upstream
  value on that port is **skipped** (cascades to its descendants).
- `description` — surfaced in handle tooltips and the Builder Docs tab.
- `schema` — optional `JsonSchemaLike` describing the payload at the port.

### Branching via output ports

Control-flow plugins (`if_then`, see `docs/plugins/if_then.md`) emit on
exactly one of multiple output ports. Other ports are absent from the
`outputs` map, marking those branches dead. The runtime then skips every
downstream node reachable only through dead branches — this is the
sanctioned way to fork a DAG along a condition.

### Iteration via subgraphs

Iteration plugins (`for_loop`, `foreach`, `while_loop`) accept a `body`
pipeline spec in their config and recursively execute it via the
`runSubgraph` callback the runtime provides on `PluginExecutionInput`. See
`docs/plugins/foreach.md` etc. for the per-iteration input contract.

### Config-driven ports

A plugin whose ports the *author* defines per node (rather than the plugin
author fixing them) declares `dynamicPorts` instead of `inputPorts` /
`outputPorts`:

```ts
manifest: {
  // …
  dynamicPorts: { inputsFrom: "inputs", outputsFrom: "outputs" }
}
```

`inputsFrom` names a config key holding a `string[]` of input port names;
`outputsFrom` names a config key holding an object whose keys are output port
names. The builder reads handle names from the node's own config, so the
canvas re-draws as the author edits config. **Leave `inputPorts` /
`outputPorts` undeclared** — an empty static contract is what stops
`validatePipelineSpec` from warning about the author-named ports. The runtime
is unaffected: it routes edges by name whether or not the port was statically
declared. `transform` (see `docs/plugins/transform.md`) is the reference
example.

## Auto-discovery

`packages/plugin-loader` builds the registry by scanning `Object.values()` of
the `plugins/builtin-rag` and `plugins/sample-text` module namespaces and
duck-typing each export as an `InProcessPlugin` (a `manifest` with a string
`id` plus an `execute` function). Adding a new exported plugin to either module
is picked up automatically with no loader edits. Plugins are keyed by
`category:id:version`.

## Per-node narrative docs (Builder Docs tab)

The Builder's right inspector has a **Docs** tab that renders, per selected
node:

- The manifest header (name, category, version, capabilities, mode).
- A narrative description from `docs/plugins/<id>.md` covering inputs,
  outputs, gotchas, and the node's typical position in a DAG.
- Required-config / required-secret lists derived live from the manifest.
- A field table for `configSchema` / `secretsSchema` with types, defaults,
  and per-field notes from the schema's `description`.
- A copy-paste sample JSON config built from each field's `default` (or
  the first `enum` value when no default is set).

The schema-derived sections read the manifest directly, so updating a
config option's `description` or `default` propagates to the Docs tab on
the next build with no markdown edit. Keep the markdown narrative-only:
the things a reader can't infer from the schema (what the node consumes,
what it emits, surprises, recommended placement). See ADR 0013.

When you add a new built-in plugin, drop a sibling `docs/plugins/<id>.md`
with the standard sections (`## Inputs`, `## Outputs`, `## Gotchas`,
`## Typical position`). Missing docs degrade gracefully — the tab shows a
"no narrative bundled" hint — but the index in `docs/plugins/README.md`
should be updated for human discoverability.

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
- `opensearch_input` (datasource)
- `opensearch_output` (sink)
- `opensearch_bm25_retriever` (retriever)
- `opensearch_vector_retriever` (retriever)
- `opensearch_hybrid_retriever` (retriever)

Together with the `sample_uppercase_transformer` (transformer) plugin from
`plugins/sample-text`, every palette category has at least one built-in,
schema-bearing plugin so the visual builder always renders a real form.

`vector_upsert` and `qdrant_retriever` use the shared `VectorStore` (in-memory
singleton offline, Qdrant when configured), so an upsert followed by a retrieve
round-trips in-process and in tests.

The `opensearch_*` family adds lexical (BM25), vector (kNN), and hybrid
retrieval over OpenSearch plus index input/output sinks. See
[opensearch-plugins.md](./opensearch-plugins.md) for configuration, the hybrid
fusion strategies, and the local `make` stack.

## External / Python plugins

A plugin can run out-of-process behind an HTTP endpoint
(`RegisteredPlugin.mode: "external"`). This is how the Python-only crawlers
(`crawl4ai_crawler`, `scrapy_spider`) ship: a separate FastAPI sidecar
(`services/python-plugins/`) so a headless Chromium and Scrapy's Twisted
reactor never enter the Node worker. See ADR 0010.

### Wire contract v1

`@ragdoll/plugin-sdk` (`executeRegisteredPlugin` → `executeExternalHttp`)
speaks this contract. The exact request body is built by
`buildExternalRequestBody`:

- `GET {baseUrl}{healthPath ?? "/healthz"}` → `200 { ok: true, plugins:
  string[] }`. Probed by `externalPluginHealth` (never throws).
- `POST {baseUrl}{executePath ?? "/execute"}` with JSON:

  ```json
  {
    "plugin":  { "category": "...", "id": "...", "version": "..." },
    "node":    { "id": "...", "config": {}, "secrets": {} },
    "inputs":  {},
    "config":  {},
    "secrets": {},
    "context": {
      "requestId": "...", "executionId": "...", "tenantId": "...",
      "pipelineId": "...", "pipelineVersionId": "...", "environment": "...",
      "deadline": "ISO-8601 or null",
      "resolvedConfig": { "values": { "<key>": { "value": "<any>" } } }
    }
  }
  ```

  The context is deliberately reduced: the `AbortSignal` and functions are
  stripped, `deadline` is an ISO string or `null`, and `resolvedConfig`
  carries only `{ values: { key: { value } } }` — no sensitivity/secret
  metadata leaves the control plane.

- **Success** → `200 { "outputs": {...}, "metadata"?: {...}, "usage"?:
  {...}, "artifacts"?: [...] }` (optional keys included only when present).
- **Expected failure** → `200 { "error": "<message>" }` (unknown plugin,
  SSRF-blocked, bad config, malformed body).
- **Unexpected failure** → any non-2xx (the service uses HTTP 500).

The TS client treats a 200 `{error}` **or** any non-2xx as a plugin
failure (it throws). Calls use an `AbortController` timeout
(`endpoint.timeoutMs`, default 300000 ms). `endpoint.mode: "grpc"` is
**not implemented** and fails fast.

### Adding a Python plugin

In `services/python-plugins/`:

1. Add `app/plugins/<name>_plugin.py` with `PLUGIN_ID = "<id>"` and a
   `handle(request) -> {"outputs": {...}, "usage"?: {...},
   "metadata"?: {...}}`. Read effective config via
   `request.effective_config()` (merges `node.config` <
   `context.resolvedConfig.values` < top-level `config`, last wins).
2. Validate every target URL through `app.safety.SafetyPolicy` before
   fetching; raise `ValueError`/`SSRFError` for expected failures (the
   dispatcher maps `ValueError` → `200 {error}`, anything else → 500).
3. Register it in the `HANDLERS` dispatch map in `app/main.py`.
4. Add a matching `PluginManifest` (with `configSchema`,
   `ui.formHints`, `ui.paletteGroup`) to `packages/plugin-loader`'s
   external manifest list (`registerExternalPlugins`) so it appears in
   the builder palette with a schema-driven form like any plugin.
5. Add a pytest in `tests/` that monkeypatches the network/engine seam
   (`run_crawl4ai` / `run_scrapy` style) and injects a fake DNS resolver
   so the suite stays offline and browser-free.

### Enabling it

The external manifests are registered **only when `PYTHON_PLUGIN_URL` is
set** (e.g. `http://python-plugins:8000`); unset is a no-op so offline
behavior is unchanged. `PYTHON_PLUGIN_TIMEOUT_MS` (default 300000)
overrides the endpoint timeout. Local Compose sets both for the API and
worker, so the crawler nodes show up in the builder automatically.

### SSRF guard / config knobs

`services/python-plugins/app/safety.py` is **default-deny** for a
multi-tenant crawler. Per target URL: scheme must be `http`/`https`; host
must be present; `allowedDomains` allowlist; `sameDomainOnly` against seed
hosts (crawl4ai default `true`; `scrapy_spider` relies on
`allowedDomains`); *every* resolved address is checked and the URL is
blocked if any is private / loopback / link-local / multicast / reserved /
unspecified (incl. IPv4-mapped IPv6) — overridable only with explicit
`allowPrivateNetworks: true`. Crawl caps: `maxPages`, `maxDepth`,
`timeoutMs`. These are the real containment knobs for untrusted targets;
deep link-following relies on the engine plus these caps, not a
per-fetched-URL proxy.

External plugins are still subject to the standard security rules below;
because resolved secret values cross the wire, the sidecar must be
cluster-internal and trusted (ADR 0010, kubernetes-deployment doc).

## Security rules

- Never log raw secrets.
- Mark sensitive outputs so runtime redaction applies.
- Validate untrusted URLs and enforce allow/deny lists for datasource
  connectors.
- Avoid storing tenant credentials in plugin-local state.
