export type UUID = string;

export type ConfigScope =
  | "global"
  | "environment"
  | "pipeline"
  | "pipeline_version"
  | "tenant"
  | "tenant_pipeline"
  | "runtime";

export const CONFIG_SCOPE_PRECEDENCE: ConfigScope[] = [
  "global",
  "environment",
  "pipeline",
  "pipeline_version",
  "tenant",
  "tenant_pipeline",
  "runtime"
];

export type ConfigValueType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "secret_ref";

export interface ConfigDefinition {
  key: string;
  type: ConfigValueType;
  defaultValue?: unknown;
  allowedScopes: ConfigScope[];
  required?: boolean;
  secret?: boolean;
  sensitive?: boolean;
  overridable?: boolean;
  inherited?: boolean;
  nullable?: boolean;
  tenantOverridable?: boolean;
  runtimeOverridable?: boolean;
  description?: string;
  allowedValues?: unknown[];
}

export interface ConfigValue {
  key: string;
  value: unknown;
  scope: ConfigScope;
  scopeId?: string;
  locked?: boolean;
  secret?: boolean;
  sensitive?: boolean;
  createdBy?: string;
  createdAt?: string;
}

export interface ResolvedConfigValue {
  value: unknown;
  sourceScope: ConfigScope;
  sourceObjectId?: string;
  defaulted: boolean;
  locked: boolean;
  secret: boolean;
  sensitive: boolean;
  redacted: boolean;
  inherited: boolean;
}

export interface ResolvedConfig {
  pipelineId: string;
  pipelineVersionId?: string;
  tenantId: string;
  environment: string;
  values: Record<string, ResolvedConfigValue>;
  violations: ConfigViolation[];
}

export interface ConfigViolation {
  key: string;
  scope: ConfigScope;
  reason: string;
}

export type PluginCategory =
  | "datasource"
  | "loader"
  | "parser"
  | "chunker"
  | "embedder"
  | "vector_store"
  | "retriever"
  | "reranker"
  | "llm"
  | "prompt_template"
  | "tool"
  | "guardrail"
  | "evaluator"
  | "output_parser"
  | "transformer"
  | "router"
  | "control"
  | "memory"
  | "sink";

export interface PluginRef {
  category: PluginCategory;
  id: string;
  version: string;
}

/** User-defined Builder stage (purely organizational; no runtime
 *  semantics — only the Builder reads it). Pipeline nodes reference a
 *  stage by id via `ui.stageId`. */
export interface PipelineStage {
  id: string;
  label: string;
}

/**
 * How a pipeline is invoked at runtime (Phase 8 of dataset/RBAC/retrieval
 * refactor). The default `batch` mode is the historical behaviour:
 * `/api/pipelines/:id/run` enqueues a `RunPipelineJob` onto BullMQ and a
 * worker drains it. `synchronous` pipelines run in-process on the API
 * pod via `/api/pipelines/:id/invoke` (and stream node progress over
 * `/api/pipelines/:id/stream`) so chat-style retrieval can answer in a
 * single HTTP round-trip. Mode is a metadata flag (not the apiVersion
 * `kind` which is reserved for the Kubernetes-style resource type) so
 * existing seeded specs need no edit — `undefined` reads as `batch`.
 */
export type PipelineExecutionKind = "batch" | "synchronous";

export interface PipelineSpec {
  apiVersion: "rag-platform/v1";
  kind: "Pipeline";
  metadata: {
    name: string;
    description?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    /** Ordered list of Builder stage sections. */
    stages?: PipelineStage[];
    /**
     * Execution mode (Phase 8). `undefined` → `batch` for back-compat.
     */
    executionKind?: PipelineExecutionKind;
    /**
     * When true on a synchronous pipeline, the MCP server auto-registers
     * the pipeline as a callable tool. Tool name defaults to the
     * pipeline slug; input/output schemas come from the spec's I/O
     * nodes. No-op on batch pipelines (MCP tools are call-and-wait by
     * contract).
     */
    mcpExpose?: boolean;
  };
  spec: {
    parameters?: ConfigDefinition[];
    nodes: PipelineNode[];
    edges: PipelineEdge[];
  };
}

export interface PipelineNode {
  id: string;
  type?: "input" | "output";
  plugin?: PluginRef;
  config?: Record<string, unknown>;
  secrets?: Record<string, SecretRef>;
  /**
   * Optional Dataset reference (Phase 5 of dataset/RBAC/retrieval
   * refactor). When set on a storage-touching node, the runtime
   * resolves the `slug` (+ optional `alias`, defaults to `stable`)
   * against scope inheritance at execute time and either hands a
   * v2 plugin a {@link ResolvedDataset} OR splices the resolved
   * backend collection names into the v1 plugin's
   * `config.collection` / `config.index` via the compatibility shim.
   */
  dataset?: { slug: string; alias?: string };
  /**
   * Optional ExternalConnection reference (ADR-0021). When set, the
   * runtime resolves the slug via env -> tenant -> global cascade and
   * hands a v2 plugin a {@link ResolvedExternalConnection} on
   * `input.connection`. Plugins that touch external DBs (MongoDB,
   * ClickHouse, HTTP-as-DB, …) read connection info from there instead
   * of from `secrets.dsn`; the runtime enforces
   * `connection:use` before invoking the plugin.
   */
  connection?: { slug: string };
  ui?: Record<string, unknown>;
}

export interface PipelineEdge {
  from: string;
  to: string;
  fromPort?: string;
  toPort?: string;
}

// ---------------------------------------------------------------------------
// Dataset (Phase 4 of dataset/RBAC/retrieval refactor)
// ---------------------------------------------------------------------------

/**
 * Scope at which a Dataset is defined. Resolution at reference time walks
 * `environment -> tenant -> global`, first match wins; cross-scope writes
 * require explicit opt-in by the caller.
 */
export type DatasetScope = "global" | "tenant" | "environment";

/**
 * A named, schema'd container of vector / keyword / structured data that
 * pipelines reference *by id* rather than by raw collection name. The
 * platform owns the physical naming and backend selection; plugins only
 * see the resolved {@link DatasetVersion} the runtime hands them.
 *
 * Multiple pipelines can ingest into and retrieve from the same Dataset —
 * that's the whole point of the abstraction, and the reason a tenant
 * with N ingestion pipelines plus M retrieval pipelines doesn't get
 * N×M coupled collections anymore.
 */
export interface Dataset {
  id: UUID;
  scope: DatasetScope;
  /** NULL when scope === 'global'. */
  tenantId?: string;
  /** Free-text env name (mirrors environments.name); set only when scope === 'environment'. */
  environmentId?: string;
  slug: string;
  displayName: string;
  description?: string;
  embeddingProfile: EmbeddingProfile;
  /** JSON-schema-like record shape every chunk written here must conform to. */
  chunkSchema: Record<string, unknown>;
  /** Which modalities the dataset is provisioned for. */
  modalities: DatasetModality[];
  /** Backend selection per modality. */
  backends: DatasetBackends;
  /** Currently-ready version id; pipelines pin to an alias unless otherwise. */
  currentVersionId?: string;
  archivedAt?: string;
  createdAt: string;
  createdBy?: string;
  updatedAt: string;
}

export type DatasetModality = "vector" | "keyword";

/**
 * Backend declaration: which provider holds which modality. v1 supports
 * one provider per modality; multi-backend layered storage lands in a
 * later phase.
 */
export interface DatasetBackends {
  vector?: { provider: "qdrant" | "pgvector" | "opensearch"; config?: Record<string, unknown> };
  keyword?: { provider: "opensearch" | "postgres_fts"; config?: Record<string, unknown> };
  hybrid?: { strategy: "rrf" | "weighted_sum"; config?: Record<string, unknown> };
}

/**
 * Immutable snapshot of a Dataset's schema + the physical collection
 * names where its data lives. Pipelines pin to a version (or to a
 * moveable alias that resolves to one). Changing the schema requires a
 * new version because the existing data was indexed under the old one.
 */
export interface DatasetVersion {
  id: UUID;
  datasetId: UUID;
  versionLabel: string;
  schemaSpec: Record<string, unknown>;
  /** `{ vector: "rag_acme_prod_supportkb_v2", keyword: "..." }` */
  backendCollections: Record<string, string>;
  status: "building" | "ready" | "archived";
  docCount: number;
  sizeBytes: number;
  createdAt: string;
  readyAt?: string;
}

/**
 * Moveable pointer (`stable`, `staging`, `canary`) into a Dataset's
 * version timeline. Pipelines pin to an alias so the platform can swap
 * the underlying version atomically.
 */
export interface DatasetAlias {
  id: UUID;
  datasetId: UUID;
  alias: string;
  versionId: UUID;
  updatedAt: string;
  updatedBy?: string;
}

export interface SecretRef {
  provider?: SecretProviderKind;
  scope: "tenant" | "environment" | "global" | "tenant_provider" | "datasource";
  tenantId?: string;
  environment?: string;
  key: string;
  version?: string;
}

export type SecretProviderKind =
  | "database_encrypted"
  | "environment"
  | "kubernetes_secret"
  | "vault"
  | "aws_secrets_manager";

export interface RuntimeContext {
  requestId: string;
  executionId: string;
  tenantId: string;
  pipelineId: string;
  pipelineVersionId: string;
  environment: string;
  actor?: Actor;
  resolvedConfig: ResolvedConfig;
  deadline?: Date;
  signal?: AbortSignal;
  /**
   * Defense-in-depth permission check, populated by the worker when it has
   * both an authorizer wired AND an `enqueuedBy` block on the job. Called
   * once at executor entry; if it returns `false`, the run is recorded as
   * `denied` and the DAG never executes. Untyped permission/resource here
   * to keep `core` dependency-free; the worker passes `pipeline:run` plus
   * the current run's tenant/pipeline/environment.
   */
  principalAuthorize?: (
    permission: string,
    resource?: { tenantId?: string; environment?: string; pipelineId?: string }
  ) => boolean;
}

export interface Actor {
  id: string;
  type: "user" | "service" | "api_key";
  roles?: string[];
}

export interface UsageRecord {
  tenantId: string;
  pipelineId: string;
  executionId: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  embeddingTokens?: number;
  estimatedCostUsd?: number;
  latencyMs?: number;
  success: boolean;
}

export interface AuditRecord {
  actor?: Actor;
  tenantId?: string;
  pipelineId?: string;
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  requestId?: string;
  sourceIp?: string;
  userAgent?: string;
  createdAt: string;
}

export function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (looksSensitive(value)) return "REDACTED";
    return value;
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = isSensitiveKey(key) ? "REDACTED" : redactValue(nested);
    }
    return output;
  }
  return value;
}

export function isSensitiveKey(key: string): boolean {
  return /(api[_-]?key|authorization|bearer|password|passwd|secret|token|connection[_-]?string|private[_-]?key)/i.test(key);
}

export function looksSensitive(value: string): boolean {
  // 1) Known secret prefixes / formats. These are unambiguous credential
  //    shapes regardless of length, so match them up front.
  //    - sk-...            (OpenAI / Anthropic style API keys)
  //    - xoxb-/xoxp-/...   (Slack tokens)
  //    - ghp_/gho_/...     (GitHub tokens)
  //    - Bearer <token>    (Authorization header values)
  if (/^(sk-|xox[baprs]-|gh[pousr]_)/.test(value)) return true;
  if (/^Bearer\s+\S+/.test(value)) return true;

  // 2) JWT: three base64url segments separated by dots, starting with the
  //    canonical `eyJ` header. Allow surrounding whitespace only at the edges
  //    (e.g. trailing newline) but not inside the token itself.
  const trimmed = value.trim();
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed)) {
    return true;
  }

  // 3) Connection-string-looking values: `scheme://user:pass@host[/db]`.
  //    A `://...:...@` shape embeds credentials and must stay redacted even
  //    though it contains punctuation. It still must not contain whitespace
  //    inside the URL (real prose with a URL in a sentence has spaces around
  //    the credential portion, and we only match a contiguous URL token).
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@\S+$/.test(trimmed)) {
    return true;
  }

  // 4) High-entropy opaque token. Only treat a string as a secret token when
  //    the WHOLE value is a single contiguous run of token-ish characters
  //    with NO whitespace at all. Natural language, markdown and JSON prose
  //    always contain spaces/newlines, so they fall through here and are NOT
  //    redacted even if they contain a long alphanumeric substring.
  if (/\s/.test(value)) return false;
  if (!/^[A-Za-z0-9+/=_.-]{40,}$/.test(value)) return false;

  // Reject contiguous strings that are clearly not opaque secrets: a single
  // long natural word (all letters, single case) or a dotted/underscored
  // identifier path with no digits and no entropy markers. Genuine opaque
  // tokens mix character classes (digits + letters, or include +/=_- noise).
  const hasDigit = /[0-9]/.test(value);
  const hasUpper = /[A-Z]/.test(value);
  const hasLower = /[a-z]/.test(value);
  const hasTokenNoise = /[+/=_-]/.test(value);
  const classes = (hasDigit ? 1 : 0) + (hasUpper ? 1 : 0) + (hasLower ? 1 : 0);
  return hasDigit || hasTokenNoise || classes >= 2;
}

export interface EmbeddingProfile {
  provider: string;
  model: string;
  dimensions: number;
  normalization?: string;
  distanceMetric: "cosine" | "dot" | "euclidean";
  chunkingSettingsHash: string;
}

export function sanitizeSlug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "default";
}

export function stableHash(input: unknown): string {
  const json = typeof input === "string" ? input : JSON.stringify(input, Object.keys(input as object).sort());
  let hash = 5381;
  for (let index = 0; index < json.length; index += 1) {
    hash = (hash * 33) ^ json.charCodeAt(index);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function vectorCollectionName(args: {
  environment: string;
  tenantSlug: string;
  pipelineSlug: string;
  embeddingProfile: EmbeddingProfile;
}): string {
  return [
    "rag",
    sanitizeSlug(args.environment),
    sanitizeSlug(args.tenantSlug),
    sanitizeSlug(args.pipelineSlug),
    stableHash(args.embeddingProfile)
  ].join("_");
}
