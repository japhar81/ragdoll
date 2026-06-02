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

A plugin can run out-of-process behind a network endpoint
(`RegisteredPlugin.mode: "external"`). This is how the Python-only crawlers
(`crawl4ai_crawler`, `scrapy_spider`) ship: a separate sidecar
(`services/python-plugins/`) so a headless Chromium and Scrapy's Twisted
reactor never enter the Node worker.

The transport is **connect-rpc** (ADR
[0022](../adr/0022-connect-rpc-plugin-transport.md)) — one `.proto` defines
the wire, one server handler answers Connect HTTP/JSON + native gRPC +
gRPC-Web simultaneously. The runtime picks the protocol on a per-call
basis; the server is wire-agnostic. ADR 0010 covers the original
out-of-process motivation (sandboxing untrusted Chromium / Twisted away
from the worker); ADR 0022 covers the wire migration.

> For step-by-step author walkthroughs, see
> **[plugin-author-quickstart.md](./plugin-author-quickstart.md)** —
> sections 1-8 cover the Node `@ragdoll/plugin-sdk/author` SDK and
> sections 9-14 cover the Python `ragdoll-plugin-py` SDK. The reference
> below is the lower-level contract a SDK consumer doesn't normally need.

### Wire contract (PluginRuntime service)

The contract lives at `proto/plugin.proto`. One service, five methods:

```protobuf
service PluginRuntime {
  rpc Health(HealthRequest) returns (HealthResponse);
  rpc Execute(ExecuteRequest) returns (ExecuteResponse);
  rpc ExecuteServerStream(ExecuteRequest) returns (stream ExecuteChunk);
  rpc ExecuteClientStream(stream ExecuteRequest) returns (ExecuteResponse);
  rpc ExecuteBidi(stream ExecuteRequest) returns (stream ExecuteChunk);
}
```

- `ExecuteRequest` carries `plugin` (id) + `version` + `node_id` + tenant /
  environment / request_id + four `google.protobuf.Struct` fields
  (`config`, `inputs`, `dataset`, `secrets`) for the dynamic payload +
  `deadline_ms` (int64, ms-from-now; `0` = none). `Struct` round-trips
  natively to JSON objects in both Node (`JsonObject`) and Python
  (`MessageToDict`) so there's no protobuf wrapper class to wrangle.
- `ExecuteResponse` carries `outputs` + optional `metadata`, `usage`,
  `artifacts` — same shape the old contract v1 wrapped in JSON.
- `ExecuteChunk` is a `oneof payload { string token; Struct delta;
  ExecuteResponse final; }` envelope for streaming. The plugin yields
  zero or more `token`/`delta` chunks then a `final` envelope; the
  runtime synthesises the envelope from accumulated deltas if `final`
  is omitted.

`@ragdoll/plugin-sdk/transport` is the Node-side adapter
(`executeRegisteredPlugin` / `executeExternalConnectStream` /
`externalPluginHealth`). `ExternalPluginEndpoint` reshape:

```ts
interface ExternalPluginEndpoint {
  baseUrl: string;
  // Default "connect" (HTTP/JSON over HTTP/1.1) — works through every
  // proxy/WAF, debuggable with curl. Bump to "grpc" + httpVersion: "2"
  // for backpressure-heavy streaming.
  protocol?: "connect" | "grpc" | "grpc-web";
  httpVersion?: "1.1" | "2";  // default "1.1"; required "2" for grpc
  timeoutMs?: number;
}
```

There is no `mode: "http" | "grpc"` enum any more — the server speaks all
three protocols from one handler; `protocol` on the endpoint is a per-call
client preference. The runtime retries unary calls three times with
250/750/2250ms backoff (timeouts are NOT retried). Streaming calls are NOT
retried — partial output is irrecoverable.

### Legacy contract v1 (deprecated, still served during cutover)

The bundled `services/python-plugins` sidecar dual-hosts both transports
on the same Hypercorn listener:

- `/healthz` + `/execute` → legacy FastAPI HTTP contract v1 (kept for
  rollback; will be removed in a follow-up)
- `/ragdoll.plugin.v1.PluginRuntime/*` → Connect

Both paths delegate to the same `HANDLERS` dict so the three Python
plugins are wire-agnostic. The legacy contract is documented in earlier
revisions of this file; new plugins should target the PluginRuntime
proto exclusively.

### Adding a Python plugin

The fastest path is the SDK walkthrough at
[plugin-author-quickstart.md sections 9-14](./plugin-author-quickstart.md).
Three things matter for an in-tree contribution to the bundled sidecar:

1. **Plugin source.** Add `app/plugins/<name>_plugin.py` with
   `PLUGIN_ID = "<id>"` and a `handle(request) -> {"outputs": {...},
   "usage"?: {...}, "metadata"?: {...}}`. The handler still takes the
   legacy pydantic `ExecuteRequest` — the Connect bridge in
   `app/connect_bridge.py` translates from the proto shape on the way in
   so handlers don't need to change. Read effective config via
   `request.effective_config()` (merges `node.config` <
   `context.resolvedConfig.values` < top-level `config`, last wins).
2. **SSRF safety.** Validate every target URL through
   `app.safety.SafetyPolicy` before fetching; raise `ValueError` /
   `SSRFError` for expected failures (the dispatcher maps `ValueError`
   to `ConnectError(INVALID_ARGUMENT)` on the Connect path and `200
   {error}` on the legacy path).
3. **Register** the plugin in the `HANDLERS` dispatch map in
   `app/main.py`, and add a matching `PluginManifest` (with
   `configSchema`, `ui.formHints`, `ui.paletteGroup`) to
   `packages/plugin-loader`'s external manifest list
   (`registerExternalPlugins`) so the runtime knows the plugin exists
   and the builder palette can show it.

Add a pytest in `services/python-plugins/tests/` that monkeypatches the
network/engine seam (`run_crawl4ai` / `run_scrapy` style) and injects a
fake DNS resolver so the suite stays offline and browser-free. For
cross-language verification of the Connect path,
`tests/e2e/cross-language-plugin.e2e.test.ts` exercises the full Node
runtime → Python sidecar round-trip; skips gracefully when the sidecar
isn't reachable.

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

## External-resource plugin pattern

Plugins that talk to a tenant-owned external system (a Postgres database,
a customer's HTTP API, an S3 bucket they provisioned) follow a specific
shape so they're safe by construction. The `postgres_*` family is the
reference implementation; see [ADR 0020](../adr/0020-external-database-plugins.md)
for the full architectural rationale.

### Pooled-core sibling module

Multi-node families (e.g. `postgres_query` + `postgres_upsert` +
`postgres_exec`) share connection state via a **sibling core module**
that lives next to the plugin files:

```
plugins/builtin-rag/src/
  postgres-core.ts            # shared pool cache + identifier validator
  plugins/postgres.ts         # the three plugin exports
```

The core module:

- Holds a module-scoped `Map<resourceKey, ResourceEntry>` cache, built
  lazily on first use.
- Keys by a **hash of the resolved secret value**, not by the operator-
  facing label. Two nodes pointing at the same DSN share one pool;
  identical labels resolving to different DSNs (e.g. dev vs prod) stay
  isolated.
- Installs once-per-process shutdown hooks
  (`SIGTERM` / `SIGINT` / `beforeExit`) that flush every cached entry.
- Exports a test seam (`__setPoolFactory` or equivalent) so the plugin's
  unit tests can substitute a fake driver without pulling in the real
  client library.
- Stays import-safe in offline environments. The real driver is loaded
  via dynamic `import("…")` (see `packages/db/src/pool.ts` for the
  precedent), not a top-level import.

### Secret-ref for the connection

Connections are NEVER inline in plugin config. The plugin declares a
`secretsSchema` with a `secret-ref` field for the credential (DSN, API
key, OAuth token), and `config` carries only the operator-facing label:

```ts
secretsSchema: {
  type: "object",
  required: ["dsn"],
  properties: {
    dsn: { type: "string", format: "secret-ref", description: "…" }
  }
}
```

This makes the same pipeline portable across environments: the operator
swaps the resolved secret per env (`tenant`, `tenant_provider`,
`environment` — see ADR 0003), not the spec.

### Identifier validation, not interpolation

If the plugin builds SQL or path strings that include operator-supplied
identifiers (table names, column names, bucket names), validate them
against a strict regex and quote them before splicing. NEVER accept the
identifier verbatim. `postgres-core.quoteIdentifier` is the reference:
it allows `[A-Za-z_][A-Za-z0-9_$]{0,62}` and rejects quoted
identifiers, then double-quotes the validated value.

Runtime values from upstream nodes flow ONLY through bound parameters
(`$1`, `$2`, …) — there's no path by which `inputs.params` reaches the
SQL string itself. This is the property that makes the family
injection-proof by construction.

### Read-only by default

Retrieval-shaped plugins should open a read-only transaction (or the
external system's equivalent) before running the operator's SQL. This
is the authoritative defence — a pre-flight statement-keyword check is
helpful for clearer errors, but the txn / equivalent is what we trust.

### Dangerous capabilities are loud

DDL / migration / destructive-action plugins should:

- Declare `capabilities: ["dangerous", …]` in the manifest.
- Hard-gate execution on a literal `true` config flag (e.g.
  `config.allowDDL === true`), not a truthy value. A templating bug
  that produces `"true"` (string) shouldn't enable the gate.
- Document that they're not appropriate inside MCP-exposed or
  synchronous pipelines. MCP exposure is per-pipeline today (see
  [`docs/admin/mcp.md`](../admin/mcp.md)); a future
  [external-connections registry](../adr/0021-external-connections-registry.md)
  could make this enforceable at the contract layer.

## Security rules

- Never log raw secrets.
- Mark sensitive outputs so runtime redaction applies.
- Validate untrusted URLs and enforce allow/deny lists for datasource
  connectors.
- Avoid storing tenant credentials in plugin-local state.
