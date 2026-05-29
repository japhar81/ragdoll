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
  additionalProperties?: boolean;
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
    modality: DatasetModality;
    /** Optional. When set, validator + runtime check the bound
     *  dataset's `backends[modality].provider` matches. */
    provider?: string;
  }>;
  configSchema?: JsonSchemaLike;
  secretsSchema?: JsonSchemaLike;
  inputSchema?: JsonSchemaLike;
  outputSchema?: JsonSchemaLike;
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
export interface ResolvedDatasetBackend {
  /** "opensearch" | "qdrant" | "dgraph" | "pgvector" | "postgres" | … */
  provider?: string;
  /** Name of the connection the dataset's backend references. Always
   *  carried through from the raw block so the UI can render the chain. */
  connectionName?: string;
  /** Resolved connection — only set when `connectionName` was on the raw
   *  block AND the cascade resolver found a matching row. */
  connection?: {
    /** Connection name (= connectionName for back-reference). */
    name: string;
    /** Datasource type, e.g. "opensearch". */
    type: string;
    /** Host and port surfaced for convenience; full config lives in
     *  `config` (the raw connection.configRedacted). */
    host?: string;
    port?: number;
    /** Secret reference the plugin uses to fetch credentials via the
     *  existing SecretProvider. Plugins never see plaintext here. */
    secretRefId?: string | null;
    config: Record<string, unknown>;
    /** Diagnostic — `env_specific` when an env override was applied,
     *  `tenant_fallback` when the env=null tenant-wide row was used. */
    cascadeReason: "env_specific" | "tenant_fallback";
  };
  /** Any other modality-specific fields from the raw block (collection,
   *  index, table name, etc.) come through unchanged. */
  [key: string]: unknown;
}

export interface ResolvedDataset {
  id: string;
  slug: string;
  scope: "global" | "tenant" | "environment";
  tenantId?: string;
  environmentId?: string;
  modalities: string[];
  embeddingProfile: Record<string, unknown>;
  chunkSchema: Record<string, unknown>;
  /** Resolved version metadata (id, label, status, doc_count, …). */
  version: {
    id: string;
    versionLabel: string;
    status: "building" | "ready" | "archived";
  };
  /** Backend collection / index names per modality, as recorded on the
   *  resolved version. e.g. `{ vector: "rag_acme_kb_v3" }`. Plugins that
   *  use `pickBackendName()` keep reading this for the collection name. */
  backendCollections: Record<string, string>;
  /** Per-modality resolved backend blocks (PR2). Each block carries the
   *  provider + any backend-specific fields, plus an optional resolved
   *  `connection` (host/port/creds) when the dataset's backend pointed at
   *  a connection name. v2+ plugins read `connection.host` / `secretRefId`
   *  from here instead of taking them as their own `config.url` etc. */
  backends: Record<string, ResolvedDatasetBackend>;
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
  mode: "http" | "grpc";
  baseUrl: string;
  healthPath?: string;
  executePath?: string;
  timeoutMs?: number;
}

export interface RegisteredPlugin {
  manifest: PluginManifest;
  mode: "in_process" | "external";
  implementation?: InProcessPlugin;
  external?: ExternalPluginEndpoint;
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

/** Default execute/health timeout. Crawls are slow, so this is generous. */
const DEFAULT_EXTERNAL_TIMEOUT_MS = 300000;

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * Reduces a {@link RuntimeContext} to a JSON-safe wire object for an external
 * plugin. Strips the AbortSignal and any functions, turns the `deadline` Date
 * into an ISO string (or `null`), and collapses the resolved config down to
 * `{ values: { key: { value } } }` so secret/sensitivity metadata never leaves
 * the control plane.
 */
function toWireContext(context: PluginExecutionInput["context"]): Record<string, unknown> {
  const values: Record<string, { value: unknown }> = {};
  const resolved = context.resolvedConfig?.values ?? {};
  for (const [key, entry] of Object.entries(resolved)) {
    values[key] = { value: entry?.value };
  }
  let deadline: string | null = null;
  if (context.deadline instanceof Date && !Number.isNaN(context.deadline.getTime())) {
    deadline = context.deadline.toISOString();
  }
  return {
    requestId: context.requestId,
    executionId: context.executionId,
    tenantId: context.tenantId,
    pipelineId: context.pipelineId,
    pipelineVersionId: context.pipelineVersionId,
    environment: context.environment,
    deadline,
    resolvedConfig: { values }
  };
}

/**
 * Builds the exact JSON-safe request body for the external plugin HTTP
 * contract v1. Kept as a standalone function so tests can assert the wire
 * shape and the Python server can be validated against the same structure.
 */
export function buildExternalRequestBody(
  plugin: RegisteredPlugin,
  input: PluginExecutionInput
): Record<string, unknown> {
  return {
    plugin: {
      category: plugin.manifest.category,
      id: plugin.manifest.id,
      version: plugin.manifest.version
    },
    node: {
      id: input.node.id,
      config: input.node.config ?? {},
      secrets: input.node.secrets ?? {}
    },
    inputs: input.inputs,
    config: input.config,
    secrets: input.secrets,
    context: toWireContext(input.context)
  };
}

/**
 * Calls the external plugin health endpoint
 * (`GET {baseUrl}{healthPath ?? "/healthz"}`). Resolves (never rejects) so
 * callers can probe liveness without try/catch; on any transport/parse error
 * it returns `{ ok: false, message }`.
 */
export async function externalPluginHealth(
  endpoint: ExternalPluginEndpoint
): Promise<{ ok: boolean; plugins?: string[]; message?: string }> {
  if (endpoint.mode === "grpc") {
    return { ok: false, message: "grpc external transport not implemented" };
  }
  const url = joinUrl(endpoint.baseUrl, endpoint.healthPath ?? "/healthz");
  const timeoutMs = endpoint.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    if (!response.ok) {
      return { ok: false, message: `health check failed with HTTP ${response.status}` };
    }
    const body = (await response.json()) as { ok?: unknown; plugins?: unknown };
    const plugins = Array.isArray(body.plugins)
      ? body.plugins.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    return { ok: body.ok === true, plugins };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function executeExternalHttp(
  plugin: RegisteredPlugin,
  endpoint: ExternalPluginEndpoint,
  input: PluginExecutionInput
): Promise<PluginExecutionOutput> {
  const url = joinUrl(endpoint.baseUrl, endpoint.executePath ?? "/execute");
  const timeoutMs = endpoint.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS;
  const body = JSON.stringify(buildExternalRequestBody(plugin, input));
  // Retry transient connection failures (typical when the python-plugins
  // container is restarting at the same minute a schedule fires). Three
  // attempts with 250ms / 750ms / 2250ms backoff keeps the total ceiling
  // under a 5s budget. Timeouts are NOT retried — those usually mean the
  // plugin is genuinely hung, not flaky.
  const attempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal
      });
      clearTimeout(timer);
      return await handleExternalResponse(response);
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new Error(`External plugin request timed out after ${timeoutMs}ms`);
      }
      lastError = error;
      if (attempt < attempts) {
        // Exponential-ish backoff; jitter unnecessary at this small N.
        const delay = 250 * Math.pow(3, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
    }
  }
  throw new Error(
    `External plugin request failed after ${attempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

async function handleExternalResponse(
  response: Response
): Promise<PluginExecutionOutput> {
  let parsed: unknown;
  let rawText = "";
  try {
    rawText = await response.text();
    parsed = rawText.length > 0 ? JSON.parse(rawText) : undefined;
  } catch {
    parsed = undefined;
  }
  const body = (parsed ?? {}) as {
    error?: unknown;
    outputs?: unknown;
    metadata?: unknown;
    usage?: unknown;
    artifacts?: unknown;
  };

  if (typeof body.error === "string") {
    throw new Error(body.error);
  }
  if (!response.ok) {
    const detail = rawText.trim().length > 0 ? `: ${rawText.trim()}` : "";
    throw new Error(`External plugin returned HTTP ${response.status}${detail}`);
  }

  const result: PluginExecutionOutput = {
    outputs:
      body.outputs && typeof body.outputs === "object"
        ? (body.outputs as Record<string, unknown>)
        : {}
  };
  if (body.metadata && typeof body.metadata === "object") {
    result.metadata = body.metadata as Record<string, unknown>;
  }
  if (body.usage && typeof body.usage === "object") {
    result.usage = body.usage as PluginExecutionOutput["usage"];
  }
  if (Array.isArray(body.artifacts)) {
    result.artifacts = body.artifacts as PluginExecutionOutput["artifacts"];
  }
  return result;
}

export async function executeRegisteredPlugin(
  plugin: RegisteredPlugin,
  input: PluginExecutionInput
): Promise<PluginExecutionOutput> {
  if (plugin.mode === "in_process" && plugin.implementation) {
    return plugin.implementation.execute(input);
  }
  if (plugin.mode === "external" && plugin.external) {
    if (plugin.external.mode === "grpc") {
      throw new Error("grpc external transport not implemented");
    }
    return executeExternalHttp(plugin, plugin.external, input);
  }
  throw new Error("External plugin execution is scaffolded; deploy plugin gateway before enabling external plugins");
}
