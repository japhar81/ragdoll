import type {
  ConfigDefinition,
  PipelineSpec,
  PluginCategory,
  PluginRef,
  RuntimeContext,
  SecretRef
} from "../../core/src/index.ts";

/**
 * Dependency-free JSON-Schema subset used to describe a plugin's `config` and
 * `secrets` shapes. It is intentionally minimal so the web UI can render a real
 * form (inputs, selects, ranges, secret pickers) instead of a raw JSON
 * textarea. No JSON-Schema library is pulled in; the shape below is all the
 * control plane and UI agree on.
 *
 * - `enum`    constrains a string/number field to a fixed set of choices.
 * - `default` seeds the form control with the value the plugin itself defaults
 *             to at runtime.
 * - `format`  is a semantic hint. The well-known value `"secret-ref"` marks a
 *             field that holds a reference to a managed secret (never a raw
 *             value); the UI renders a secret picker and the value never leaves
 *             the server.
 */
export interface JsonSchemaLike {
  type?: string;
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  items?: JsonSchemaLike;
  additionalProperties?: boolean | JsonSchemaLike;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  format?: string;
}

/**
 * Named input or output port on a plugin. Declared ports let edges target a
 * specific slot (`fromPort` / `toPort`) instead of dumping every upstream
 * output into the downstream `inputs` bag. A plugin that declares ports also
 * gets independently-wireable outputs in the builder — wire `if_then.then` and
 * `if_then.else` to different downstream nodes; runtime treats an
 * undefined-on-emit port as a dead branch and skips its descendants. Plugins
 * with no declared ports keep the legacy "merge everything" wiring.
 */
export interface PortDef {
  /** Port name, e.g. "documents", "then", "else". Must be unique per side. */
  name: string;
  /** Human-readable description shown in the builder. */
  description?: string;
  /** When true, the runtime considers the port mandatory: a node will be
   *  skipped if a required input port has no live upstream value. */
  required?: boolean;
  /** Optional JSON-Schema-like shape describing the payload on this port. */
  schema?: JsonSchemaLike;
}

/**
 * Plugin contract version (Phase 5 of dataset/RBAC/retrieval refactor).
 *
 * `1` (the default when `manifest.contract` is omitted) is the legacy
 * shape every existing plugin still uses: storage-touching plugins name
 * their Qdrant collection / OpenSearch index directly in
 * `node.config.collection` / `node.config.index`.
 *
 * `2` plugins receive a {@link ResolvedDataset} on the execution input
 * and call methods on it instead of naming a collection. The runtime
 * resolves the dataset reference (slug + alias) into a physical backend
 * choice, so pipelines decouple from raw collection names. A v1
 * compatibility shim flips dataset references back into raw
 * `config.collection` / `config.index` for legacy plugins so existing
 * pipelines keep working unchanged through the migration.
 */
export type PluginContractVersion = 1 | 2;

/**
 * Which backend slot a plugin reads / writes inside a ResolvedDataset.
 * Drives the Builder picker's "compatible slugs" filter and the validator's
 * `dataset_modality_mismatch` check.
 *
 * - "vector" — dense vector index (qdrant, pgvector, weaviate, …)
 * - "text"   — lexical / BM25 index (opensearch, elasticsearch, …)
 * - "graph"  — graph store (future)
 * - "image"  — image embedding index (future)
 *
 * Leave undeclared on plugins that don't bind a backend slot (chunkers,
 * embedders, prompt templates, …); the picker / validator skip the check.
 */
export type DatasetModality = "vector" | "text" | "graph" | "image";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  category: PluginCategory;
  description: string;
  /** Defaults to 1 (legacy) when omitted. See {@link PluginContractVersion}. */
  contract?: PluginContractVersion;
  /**
   * Backend slots this plugin requires inside the bound dataset. The Builder
   * hides slugs whose datasets don't include ALL of these modalities, and
   * the validator emits `dataset_modality_mismatch` when a bound slug lacks
   * any of them. Hybrid retrievers (e.g. opensearch_hybrid_retriever) list
   * both `["vector", "text"]`; vector-only plugins list `["vector"]`. Leave
   * undeclared on plugins that pick their modality from config at runtime
   * (e.g. dataset_search) — those skip the gate.
   *
   * @deprecated Prefer {@link requires} which also enforces backend provider.
   * `datasetModalities` is kept for v1 plugins that haven't moved over.
   */
  datasetModalities?: DatasetModality[];
  /**
   * Stronger version of `datasetModalities`: declares the modality slot(s)
   * the plugin uses AND optionally the backend provider it expects. The
   * spec validator enforces:
   *   - bound dataset declares each required modality (same as
   *     `datasetModalities`), AND
   *   - when `provider` is set, `dataset.backends[modality].provider`
   *     matches.
   *
   * Plugins that declare `requires` MUST NOT expose host / port / URL
   * fields in their `configSchema` — the dataset's resolved connection
   * is the single source of truth for where to connect. The runtime
   * hard-fails any node whose dataset doesn't resolve a connection for
   * a required modality. Per-plugin behavioural knobs (batch sizes,
   * retry counts, top-k) still live in `configSchema`.
   *
   * Multi-modal plugins (e.g. opensearch_hybrid_retriever) list each
   * required slot — the validator enforces ALL of them.
   *
   * Multi-connection-per-dataset (R/W split, multi-region failover)
   * is intentionally deferred to v2: today one `(dataset, modality)`
   * resolves to exactly one connection. Document the chosen role
   * convention (e.g. always-write, always-read) if it matters for a
   * specific plugin family.
   */
  requires?: Array<{
    /**
     * ADR-0023 (new shape). The dataset binding name this plugin needs
     * filled (e.g. "vectors" for a vector retriever, "graph" for a
     * neo4j query plugin). The binding name vocabulary is free text
     * chosen jointly by the plugin author and the dataset author —
     * the picker UI matches plugins to bindings by NAME, and to
     * connection rows by `kind` / `kindOneOf` below.
     *
     * Tool-only plugins (mongo_find, clickhouse_query) that take an
     * `input.connection` directly without going through a Dataset
     * omit `binding` and supply only `kind`/`kindOneOf`.
     */
    binding?: string;
    /** ADR-0023. Acceptable connection kind. Single string is sugar for
     *  a 1-element kindOneOf. */
    kind?: string;
    kindOneOf?: string[];
    /**
     * Legacy ADR-0019 shape — preserved so plugins authored against the
     * modality+provider contract keep working. The runtime translates
     * `{modality, provider}` to `{binding: modality, kind: provider}`
     * at validation time, so new plugins should prefer the binding
     * shape above. Both shapes coexist for one release.
     */
    modality?: DatasetModality;
    provider?: string;
  }>;
  configSchema?: JsonSchemaLike;
  secretsSchema?: JsonSchemaLike;
  inputSchema?: JsonSchemaLike;
  outputSchema?: JsonSchemaLike;
  /**
   * Plugin can produce its result as a server-side stream (token-by-token for
   * LLMs, chunk-by-chunk for crawlers/transcripts) in addition to the unary
   * shape. When `true` AND the caller provides an `onToken` sink, the runtime
   * routes through the `ExecuteServerStream` RPC instead of unary `Execute`
   * — same handler, the plugin is free to yield as work progresses. Plugins
   * that only return a complete envelope leave this undeclared.
   */
  streaming?: boolean;
  /** Named input ports (declared contract). Undeclared plugins keep
   *  legacy merge wiring; declared plugins receive `inputs[portName]`. */
  inputPorts?: PortDef[];
  /** Named output ports (declared contract). The plugin's `outputs` map keys
   *  should match these names; an absent key on a declared port marks that
   *  branch dead so downstream nodes wired to it are skipped. */
  outputPorts?: PortDef[];
  /**
   * Marks a plugin whose ports are NOT fixed — each node instance defines its
   * own ports through its `config`. The builder reads port names from the
   * node's config instead of the static `inputPorts` / `outputPorts`:
   *   - `inputsFrom`  names a config key holding a `string[]` of input port
   *                   names.
   *   - `outputsFrom` names a config key holding an object whose keys are the
   *                   output port names.
   * A dynamic-port plugin should leave `inputPorts` / `outputPorts` undeclared
   * so `validatePipelineSpec` does not warn about the author-named ports. Used
   * by `transform`. The runtime is unaffected — it routes edges by name
   * regardless of whether the port was statically declared.
   */
  dynamicPorts?: {
    inputsFrom?: string;
    outputsFrom?: string;
  };
  configDefinitions?: ConfigDefinition[];
  capabilities?: string[];
  ui?: {
    icon?: string;
    color?: string;
    /**
     * Per-field rendering hints keyed by config/secret property name. Values
     * are opaque to the control plane and consumed by the UI form renderer,
     * e.g. `{ temperature: { widget: "range", min: 0, max: 2, step: 0.1 },
     * apiKey: { widget: "secret" } }`.
     */
    formHints?: Record<string, unknown>;
    paletteGroup?: string;
    /**
     * Tier-2 custom editor seam (type + contract only; no host implementation
     * lives in this package). When set, this is an ESM module URL the web app
     * may dynamically import to render a bespoke config editor for this plugin
     * instead of the schema-driven form.
     *
     * Contract the module MUST satisfy:
     *
     *   The module either default-exports OR exports a named `ConfigEditor`
     *   that is a React component with the signature:
     *
     *     (props: {
     *       value: Record<string, unknown>;
     *       schema?: JsonSchemaLike;
     *       onChange: (next: Record<string, unknown>) => void;
     *     }) => ReactNode
     *
     *   - `value`    is the current (non-secret) config object.
     *   - `schema`   is the plugin's `configSchema` (if any) for reference.
     *   - `onChange` MUST be called with the full next config object on edit;
     *     the host treats config as a controlled value.
     *
     * Secret values are NEVER passed to or returned from a custom editor; the
     * editor may only emit secret *references*. Custom editors are untrusted
     * code: hosts SHOULD load them admin-only/registered and sandboxed. See
     * ADR 0008.
     */
    module?: string;
  };
}

/**
 * How a v2 plugin (or a v1 plugin under the shim) addresses storage.
 * Pipelines write `{ slug, alias? }` into a node's spec and the runtime
 * resolves it at execution time — sliding through env → tenant → global
 * exactly the way scoped grants work. The `alias` selects which version
 * of the dataset to act against; omitting it pins to `stable`.
 */
export interface DatasetRef {
  slug: string;
  /** Defaults to "stable" when omitted; pipelines pin to "staging" /
   *  "canary" for canary rollouts. */
  alias?: string;
}

/**
 * What a v2 plugin actually receives. The runtime has resolved the
 * `DatasetRef` to a concrete dataset row + version, and threads enough
 * context onto the object that the plugin can talk to whichever
 * backend (Qdrant / OpenSearch / pgvector) holds the data without
 * caring about the physical collection name.
 *
 * v1 plugins see neither the ref nor this object; instead, the shim
 * synthesises `config.collection` / `config.index` from the resolved
 * `backendCollections` so the plugin's existing read/write code path
 * keeps working unchanged.
 */
/**
 * Per-modality backend block on a resolved dataset. The shape mirrors the
 * raw `datasets.backends.<modality>` JSONB (so `provider`, `index`,
 * `collection`, etc. flow through), with one synthetic addition: when the
 * raw block carries `connectionName`, the resolver looks up the matching
 * connection for the current (tenant, env), and stamps the host / port /
 * creds onto `connection` here. Plugins read everything they need to
 * reach the backing store from this block — they never see the raw
 * hostname or secret in their own `config`.
 */
/**
 * How the dataset's collection / index / predicate name is namespaced
 * across tenants and environments at resolve-time. See
 * `applyNamespacePolicy` in @ragdoll/runtime for the suffix rules,
 * and `validateNamespacePolicyForScope` for the scope/policy matrix.
 *
 * - `shared`        — base name verbatim. Every (tenant, env) accessing
 *                     this dataset writes/reads the same collection.
 *                     Default for legacy rows; meaningful for org-wide
 *                     reference data, dangerous for tenant data.
 * - `by-tenant`     — `<base>_<tenantSlug>`. Only valid on global-scope
 *                     datasets. Each tenant gets its own collection.
 * - `by-tenant-env` — `<base>_<tenantSlug>_<envName>`. Only valid on
 *                     global-scope datasets. Per-(tenant, env) split.
 * - `by-env`        — `<base>_<envName>`. Only valid on tenant-scope
 *                     datasets — each env in the tenant gets its own
 *                     collection (tenant is already implicit in the row).
 */
export type DatasetNamespacePolicy =
  | "shared"
  | "by-tenant"
  | "by-tenant-env"
  | "by-env";

/**
 * ADR-0023 resolved dataset binding. The runtime hands one of these to
 * the plugin for every entry in `dataset.bindings`. Plugins declaring
 * `requires: [{binding, kind|kindOneOf}]` read
 * `input.dataset.bindings[<name>]` to pick up the resolved connection
 * + effective collection.
 *
 * The slug + kind + host/port fields are duplicated outside the nested
 * `connection` object so plugins that only need the URL don't have to
 * crack open the full connection envelope — useful for hot paths and
 * for plugins authored before the unified ResolvedExternalConnection
 * shape was finalised.
 */
export interface ResolvedDatasetBinding {
  /** Operator-facing connection slug from the dataset's bindings block. */
  connectionSlug?: string;
  /** Connection `kind` ("qdrant" | "opensearch" | "dgraph" | …). Lifted
   *  out of `connection` so plugins can branch on backend type without
   *  reading the full envelope. */
  connectionKind?: string;
  /** Hostname from the resolved connection's config. Convenience field. */
  connectionHost?: string;
  /** Port from the resolved connection's config. Convenience field. */
  connectionPort?: number;
  /** Effective collection / index / table / predicate name the plugin
   *  should read or write. The resolver has ALREADY applied any
   *  namespace policy from the binding — plugins should not re-derive
   *  the suffix. Falls back to the dataset version's
   *  `backendCollections[<bindingName>]` when the binding doesn't
   *  override. */
  collection?: string;
  /** Namespace policy declared on the binding. Diagnostic / UI only —
   *  the resolver has already expanded it onto `collection`. */
  namespace?: DatasetNamespacePolicy;
  /** Diagnostic — how the binding's connection was resolved through
   *  the unified registry cascade. */
  cascadeReason?: "global" | "tenant" | "environment";
  /** Resolved external connection (slug → registry row → SecretProvider).
   *  Carries kind + secret + per-kind options. Same shape as
   *  ResolvedExternalConnection delivered via `input.connection`. */
  connection?: ResolvedExternalConnection;
}

export interface ResolvedDataset {
  id: string;
  slug: string;
  scope: "global" | "tenant" | "environment";
  tenantId?: string;
  environmentId?: string;
  embeddingProfile: Record<string, unknown>;
  chunkSchema: Record<string, unknown>;
  /** Resolved version metadata (id, label, status, doc_count, …). */
  version: {
    id: string;
    versionLabel: string;
    status: "building" | "ready" | "archived";
  };
  /**
   * ADR-0023: the ONLY way to address storage. Plugins authored against
   * the old `dataset.backends.<modality>` shape have been migrated to
   * read `dataset.bindings.<name>` — the modality concept is gone from
   * the dataset surface entirely.
   *
   * Binding name vocabulary is free-text — plugin authors and dataset
   * authors agree on slot names (common ones: "vectors", "text",
   * "graph", "rows", "ingress"). The connection kind determines what
   * the underlying backend is; the binding name is the slot a plugin
   * requests.
   */
  bindings: Record<string, ResolvedDatasetBinding>;
}

/**
 * ADR-0021: Resolved external connection delivered to v2 plugins.
 *
 * Mirrors the structural shape in `@ragdoll/external-connections` so
 * plugin authors don't need an inter-package import. The runtime
 * assembles this from the connections registry + SecretProvider before
 * calling the plugin.
 *
 * `secret` is the resolved credential payload — typically a DSN /
 * connection URI / API key. Drivers parse it according to their kind
 * (MongoDB expects a `mongodb://` URI; ClickHouse expects a password
 * with host+port in `options`, etc).
 */
export interface ResolvedExternalConnection {
  id: string;
  slug: string;
  kind: string;
  secret?: string;
  options: Record<string, unknown>;
  cascadeReason: "global" | "tenant" | "environment";
}

/**
 * Resolves {@link DatasetRef} against the running context's
 * (tenantId, environment) — walking env → tenant → global, first match
 * wins. Returns `undefined` when no dataset matches (the runtime then
 * falls back to plugin-config-as-source-of-truth and logs a warning).
 *
 * Lives in plugin-sdk (not runtime) because plugin authors need the
 * type to describe their inputs; concrete implementations are wired in
 * by the runtime and the API.
 */
export interface DatasetResolver {
  resolve(args: {
    ref: DatasetRef;
    tenantId?: string;
    environmentId?: string;
    /**
     * Pipeline id of the calling execution (PR3). When set, the
     * resolver first checks `pipeline_dataset_bindings` for an
     * override mapping `(pipelineId, tenant, env, sourceSlug=ref.slug)`
     * → a specific dataset row. Falls through to the normal scope
     * cascade when no binding exists. Omitted by callers without a
     * pipeline context (e.g. preview / listing tools).
     */
    pipelineId?: string;
  }): Promise<ResolvedDataset | undefined>;
}

export interface PluginExecutionInput {
  context: RuntimeContext;
  node: {
    id: string;
    plugin: PluginRef;
    config?: Record<string, unknown>;
    secrets?: Record<string, SecretRef>;
    /**
     * Dataset reference declared on the node (Phase 5). v2 plugins
     * receive the resolved object as `input.dataset`; v1 plugins get
     * the resolved collection names spliced into `config.collection`
     * / `config.index` via a shim so they keep working unchanged.
     */
    dataset?: DatasetRef;
  };
  inputs: Record<string, unknown>;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  /**
   * Resolved dataset (Phase 5). Only present when `node.dataset` was
   * set in the spec AND the runtime managed to resolve it. v2 plugins
   * branch on this; v1 plugins ignore it.
   */
  dataset?: ResolvedDataset;
  /**
   * Resolved external connection (ADR-0021). Populated when the node
   * carries `connection: { slug }` AND the runtime found a matching
   * row in the connections registry AND the principal holds
   * `connection:use` at the row's scope. Carries the
   * connection's resolved secret (DSN / URI / API key) so plugins
   * never see the secret-ref machinery.
   */
  connection?: ResolvedExternalConnection;
  /**
   * Nested synchronous pipeline invocation (Phase 9, Round 2). Only
   * populated when the current pipeline is itself running in
   * synchronous mode — batch pipelines can't sub-invoke synchronously
   * because BullMQ jobs aren't awaitable in-process. Cycles are
   * detected by the runtime via a small per-execution call stack
   * (max depth defaults to 8).
   */
  runPipelineByRef?: (args: {
    slug: string;
    input: unknown;
    environment?: string;
  }) => Promise<{ output: Record<string, unknown> }>;
  /**
   * Optional token sink for streaming LLM plugins (Phase 13 follow-up).
   * When the surrounding execution is happening behind /stream and
   * the plugin can produce incremental output, it calls onToken for
   * each token; the SSE route forwards them as `token` frames in
   * real time. Plugins that don't stream ignore this and return the
   * full text in their `outputs` as usual.
   */
  onToken?: (token: string) => void;
  /**
   * Recursively execute a body pipeline spec from inside a plugin. Used by
   * iteration plugins (for/foreach/while) to evaluate their body N times. Only
   * provided to in-process plugins — external plugins must implement their own
   * iteration if they need it. Returns the body's terminal outputs as a plain
   * object (same shape an outer pipeline returns to its caller).
   */
  runSubgraph?: (spec: PipelineSpec, initialInput: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /**
   * Read/write a small per-pipeline state bucket. Used by `delta_filter` to
   * persist the set of previously-ingested documents (with mtime/sha256)
   * across pipeline runs. Auto-scoped to `(tenantId, pipelineId, stateKey)`
   * by the runtime — plugins only pass the `stateKey`.
   */
  ingestStateStore?: IngestStateStore;
}

/** One persisted entry in the per-pipeline ingest state — typically one row
 *  per source document the delta_filter has seen. `sha256` and `mtime` are
 *  both optional so a pipeline can use either (or both) as its delta signal. */
export interface IngestStateEntry {
  docId: string;
  sha256?: string;
  /** ISO-8601 timestamp string. We store as a string so tests don't need a
   *  Date round-trip and the wire shape stays JSON-safe. */
  mtime?: string;
  lastSeen: string;
}

export interface IngestStateStore {
  /** Returns every previously-recorded entry under `stateKey`. */
  list(args: { stateKey: string }): Promise<IngestStateEntry[]>;
  /** Wholesale replacement of `stateKey`'s entries. The plugin computes the
   *  new set in memory (current docs ∩ on-disk) and hands the result here. */
  replaceAll(args: { stateKey: string; entries: IngestStateEntry[] }): Promise<void>;
}

export interface PluginExecutionOutput {
  outputs: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  usage?: {
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    embeddingTokens?: number;
    estimatedCostUsd?: number;
  };
  artifacts?: Array<{ kind: string; uri?: string; data?: unknown; sensitive?: boolean }>;
}

export interface InProcessPlugin {
  manifest: PluginManifest;
  execute(input: PluginExecutionInput): Promise<PluginExecutionOutput>;
  healthCheck?(): Promise<{ ok: boolean; message?: string }>;
}

export interface ExternalPluginEndpoint {
  /** Base URL of the plugin server, e.g. `http://python-plugins:8000`. */
  baseUrl: string;
  /**
   * Wire protocol. All three are served simultaneously by the same connect-rpc
   * server (one handler), so this is a *client preference*, not a server-side
   * choice. Default: `connect` — JSON-over-HTTP, works through every proxy,
   * survives nginx default buffering for unary, curl-debuggable.
   * - `grpc`: native gRPC. Lower per-call overhead, real backpressure, requires
   *   HTTP/2 end-to-end. Pick this when streaming load is high.
   * - `grpc-web`: gRPC framing over HTTP/1.1. Browser-callable but rarely the
   *   right choice server-side.
   */
  protocol?: "connect" | "grpc" | "grpc-web";
  /**
   * HTTP version. Defaults: `2` for `grpc` (required), `1.1` otherwise. Bump to
   * `2` for `connect`/`grpc-web` when full-duplex bidi or multiplexed streaming
   * is needed and the network path supports h2 end-to-end.
   */
  httpVersion?: "1.1" | "2";
  timeoutMs?: number;
}

/**
 * Source provenance — where a registered plugin's code came from.
 *
 * PLUGIN-ARCH-1: every `RegisteredPlugin` records the repo source it
 * was loaded from so the catalog (`/api/plugins`) can show the
 * operator "this plugin came from <repoId> @ <commitSha>." The seam
 * a future trust tier (signing/allowlist/sandbox) attaches to
 * without re-architecting registration. Optional so plugins
 * registered through legacy paths (or in tests that don't care)
 * don't have to carry it.
 *
 * Built-in plugins (the `plugins/*` modules compiled into the
 * worker image) carry `kind: "local"` provenance with the in-tree
 * module path; external repo-loaded plugins carry `kind: "git"`
 * with `gitUrl` + `commitSha`. Both are projected to the API the
 * same way so the UI never has to special-case which is which.
 */
export interface PluginSourceProvenance {
  /** Logical id of the source (the `plugin_sources.id` row, or a
   *  reserved id like `"builtin"` / `"sample-text"` for the
   *  in-tree built-ins). */
  repoId: string;
  /** `local` — the source code lives in the worker image (no git
   *  fetch). `git` — the source was cloned from `gitUrl` at
   *  `commitSha`. */
  kind: "local" | "git";
  /** Git URL when `kind: "git"`; absent for local sources. */
  gitUrl?: string;
  /** Operator-supplied ref (branch/tag/commit) before resolution;
   *  for diagnostics — `commitSha` is the load-bearing field. */
  ref?: string;
  /** Resolved commit sha — populated for `git`, absent for `local`.
   *  Loading paths are content-addressed by this sha so a refresh
   *  for an unchanged sha is a true no-op. */
  commitSha?: string;
  /** Subpath inside the repo / module the loader scanned. Empty
   *  string when not applicable. */
  subpath?: string;
  /** ISO-8601 timestamp of when this source was fetched. */
  loadedAt?: string;
}

export interface RegisteredPlugin {
  manifest: PluginManifest;
  mode: "in_process" | "external";
  implementation?: InProcessPlugin;
  external?: ExternalPluginEndpoint;
  /** PLUGIN-ARCH-1 provenance — where this plugin's code came from.
   *  Optional so legacy callers + tests that don't care still
   *  compile cleanly; the loader populates it for every plugin
   *  it registers. */
  source?: PluginSourceProvenance;
}

export class PluginRegistry {
  private plugins = new Map<string, RegisteredPlugin>();

  register(plugin: RegisteredPlugin): void {
    this.plugins.set(pluginKey(plugin.manifest), plugin);
  }

  get(ref: PluginRef): RegisteredPlugin | undefined {
    return this.plugins.get(pluginKey(ref));
  }

  require(ref: PluginRef): RegisteredPlugin {
    const plugin = this.get(ref);
    if (!plugin) throw new MissingPluginError(ref);
    return plugin;
  }

  list(category?: PluginCategory): RegisteredPlugin[] {
    return [...this.plugins.values()].filter((plugin) => !category || plugin.manifest.category === category);
  }
}

export class MissingPluginError extends Error {
  constructor(ref: PluginRef) {
    super(`Missing plugin ${pluginKey(ref)}`);
    this.name = "MissingPluginError";
  }
}

export function pluginKey(ref: Pick<PluginRef, "category" | "id" | "version">): string {
  return `${ref.category}:${ref.id}:${ref.version}`;
}

// External plugin transport (connect-rpc adapter + executeRegisteredPlugin
// + externalPluginHealth + executeExternalConnectStream) lives in a separate
// subpath so the browser bundle never reaches the connect-rpc / @bufbuild /
// @grpc / @ragdoll/proto-gen import chain through pipeline-spec → plugin-sdk.
// Server-side callers import from "@ragdoll/plugin-sdk/transport".
