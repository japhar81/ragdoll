/**
 * Thin fetch wrapper over the documented RAGdoll control-plane API
 * (see docs/api/openapi.yaml). Routes/methods/status codes mirror that spec
 * exactly. Pure module: no React. The dev server proxies `/api` -> :3001.
 *
 * Auth: every /api/* route requires a credential. We always send `x-roles`
 * (so the server's DevAuthProvider grants admin outside production), a Bearer
 * token / x-api-key when configured, and `x-tenant-id` when a tenant is
 * selected. Tenant-scoped routes (run, resolved-config, deploy,
 * tenant-pipelines, activations, schedules, config, secrets) 422 with
 * "tenant context required" when that header is absent. The header MUST carry
 * the tenant **UUID**, never the slug — buildAuthHeaders enforces this.
 */
import type {
  ExecutionNodeRecord,
  ExecutionRecord,
  PipelineSpec,
  PipelineValidationResult
} from "./types.ts";
import type { JsonSchemaLike } from "./schemaForm.ts";
import { buildAuthHeaders } from "./tenantContext.ts";

export type { JsonSchemaLike } from "./schemaForm.ts";

export interface ApiAuth {
  token?: string;
  apiKey?: string;
  /** Selected tenant — MUST be a tenant UUID, not a slug. */
  tenantId?: string;
  /** Dev roles header (defaults to `platform_admin`). */
  roles?: string;
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

/**
 * Set (or clear) the tenant scope all subsequent requests carry as
 * `x-tenant-id`. Pass a tenant **UUID**; a slug is dropped by the header
 * builder rather than sent (it would 409/empty downstream). Pass `undefined`
 * to clear the scope. Other credentials (token/api key/roles) are preserved.
 */
export function setTenant(tenantId?: string): void {
  auth = { ...auth, tenantId };
}

export function getAuth(): ApiAuth {
  return auth;
}

/**
 * Headers every request carries: always `x-roles` (dev auth), Bearer/api-key
 * when configured, and `x-tenant-id` only when a UUID tenant is set. Slug
 * tenant ids are intentionally NOT sent (see buildAuthHeaders).
 */
export function authHeaders(): Record<string, string> {
  return buildAuthHeaders(auth);
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

  // ---- auth/tenant context (also exported standalone above) -------------
  setTenant,
  setAuth,
  getAuth,

  // ---- tenants ----------------------------------------------------------
  listTenants: () => request<{ tenants: TenantRow[] }>("GET", "/api/tenants"),
  createTenant: (input: { slug: string; name: string; status?: string }) =>
    request<{ tenant: TenantRow }>("POST", "/api/tenants", input),
  updateTenant: (id: string, patch: Record<string, unknown>) =>
    request<{ tenant: TenantRow }>("PUT", `/api/tenants/${encodeURIComponent(id)}`, patch),
  deleteTenant: (id: string) =>
    request<void>("DELETE", `/api/tenants/${encodeURIComponent(id)}`),

  // ---- per-tenant environments -----------------------------------------
  listEnvironments: (tenantId: string) =>
    request<{ environments: EnvironmentRow[] }>(
      "GET",
      `/api/tenants/${encodeURIComponent(tenantId)}/environments`
    ),
  createEnvironment: (
    tenantId: string,
    input: { name: string; description?: string; isProduction?: boolean }
  ) =>
    request<{ environment: EnvironmentRow }>(
      "POST",
      `/api/tenants/${encodeURIComponent(tenantId)}/environments`,
      input
    ),
  updateEnvironment: (
    tenantId: string,
    envId: string,
    patch: { name?: string; description?: string | null; isProduction?: boolean }
  ) =>
    request<{ environment: EnvironmentRow }>(
      "PUT",
      `/api/tenants/${encodeURIComponent(tenantId)}/environments/${encodeURIComponent(
        envId
      )}`,
      patch
    ),
  deleteEnvironment: (tenantId: string, envId: string) =>
    request<void>(
      "DELETE",
      `/api/tenants/${encodeURIComponent(tenantId)}/environments/${encodeURIComponent(
        envId
      )}`
    ),

  // ---- pipelines --------------------------------------------------------
  listPipelines: () => request<{ pipelines: PipelineRow[] }>("GET", "/api/pipelines"),
  createPipeline: (input: {
    slug: string;
    name: string;
    description?: string;
    folderId?: string | null;
  }) => request<{ pipeline: PipelineRow }>("POST", "/api/pipelines", input),
  getPipeline: (pipelineId: string) =>
    request<{ pipeline: PipelineRow }>(
      "GET",
      `/api/pipelines/${encodeURIComponent(pipelineId)}`
    ),
  updatePipeline: (
    pipelineId: string,
    input: { name?: string; description?: string }
  ) =>
    request<{ pipeline: PipelineRow }>(
      "PUT",
      `/api/pipelines/${encodeURIComponent(pipelineId)}`,
      input
    ),
  validateSpec: (spec: PipelineSpec | string) =>
    request<PipelineValidationResult>("POST", "/api/pipelines/validate", spec),
  listVersions: (pipelineId: string) =>
    request<{ versions: PipelineVersionRow[]; latestVersionId?: string | null }>(
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
  /**
   * Auto-versioned save (POST /api/pipelines/:id/save). 200 + created:false
   * when the spec is identical to the current latest (idempotent, no new
   * row); 201 + created:true when a new published version is minted.
   */
  savePipeline: (
    pipelineId: string,
    input: { spec: PipelineSpec; level?: "patch" | "minor" | "major" }
  ) =>
    request<{ version: PipelineVersionRow; created: boolean }>(
      "POST",
      `/api/pipelines/${encodeURIComponent(pipelineId)}/save`,
      input
    ),
  rollbackPipeline: (pipelineId: string, versionId: string) =>
    request<{ pipeline: PipelineRow; latestVersionId: string }>(
      "POST",
      `/api/pipelines/${encodeURIComponent(pipelineId)}/rollback`,
      { versionId }
    ),

  // ---- folders ----------------------------------------------------------
  listFolders: () => request<{ folders: FolderTreeNode[] }>("GET", "/api/folders"),
  createFolder: (input: { name: string; parentId?: string | null }) =>
    request<{ folder: PipelineFolderRow }>("POST", "/api/folders", input),
  updateFolder: (
    id: string,
    patch: { name?: string; parentId?: string | null }
  ) =>
    request<{ folder: PipelineFolderRow }>(
      "PUT",
      `/api/folders/${encodeURIComponent(id)}`,
      patch
    ),
  deleteFolder: (id: string) =>
    request<void>("DELETE", `/api/folders/${encodeURIComponent(id)}`),
  movePipelineToFolder: (pipelineId: string, folderId: string | null) =>
    request<{ pipeline: PipelineRow }>(
      "PUT",
      `/api/pipelines/${encodeURIComponent(pipelineId)}/folder`,
      { folderId }
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
  run: (
    pipelineId: string,
    input: { input?: unknown; environment?: string; activation?: string }
  ) =>
    request<RunAccepted>(
      "POST",
      `/api/pipelines/${encodeURIComponent(pipelineId)}/run`,
      input
    ),
  /**
   * Phase 8: synchronous in-process execution. Returns the terminal
   * output in one HTTP round-trip; intended for synchronous pipelines
   * (those with `metadata.executionKind: "synchronous"`).
   */
  invokePipeline: (
    pipelineId: string,
    input: { input?: unknown; environment?: string }
  ) =>
    request<{
      executionId: string;
      pipelineId: string;
      pipelineVersionId: string;
      version: string;
      status: "succeeded";
      output: Record<string, unknown>;
    }>(
      "POST",
      `/api/pipelines/${encodeURIComponent(pipelineId)}/invoke`,
      input
    ),

  // ---- per-tenant Git storage (migration 007) ---------------------------
  getTenantStorage: (tenantId: string) =>
    request<{
      storageMode: "db" | "git";
      git: null | {
        tenantId: string;
        remoteUrl: string;
        branch: string;
        pathPrefix: string;
        authMethod: "https" | "ssh";
        authSecretId: string;
        pollIntervalSec: number;
        lastSyncedSha: string | null;
        lastSyncedAt: string | null;
        lastSyncError: string | null;
        createdAt: string;
        updatedAt: string;
      };
    }>("GET", `/api/tenants/${encodeURIComponent(tenantId)}/storage`),
  putTenantStorage: (
    tenantId: string,
    input: {
      remoteUrl: string;
      branch: string;
      pathPrefix: string;
      authMethod: "https" | "ssh";
      authSecretId: string;
      pollIntervalSec: number;
    }
  ) =>
    request<{ storageMode: "git"; git: unknown }>(
      "PUT",
      `/api/tenants/${encodeURIComponent(tenantId)}/storage`,
      input
    ),
  deleteTenantStorage: (tenantId: string) =>
    request<undefined>(
      "DELETE",
      `/api/tenants/${encodeURIComponent(tenantId)}/storage`
    ),
  syncTenantStorage: (tenantId: string) =>
    request<{ status: "queued" }>(
      "POST",
      `/api/tenants/${encodeURIComponent(tenantId)}/storage/sync`
    ),

  // ---- tenant <-> pipeline associations + activations -------------------
  listTenantPipelines: (tenantId: string) =>
    request<{ pipelines: TenantPipelineRow[] }>(
      "GET",
      `/api/tenants/${encodeURIComponent(tenantId)}/pipelines`
    ),
  associatePipeline: (
    tenantId: string,
    input: { pipelineId: string; environment?: string }
  ) =>
    request<{ association?: unknown }>(
      "POST",
      `/api/tenants/${encodeURIComponent(tenantId)}/pipelines`,
      input
    ),
  updateTenantPipeline: (
    tenantId: string,
    pipelineId: string,
    patch: { enabled: boolean; environment?: string }
  ) =>
    request<{ association?: unknown }>(
      "PATCH",
      `/api/tenants/${encodeURIComponent(tenantId)}/pipelines/${encodeURIComponent(
        pipelineId
      )}`,
      patch
    ),
  listActivations: (tenantId: string, pipelineId: string) =>
    request<{ activations: ActivationRow[] }>(
      "GET",
      `/api/tenants/${encodeURIComponent(tenantId)}/pipelines/${encodeURIComponent(
        pipelineId
      )}/activations`
    ),
  createActivation: (
    tenantId: string,
    pipelineId: string,
    input: {
      label: string;
      environment: string;
      pipelineVersionId?: string;
      trackLatest?: boolean;
      enabled?: boolean;
    }
  ) =>
    request<{ activation: ActivationRow }>(
      "POST",
      `/api/tenants/${encodeURIComponent(tenantId)}/pipelines/${encodeURIComponent(
        pipelineId
      )}/activations`,
      input
    ),
  updateActivation: (
    tenantId: string,
    pipelineId: string,
    activationId: string,
    patch: {
      enabled?: boolean;
      trackLatest?: boolean;
      pipelineVersionId?: string | null;
      label?: string;
    }
  ) =>
    request<{ activation: ActivationRow }>(
      "PATCH",
      `/api/tenants/${encodeURIComponent(tenantId)}/pipelines/${encodeURIComponent(
        pipelineId
      )}/activations/${encodeURIComponent(activationId)}`,
      patch
    ),
  deleteActivation: (
    tenantId: string,
    pipelineId: string,
    activationId: string
  ) =>
    request<void>(
      "DELETE",
      `/api/tenants/${encodeURIComponent(tenantId)}/pipelines/${encodeURIComponent(
        pipelineId
      )}/activations/${encodeURIComponent(activationId)}`
    ),

  // ---- schedules --------------------------------------------------------
  listSchedules: (params: { tenant?: string; pipeline?: string } = {}) =>
    request<{ schedules: ScheduleRow[] }>(
      "GET",
      `/api/schedules${qs(params)}`
    ),
  createSchedule: (input: {
    tenantId: string;
    pipelineId: string;
    environment: string;
    activationLabel?: string;
    cron: string;
    timezone?: string;
    input?: unknown;
    enabled?: boolean;
  }) => request<{ schedule: ScheduleRow }>("POST", "/api/schedules", input),
  updateSchedule: (
    id: string,
    patch: {
      environment?: string;
      activationLabel?: string | null;
      cron?: string;
      timezone?: string;
      input?: unknown;
      enabled?: boolean;
    }
  ) =>
    request<{ schedule: ScheduleRow }>(
      "PUT",
      `/api/schedules/${encodeURIComponent(id)}`,
      patch
    ),
  toggleSchedule: (id: string, enabled: boolean) =>
    request<{ schedule: ScheduleRow }>(
      "PATCH",
      `/api/schedules/${encodeURIComponent(id)}`,
      { enabled }
    ),
  deleteSchedule: (id: string) =>
    request<void>("DELETE", `/api/schedules/${encodeURIComponent(id)}`),

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
  // Tenant context rides on x-tenant-id (set via api.setTenant) like every
  // other route — these add no special-casing. The worker writes the trace to
  // Postgres and the API reads it, so the Builder/Executions screens *poll*
  // these (1–1.5s) until the execution is terminal; see lib/execTrace.ts.
  listExecutions: (
    params: {
      pipeline_id?: string;
      tenant_id?: string;
      status?: string;
      limit?: number;
      cursor?: string;
    } = {}
  ) =>
    request<{
      executions: ExecutionRecord[];
      nextCursor?: string | null;
      total?: number;
    }>("GET", `/api/executions${qs(params)}`),
  getExecution: (executionId: string) =>
    request<{ execution: ExecutionRecord }>(
      "GET",
      `/api/executions/${encodeURIComponent(executionId)}`
    ),
  getExecutionTrace: (executionId: string) =>
    request<{
      executionId: string;
      execution: ExecutionRecord;
      nodes: ExecutionNodeRecord[];
    }>("GET", `/api/executions/${encodeURIComponent(executionId)}/trace`),
  /** Back-compat alias for getExecutionTrace (older callers). */
  getTrace: (executionId: string) =>
    request<{
      executionId: string;
      execution: ExecutionRecord;
      nodes: ExecutionNodeRecord[];
    }>("GET", `/api/executions/${encodeURIComponent(executionId)}/trace`),

  // ---- audit / usage / plugins -----------------------------------------
  listAudit: (
    params: { tenant_id?: string; limit?: number; cursor?: string } = {}
  ) =>
    request<{
      logs: AuditRow[];
      nextCursor?: string | null;
      total?: number;
    }>("GET", `/api/audit${qs(params)}`),
  usage: (
    params: {
      tenant_id?: string;
      execution_id?: string;
      limit?: number;
      cursor?: string;
    } = {}
  ) =>
    request<{
      summary: UsageSummary;
      records: UsageRow[];
      nextCursor?: string | null;
      total?: number;
    }>("GET", `/api/usage${qs(params)}`),
  listPlugins: () => request<{ plugins: PluginInfo[] }>("GET", "/api/plugins"),

  // ---- retention --------------------------------------------------------
  listRetention: () =>
    request<{ settings: RetentionSetting[] }>("GET", "/api/retention"),
  updateRetention: (
    resource: "executions" | "usage" | "audit",
    patch: { maxCount?: number | null; maxAgeDays?: number | null }
  ) =>
    request<{ setting: RetentionSetting }>(
      "PATCH",
      `/api/retention/${encodeURIComponent(resource)}`,
      patch
    ),

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
  },

  // ---- auth / session ---------------------------------------------------
  login: (email: string, password: string) =>
    request<{ token: string; user: AccountUser }>("POST", "/api/auth/login", {
      email,
      password
    }),
  signup: (input: { email: string; password: string; displayName?: string }) =>
    request<{ token: string; user: AccountUser }>(
      "POST",
      "/api/auth/signup",
      input
    ),
  logout: () => request<void>("POST", "/api/auth/logout"),
  me: () =>
    request<{
      principal: { id: string; type: string; tenantId: string | null };
      user: AccountUser | null;
      grants: GrantView[];
      permissions: string[];
    }>("GET", "/api/auth/me"),
  authProviders: () =>
    request<{ providers: Array<{ slug: string; kind: string; displayName: string }> }>(
      "GET",
      "/api/auth/providers"
    ),
  ssoStartUrl: (slug: string) =>
    `/api/auth/sso/${encodeURIComponent(slug)}/start`,
  getAuthSettings: () =>
    request<{ settings: AuthSettings }>("GET", "/api/auth/settings"),
  updateAuthSettings: (settings: AuthSettings) =>
    request<{ settings: AuthSettings }>("PUT", "/api/auth/settings", settings),

  // ---- users ------------------------------------------------------------
  listUsers: () => request<{ users: AccountUser[] }>("GET", "/api/users"),
  createUser: (input: {
    email: string;
    password?: string;
    displayName?: string;
    status?: string;
  }) => request<{ user: AccountUser }>("POST", "/api/users", input),
  updateUser: (
    id: string,
    patch: { displayName?: string | null; status?: string; password?: string }
  ) =>
    request<{ user: AccountUser }>(
      "PATCH",
      `/api/users/${encodeURIComponent(id)}`,
      patch
    ),
  deleteUser: (id: string) =>
    request<void>("DELETE", `/api/users/${encodeURIComponent(id)}`),
  listGrants: (userId: string) =>
    request<{ grants: GrantView[] }>(
      "GET",
      `/api/users/${encodeURIComponent(userId)}/grants`
    ),
  addGrant: (
    userId: string,
    input: {
      role: string;
      tenantId?: string;
      environment?: string;
      pipelineId?: string;
    }
  ) =>
    request<{ grant: GrantView }>(
      "POST",
      `/api/users/${encodeURIComponent(userId)}/grants`,
      input
    ),
  removeGrant: (userId: string, grantId: string) =>
    request<void>(
      "DELETE",
      `/api/users/${encodeURIComponent(userId)}/grants/${encodeURIComponent(
        grantId
      )}`
    ),

  // ---- roles & permissions ---------------------------------------------
  listRoles: () =>
    request<{ roles: RoleView[]; allPermissions: string[] }>(
      "GET",
      "/api/roles"
    ),
  createRole: (input: { name: string; description?: string }) =>
    request<{ role: unknown }>("POST", "/api/roles", input),
  setRolePermissions: (name: string, permissions: string[]) =>
    request<{ role: string; permissions: string[] }>(
      "PUT",
      `/api/roles/${encodeURIComponent(name)}/permissions`,
      { permissions }
    ),
  deleteRole: (name: string) =>
    request<void>("DELETE", `/api/roles/${encodeURIComponent(name)}`),

  // ---- identity providers ----------------------------------------------
  listIdentityProviders: () =>
    request<{ providers: IdentityProviderView[] }>(
      "GET",
      "/api/identity-providers"
    ),
  createIdentityProvider: (input: {
    slug: string;
    kind: "oidc" | "saml";
    displayName: string;
    enabled?: boolean;
    config: Record<string, unknown>;
  }) =>
    request<{ provider: IdentityProviderView }>(
      "POST",
      "/api/identity-providers",
      input
    ),
  updateIdentityProvider: (
    id: string,
    patch: {
      displayName?: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
    }
  ) =>
    request<{ provider: IdentityProviderView }>(
      "PUT",
      `/api/identity-providers/${encodeURIComponent(id)}`,
      patch
    ),
  deleteIdentityProvider: (id: string) =>
    request<void>(
      "DELETE",
      `/api/identity-providers/${encodeURIComponent(id)}`
    ),

  // ---- self-service profile --------------------------------------------
  updateProfile: (patch: { displayName?: string | null }) =>
    request<{ user: AccountUser }>("PATCH", "/api/auth/me", patch),
  changePassword: (input: { currentPassword?: string; newPassword: string }) =>
    request<{ ok: boolean }>("POST", "/api/auth/password", input),

  // ---- API keys (self-service) -----------------------------------------
  listApiKeys: () =>
    request<{ apiKeys: ApiKeyView[] }>("GET", "/api/api-keys"),
  /**
   * Mint a key. `plaintext` is returned exactly once — it is unrecoverable
   * afterwards, so the caller must surface it to the user immediately.
   */
  createApiKey: (input: {
    name: string;
    role: string;
    tenantId?: string;
    /** Tenant-environment scope; the key cannot act outside this env. */
    environmentId?: string;
    /** ISO-8601 absolute expiration; omit for no expiration. */
    expiresAt?: string;
  }) =>
    request<{ apiKey: ApiKeyView; plaintext: string }>(
      "POST",
      "/api/api-keys",
      input
    ),
  revokeApiKey: (id: string) =>
    request<void>("DELETE", `/api/api-keys/${encodeURIComponent(id)}`),

  // ---- datasets (Phase 4) ----------------------------------------------
  listDatasets: (filter?: { tenantId?: string; environmentId?: string }) =>
    request<{ datasets: DatasetView[] }>("GET", "/api/datasets", undefined, {
      ...(filter?.tenantId ? { "x-tenant-id": filter.tenantId } : {}),
      ...(filter?.environmentId
        ? { "x-environment": filter.environmentId }
        : {})
    }),
  getDataset: (id: string) =>
    request<{ dataset: DatasetView }>(
      "GET",
      `/api/datasets/${encodeURIComponent(id)}`
    ),
  createDataset: (input: {
    scope: "global" | "tenant" | "environment";
    slug: string;
    displayName: string;
    description?: string;
    tenantId?: string;
    environmentId?: string;
    modalities?: string[];
    backends?: Record<string, unknown>;
    embeddingProfile?: Record<string, unknown>;
    chunkSchema?: Record<string, unknown>;
  }) =>
    request<{ dataset: DatasetView }>("POST", "/api/datasets", input),
  updateDataset: (
    id: string,
    patch: {
      displayName?: string;
      description?: string | null;
      archived?: boolean;
      modalities?: string[];
      backends?: Record<string, unknown>;
      embeddingProfile?: Record<string, unknown>;
      chunkSchema?: Record<string, unknown>;
    }
  ) =>
    request<{ dataset: DatasetView }>(
      "PATCH",
      `/api/datasets/${encodeURIComponent(id)}`,
      patch
    ),
  deleteDataset: (id: string) =>
    request<void>("DELETE", `/api/datasets/${encodeURIComponent(id)}`),
  listDatasetVersions: (id: string) =>
    request<{
      versions: DatasetVersionView[];
      aliases: DatasetAliasView[];
    }>("GET", `/api/datasets/${encodeURIComponent(id)}/versions`),
  createDatasetVersion: (
    id: string,
    input: {
      versionLabel?: string;
      schemaSpec?: Record<string, unknown>;
      backendCollections?: Record<string, string>;
      status?: "building" | "ready" | "archived";
    }
  ) =>
    request<{ version: DatasetVersionView }>(
      "POST",
      `/api/datasets/${encodeURIComponent(id)}/versions`,
      input
    ),
  setDatasetAlias: (
    datasetId: string,
    alias: string,
    versionId: string
  ) =>
    request<{ alias: DatasetAliasView }>(
      "PATCH",
      `/api/datasets/${encodeURIComponent(datasetId)}/aliases/${encodeURIComponent(alias)}`,
      { versionId }
    ),

  // ---- datasource connections ------------------------------------------
  // Per-(tenant, env) host + creds for backing stores. The list endpoint's
  // optional env filter dedupes by name and surfaces the row the cascade
  // resolver would actually pick (env-specific > tenant-wide fallback).
  listConnections: (filter: { tenantId?: string; environmentId?: string }) =>
    request<{ connections: ConnectionView[] }>(
      "GET",
      `/api/connections${qs({ environmentId: filter.environmentId })}`,
      undefined,
      {
        // Empty tenantId → admin-only "globals" view; no header sent.
        ...(filter.tenantId ? { "x-tenant-id": filter.tenantId } : {}),
        ...(filter.environmentId ? { "x-environment": filter.environmentId } : {})
      }
    ),
  getConnection: (id: string) =>
    request<{ connection: ConnectionView }>(
      "GET",
      `/api/connections/${encodeURIComponent(id)}`
    ),
  createConnection: (
    tenantId: string,
    input: {
      name: string;
      datasourceType: string;
      /** Pass `null` in the body to create a global connection. */
      tenantId?: string | null;
      environmentId?: string | null;
      secretRefId?: string | null;
      config?: Record<string, unknown>;
      allowedHosts?: string[];
      denyPrivateNetworks?: boolean;
    }
  ) =>
    request<{ connection: ConnectionView }>(
      "POST",
      "/api/connections",
      input,
      tenantId ? { "x-tenant-id": tenantId } : {}
    ),
  updateConnection: (
    id: string,
    tenantId: string,
    patch: {
      name?: string;
      datasourceType?: string;
      secretRefId?: string | null;
      config?: Record<string, unknown>;
      allowedHosts?: string[];
      denyPrivateNetworks?: boolean;
    }
  ) =>
    request<{ connection: ConnectionView }>(
      "PATCH",
      `/api/connections/${encodeURIComponent(id)}`,
      patch,
      { "x-tenant-id": tenantId }
    ),
  deleteConnection: (id: string, tenantId: string) =>
    request<void>(
      "DELETE",
      `/api/connections/${encodeURIComponent(id)}`,
      undefined,
      { "x-tenant-id": tenantId }
    ),
  /**
   * Diagnostic: "what does the cascade resolver actually pick for this
   * name in this env?" Used by the UI's `Datasets` and `Builder` panels
   * to show which connection a dataset references.
   */
  resolveConnection: (
    tenantId: string,
    name: string,
    environmentId?: string
  ) =>
    request<{
      resolved: ConnectionView | null;
      reason: "env_specific" | "tenant_fallback" | "no_match";
    }>(
      "GET",
      `/api/connections/resolve/${encodeURIComponent(name)}${qs({ environmentId })}`,
      undefined,
      {
        "x-tenant-id": tenantId,
        ...(environmentId ? { "x-environment": environmentId } : {})
      }
    )
};

export interface ConnectionView {
  id: string;
  tenantId: string;
  environmentId: string | null;
  name: string;
  datasourceType: string;
  secretRefId: string | null;
  config: Record<string, unknown>;
  allowedHosts: string[];
  denyPrivateNetworks: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---- response row shapes (loosely typed; only fields the UI reads) -------

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  createdAt?: string;
}

export interface EnvironmentRow {
  id: string;
  tenantId: string;
  name: string;
  description?: string | null;
  isProduction: boolean;
  createdAt?: string;
}

export interface PipelineRow {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  folderId?: string | null;
  latestVersionId?: string | null;
}

export interface PipelineVersionRow {
  id: string;
  pipelineId: string;
  version: string;
  status: string;
  checksum: string;
  createdAt: string;
  publishedAt?: string | null;
  parentVersionId?: string | null;
  isLatest?: boolean;
  spec?: unknown;
}

/** Nested folder node as returned by GET /api/folders. */
export interface FolderTreeNode {
  id: string;
  parentId?: string | null;
  name: string;
  createdAt?: string;
  children?: FolderTreeNode[];
}

export interface PipelineFolderRow {
  id: string;
  parentId?: string | null;
  name: string;
  createdAt: string;
}

export interface ActivationRow {
  id: string;
  label: string;
  environment: string;
  pipelineVersionId?: string | null;
  trackLatest: boolean;
  enabled: boolean;
  effectiveVersionId?: string | null;
}

export interface TenantPipelineRow {
  pipelineId: string;
  /**
   * Environment the association targets. The (tenantId, pipelineId,
   * environment) triple is the row's identity — a single pipeline can be
   * associated to the same tenant under multiple environments and each
   * row carries its own `enabled`/`activations`.
   */
  environment: string;
  enabled: boolean;
  activations: ActivationRow[];
}

export interface ScheduleRow {
  id: string;
  /** Null for system schedules (no tenant/pipeline scope). */
  tenantId: string | null;
  /** Null for system schedules. */
  pipelineId: string | null;
  /** Null for system schedules. */
  environment: string | null;
  activationLabel?: string | null;
  cron: string;
  timezone: string;
  input?: unknown;
  enabled: boolean;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  createdAt: string;
  /** Job type the scheduler enqueues. Defaults to "run_pipeline". */
  jobType?: string;
  /** Un-deletable platform schedule (retention sweep, stale-exec sweep, …). */
  system?: boolean;
  /** Display name for system schedules. */
  name?: string | null;
  /** Job-specific parameters. */
  params?: Record<string, unknown>;
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

export interface RetentionSetting {
  resource: "executions" | "usage" | "audit";
  maxCount: number | null;
  maxAgeDays: number | null;
  updatedAt: string;
  updatedBy?: string | null;
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

/** Declared input or output port on a plugin manifest. Used by the builder
 *  to render per-port handles instead of one big input/output blob. */
export interface PortInfo {
  name: string;
  description?: string;
  required?: boolean;
  schema?: JsonSchemaLike;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  category: string;
  /** Plugin contract version. v1 (default) uses config.collection; v2 takes
   *  a ResolvedDataset on input.dataset and the Builder requires a slug pin. */
  contract?: number;
  /** Modality slots this plugin reads/writes inside the bound dataset (e.g.
   *  ["vector"] for qdrant_*, ["text"] for opensearch_*, ["vector", "text"]
   *  for hybrid). Drives the picker filter + mismatch validation. */
  datasetModalities?: string[];
  description?: string;
  mode?: string;
  capabilities?: string[];
  configSchema?: JsonSchemaLike;
  secretsSchema?: JsonSchemaLike;
  inputPorts?: PortInfo[];
  outputPorts?: PortInfo[];
  /** Set when the plugin's ports are config-driven: the builder reads handle
   *  names from the node's own config (e.g. `transform`) rather than the
   *  static inputPorts/outputPorts. `inputsFrom` is a config key holding a
   *  string[] of input port names; `outputsFrom` a config key holding an
   *  object whose keys are output port names. */
  dynamicPorts?: { inputsFrom?: string; outputsFrom?: string };
  ui?: PluginUi;
}

// ---- auth / RBAC view shapes --------------------------------------------

export interface AccountUser {
  id: string;
  email: string;
  displayName?: string | null;
  status: string;
  sso?: boolean;
  createdAt?: string;
}

export interface GrantView {
  id: string;
  role: string;
  scope: string;
  tenantId?: string;
  environment?: string;
  pipelineId?: string;
}

export interface RoleView {
  name: string;
  builtin: boolean;
  description?: string | null;
  permissions: string[];
}

export interface IdentityProviderView {
  id: string;
  slug: string;
  kind: "oidc" | "saml";
  displayName: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface AuthSettings {
  signupMode: "admin_only" | "open_default_role" | "open_no_access";
  defaultRole?: string | null;
  updatedAt?: string;
}

/** Non-secret view of an API key (the hash and one-time plaintext are never
 *  part of this shape — only the non-credential lookup `prefix`). */
export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  roles: string[];
  tenantId: string | null;
  /** Environment scope (Phase 3); null when the key is tenant-wide. */
  environmentId: string | null;
  /** `*` (global), `t/<tenantId>`, or `t/<tenantId>/e/<env>`. */
  scope: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** Absolute expiration; null means "no expiration". */
  expiresAt: string | null;
  status: "active" | "revoked" | "expired";
}

/**
 * Datasets (Phase 4). A Dataset is a named, schema'd, RBAC'd corpus
 * pipelines reference by id rather than by raw collection name. See
 * docs/architecture/initial-design.md (refactor docs) for the scope
 * resolution rules.
 */
export interface DatasetView {
  id: string;
  scope: "global" | "tenant" | "environment";
  tenantId: string | null;
  environmentId: string | null;
  slug: string;
  displayName: string;
  description: string | null;
  embeddingProfile: Record<string, unknown>;
  chunkSchema: Record<string, unknown>;
  modalities: string[];
  backends: Record<string, unknown>;
  currentVersionId: string | null;
  archivedAt: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
}

export interface DatasetVersionView {
  id: string;
  datasetId: string;
  versionLabel: string;
  schemaSpec: Record<string, unknown>;
  backendCollections: Record<string, string>;
  status: "building" | "ready" | "archived";
  docCount: number | string;
  sizeBytes: number | string;
  createdAt: string;
  readyAt: string | null;
}

export interface DatasetAliasView {
  id: string;
  datasetId: string;
  alias: string;
  versionId: string;
  updatedAt: string;
  updatedBy: string | null;
}
