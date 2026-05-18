/**
 * Thin fetch wrapper over the documented RAGdoll control-plane API
 * (see docs/api/openapi.yaml). Routes/methods/status codes mirror that spec
 * exactly. Pure module: no React. The dev server proxies `/api` -> :3001.
 *
 * Auth: every /api/* route requires a credential. We send a Bearer token (or
 * x-api-key) when one is configured, plus an optional x-tenant-id scope. With
 * no token the server's DevAuthProvider fallback applies outside production.
 */
import type {
  ExecutionNodeRecord,
  ExecutionRecord,
  PipelineSpec,
  PipelineValidationResult
} from "./types.ts";
import type { JsonSchemaLike } from "./schemaForm.ts";

export type { JsonSchemaLike } from "./schemaForm.ts";

export interface ApiAuth {
  token?: string;
  apiKey?: string;
  tenantId?: string;
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(
      typeof body === "object" && body && "error" in body
        ? `API ${status}: ${String((body as { error: unknown }).error)}`
        : `API ${status}`
    );
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

let auth: ApiAuth = {};

/** Set the credentials used for subsequent requests (token / api key / tenant). */
export function setAuth(next: ApiAuth): void {
  auth = next;
}

export function getAuth(): ApiAuth {
  return auth;
}

export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  if (auth.apiKey) headers["x-api-key"] = auth.apiKey;
  if (auth.tenantId) headers["x-tenant-id"] = auth.tenantId;
  return headers;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders(), ...extraHeaders };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  let parsed: unknown = text;
  if (text && contentType.includes("application/json")) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) throw new ApiError(response.status, parsed);
  return parsed as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  if (entries.length === 0) return "";
  return "?" + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
}

export const api = {
  health: () => request<{ ok: boolean; status: string }>("GET", "/healthz"),

  // ---- tenants ----------------------------------------------------------
  listTenants: () => request<{ tenants: TenantRow[] }>("GET", "/api/tenants"),
  createTenant: (input: { slug: string; name: string; status?: string }) =>
    request<{ tenant: TenantRow }>("POST", "/api/tenants", input),
  updateTenant: (id: string, patch: Record<string, unknown>) =>
    request<{ tenant: TenantRow }>("PUT", `/api/tenants/${encodeURIComponent(id)}`, patch),
  deleteTenant: (id: string) =>
    request<void>("DELETE", `/api/tenants/${encodeURIComponent(id)}`),

  // ---- pipelines --------------------------------------------------------
  listPipelines: () => request<{ pipelines: PipelineRow[] }>("GET", "/api/pipelines"),
  createPipeline: (input: { slug: string; name: string; description?: string }) =>
    request<{ pipeline: PipelineRow }>("POST", "/api/pipelines", input),
  validateSpec: (spec: PipelineSpec | string) =>
    request<PipelineValidationResult>("POST", "/api/pipelines/validate", spec),
  listVersions: (pipelineId: string) =>
    request<{ versions: PipelineVersionRow[] }>(
      "GET",
      `/api/pipelines/${encodeURIComponent(pipelineId)}/versions`
    ),
  saveVersion: (
    pipelineId: string,
    input: { version: string; spec: PipelineSpec; publish?: boolean }
  ) =>
    request<{ version: PipelineVersionRow }>(
      "POST",
      `/api/pipelines/${encodeURIComponent(pipelineId)}/versions`,
      input
    ),
  exportVersion: (pipelineId: string, version: string, format: "json" | "yaml") =>
    request<string>(
      "GET",
      `/api/pipelines/${encodeURIComponent(pipelineId)}/versions/${encodeURIComponent(
        version
      )}/export${qs({ format })}`
    ),
  listDeployments: (pipelineId: string) =>
    request<{ deployments: DeploymentRow[] }>(
      "GET",
      `/api/pipelines/${encodeURIComponent(pipelineId)}/deployments`
    ),
  deploy: (
    pipelineId: string,
    input: { version: string; environment: string; tenantId?: string }
  ) =>
    request<{ deployment: DeploymentRow }>(
      "POST",
      `/api/pipelines/${encodeURIComponent(pipelineId)}/deployments`,
      input
    ),
  run: (pipelineId: string, input: { input?: unknown; environment?: string }) =>
    request<RunAccepted>(
      "POST",
      `/api/pipelines/${encodeURIComponent(pipelineId)}/run`,
      input
    ),

  // ---- config -----------------------------------------------------------
  listConfigDefinitions: () =>
    request<{ definitions: ConfigDefinitionRow[] }>("GET", "/api/config/definitions"),
  listConfigValues: (params: { key?: string; scope?: string; scope_id?: string } = {}) =>
    request<{ values: ConfigValueRow[] }>("GET", `/api/config/values${qs(params)}`),
  upsertConfigValue: (input: {
    key: string;
    value: unknown;
    scope: string;
    scopeId?: string;
  }) => request<{ value: ConfigValueRow }>("POST", "/api/config/values", input),
  resolvedConfig: (params: {
    pipeline_id: string;
    tenant_id: string;
    environment: string;
  }) => request<ResolvedConfig>("GET", `/api/config/resolved${qs(params)}`),

  // ---- secrets ----------------------------------------------------------
  listSecrets: () => request<{ secrets: SecretMeta[] }>("GET", "/api/secrets"),
  createSecret: (input: {
    key: string;
    value: string;
    scope?: string;
    tenantId?: string;
  }) => request<{ secret: SecretMeta }>("POST", "/api/secrets", input),

  // ---- executions -------------------------------------------------------
  listExecutions: () =>
    request<{ executions: ExecutionRecord[] }>("GET", "/api/executions"),
  getTrace: (executionId: string) =>
    request<{
      executionId: string;
      execution: ExecutionRecord;
      nodes: ExecutionNodeRecord[];
    }>("GET", `/api/executions/${encodeURIComponent(executionId)}/trace`),

  // ---- audit / usage / plugins -----------------------------------------
  listAudit: (params: { tenant_id?: string; limit?: number } = {}) =>
    request<{ logs: AuditRow[] }>("GET", `/api/audit${qs(params)}`),
  usage: (params: { tenant_id?: string; execution_id?: string } = {}) =>
    request<{ summary: UsageSummary; records: UsageRow[] }>(
      "GET",
      `/api/usage${qs(params)}`
    ),
  listPlugins: () => request<{ plugins: PluginInfo[] }>("GET", "/api/plugins"),

  /**
   * Fetch a single plugin's full metadata (incl. config/secrets schema + ui).
   * Hits the per-plugin route; if that route 404s (older API that only knows
   * GET /api/plugins) we fall back to scanning the list. Returns `undefined`
   * when the plugin truly is not registered.
   */
  async getPlugin(
    category: string,
    id: string,
    version: string
  ): Promise<PluginInfo | undefined> {
    try {
      const res = await request<{ plugin: PluginInfo }>(
        "GET",
        `/api/plugins/${encodeURIComponent(category)}/${encodeURIComponent(
          id
        )}/${encodeURIComponent(version)}`
      );
      return res.plugin;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
      // 404 may mean "no such plugin" OR "older API without the per-plugin
      // route" — disambiguate by scanning the list endpoint.
      const { plugins } = await request<{ plugins: PluginInfo[] }>(
        "GET",
        "/api/plugins"
      );
      return plugins.find(
        (p) => p.category === category && p.id === id && p.version === version
      );
    }
  }
};

// ---- response row shapes (loosely typed; only fields the UI reads) -------

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  createdAt?: string;
}

export interface PipelineRow {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
}

export interface PipelineVersionRow {
  id: string;
  pipelineId: string;
  version: string;
  status: string;
  checksum: string;
  createdAt: string;
  publishedAt?: string | null;
}

export interface DeploymentRow {
  id: string;
  pipelineId: string;
  pipelineVersionId: string;
  environment: string;
  tenantId?: string | null;
  status: string;
  deployedAt: string;
}

export interface RunAccepted {
  executionId: string;
  jobId: string;
  pipelineId: string;
  pipelineVersionId: string;
  version: string;
  status: string;
}

export interface ConfigDefinitionRow {
  key: string;
  type: string;
  allowedScopes: string[];
  required?: boolean;
  secret?: boolean;
  sensitive?: boolean;
  description?: string | null;
}

export interface ConfigValueRow {
  id: string;
  key: string;
  value: unknown;
  scope: string;
  scopeId?: string | null;
  locked?: boolean;
}

export interface ResolvedConfig {
  pipelineId: string;
  tenantId: string;
  environment: string;
  values: Record<
    string,
    { value: unknown; sourceScope: string; redacted: boolean; secret: boolean }
  >;
  violations: Array<{ key: string; scope: string; reason: string }>;
}

export interface SecretMeta {
  id: string;
  provider?: string;
  ref?: unknown;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  metadata?: unknown;
  value: string;
}

export interface AuditRow {
  id?: string;
  actorId: string;
  tenantId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  createdAt: string;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  embeddingTokens: number;
  estimatedCostUsd: number;
  count: number;
}

export interface UsageRow {
  executionId?: string;
  tenantId?: string;
  inputTokens: number;
  outputTokens: number;
  embeddingTokens: number;
  estimatedCostUsd: number;
}

/** Plugin-published UI hints (all optional; tolerate any missing field). */
export interface PluginUi {
  icon?: string;
  color?: string;
  formHints?: Record<string, unknown>;
  paletteGroup?: string;
  /**
   * Optional URL of an ES module exporting a custom config editor. UNTRUSTED
   * third-party code — only admin-registered plugins ship one, and none do
   * yet. PluginEditorSlot lazy-imports it behind an error boundary.
   */
  module?: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  category: string;
  description?: string;
  mode?: string;
  capabilities?: string[];
  configSchema?: JsonSchemaLike;
  secretsSchema?: JsonSchemaLike;
  ui?: PluginUi;
}
