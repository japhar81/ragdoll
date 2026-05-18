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
  | "memory"
  | "sink";

export interface PluginRef {
  category: PluginCategory;
  id: string;
  version: string;
}

export interface PipelineSpec {
  apiVersion: "rag-platform/v1";
  kind: "Pipeline";
  metadata: {
    name: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
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
  ui?: Record<string, unknown>;
}

export interface PipelineEdge {
  from: string;
  to: string;
  fromPort?: string;
  toPort?: string;
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
  return /^(sk-|xox[baprs]-|eyJ|Bearer\s+|gh[pousr]_)/.test(value) || value.length > 48 && /[A-Za-z0-9+/=_-]{32,}/.test(value);
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
