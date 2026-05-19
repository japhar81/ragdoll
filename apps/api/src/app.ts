/**
 * Framework-agnostic RAGdoll control-plane application.
 *
 * `createApp(deps)` returns an object with a pure `handle(request)` router.
 * NOTHING in this file imports fastify or any HTTP framework, so it can be
 * exercised directly by `node:test` functional tests with InMemory deps and
 * zero install.
 */
import { randomUUID } from "node:crypto";
import {
  redactValue,
  type ConfigDefinition,
  type ConfigValue,
  type PipelineSpec,
  type PluginRef,
  type SecretRef
} from "../../../packages/core/src/index.ts";
import {
  AuthResolver,
  enforce,
  UnauthorizedError,
  InvalidCredentialsError,
  TokenInvalidError,
  TokenExpiredError,
  type Permission,
  type Principal
} from "../../../packages/auth/src/index.ts";
import { AuthorizationError } from "../../../packages/authz/src/index.ts";
import { ConfigResolver } from "../../../packages/config-resolver/src/index.ts";
import {
  validatePipelineSpec,
  loadPipelineSpec,
  exportSpec,
  specChecksum,
  publishVersion,
  archiveVersion,
  selectDeployedVersion,
  nextVersionOnSave,
  rollbackPointer,
  resolveActivation,
  effectiveVersionId,
  ImmutableVersionError,
  VersionNotFoundError,
  ActivationResolutionError,
  type PipelineVersionRecord,
  type PipelineDeployment
} from "../../../packages/pipeline-spec/src/index.ts";
import { parseCron, nextAfter, CronParseError } from "../../../packages/cron/src/index.ts";
import {
  NotFoundError,
  ConflictError,
  InMemoryPipelineFolderRepository,
  InMemoryPipelineActivationRepository,
  InMemoryScheduleRepository,
  InMemoryTenantPipelineRepository,
  InMemoryEnvironmentRepository,
  type TenantRepository,
  type EnvironmentRepository,
  type PipelineRepository,
  type PipelineVersionRepository,
  type PipelineDeploymentRepository,
  type PipelineFolderRepository,
  type PipelineActivationRepository,
  type ScheduleRepository,
  type TenantPipelineRepository,
  type ConfigDefinitionRepository,
  type ConfigValueRepository,
  type AuditLogRepository,
  type UsageRecordRepository,
  type PluginRepository,
  type ProviderRepository,
  type DatasourceConnectionRepository,
  type VectorCollectionRepository,
  type TenantRow,
  type EnvironmentRow,
  type PipelineRow,
  type PipelineVersionRow,
  type PipelineDeploymentRow,
  type PipelineFolderRow,
  type PipelineActivationRow,
  type ScheduleRow,
  type TenantPipelineRow,
  type ConfigDefinitionRow,
  type ConfigValueRow
} from "../../../packages/db/src/index.ts";
import type {
  ExecutionStore,
  ExecutionRecord,
  ExecutionNodeRecord
} from "../../../packages/runtime/src/index.ts";
import type { SecretProvider } from "../../../packages/secrets/src/index.ts";
import { SecretNotFoundError, SecretAccessDeniedError } from "../../../packages/secrets/src/index.ts";
import type {
  PluginRegistry,
  RegisteredPlugin
} from "../../../packages/plugin-sdk/src/index.ts";
import type { ProviderRegistry } from "../../../packages/providers/src/index.ts";
import type { StructuredLogger } from "../../../packages/observability/src/index.ts";
import type { QueuePort, QueueJob } from "../../../apps/worker/src/index.ts";

/**
 * The shared queue contract specifies `QueueJob.type` includes `"run_pipeline"`
 * and `"ingest_datasource"`. The worker package's current `QueueJob` union does
 * not yet list `"run_pipeline"`, so we widen the type locally to stay
 * forward-compatible without editing the worker package.
 */
type ApiQueueJobType = QueueJob["type"] | "run_pipeline";
interface ApiQueueJob<T> extends Omit<QueueJob<T>, "type"> {
  type: ApiQueueJobType;
}

// ---------------------------------------------------------------------------
// Request / response contracts
// ---------------------------------------------------------------------------

export interface AppRequest {
  method: string;
  path: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface AppResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * An execution store the API can both write to (when seeding from a queued
 * run) and read traces from. The runtime `ExecutionStore` only defines writes;
 * for the control plane we also need read access via async query methods, so
 * the app accepts a `ReadableExecutionStore`. The InMemory store implements
 * the async methods over its in-process arrays (which it still exposes as the
 * optional sync `executions`/`nodes` for tests); a Postgres-backed reader
 * queries the executions / execution_nodes tables.
 */
export interface ReadableExecutionStore extends ExecutionStore {
  listExecutions(tenantId?: string): Promise<ExecutionRecord[]>;
  getExecution(executionId: string): Promise<ExecutionRecord | undefined>;
  listNodes(executionId: string): Promise<ExecutionNodeRecord[]>;
  /** Optional sync arrays kept by the InMemory store for tests. */
  executions?: ExecutionRecord[];
  nodes?: ExecutionNodeRecord[];
}

export interface AppDeps {
  tenants: TenantRepository;
  pipelines: PipelineRepository;
  pipelineVersions: PipelineVersionRepository;
  deployments: PipelineDeploymentRepository;
  /**
   * Org/versioning/scheduler repositories. Optional so older harnesses that
   * predate Wave B (e.g. the cross-component e2e harness) still construct a
   * valid `AppDeps`; when omitted `createApp` falls back to fresh InMemory
   * instances so the new routes remain fully functional.
   */
  pipelineFolders?: PipelineFolderRepository;
  pipelineActivations?: PipelineActivationRepository;
  schedules?: ScheduleRepository;
  tenantPipelines?: TenantPipelineRepository;
  environments?: EnvironmentRepository;
  configDefinitions: ConfigDefinitionRepository;
  configValues: ConfigValueRepository;
  auditLogs: AuditLogRepository;
  usageRecords: UsageRecordRepository;
  plugins: PluginRepository;
  providers: ProviderRepository;
  datasources: DatasourceConnectionRepository;
  vectorCollections: VectorCollectionRepository;
  executionStore: ReadableExecutionStore;
  auth: AuthResolver;
  queue: QueuePort;
  secretProvider: SecretProvider;
  pluginRegistry: PluginRegistry;
  providerRegistry: ProviderRegistry;
  logger: StructuredLogger;
  /** RAGDOLL_ENV; the dev auth fallback is rejected when this is "production". */
  env?: string;
}

export interface App {
  handle(request: AppRequest): Promise<AppResponse>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "content-type": "application/json" };

function ok(body: unknown, status = 200): AppResponse {
  return { status, body, headers: { ...JSON_HEADERS } };
}

function error(status: number, code: string, extra: Record<string, unknown> = {}): AppResponse {
  return { status, body: { error: code, ...extra }, headers: { ...JSON_HEADERS } };
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * A canonical UUID. Path params that don't match this are treated as a
 * pipeline slug/name (the web builder POSTs `/api/pipelines/<slug>/run`), so
 * they are NEVER passed into a Postgres `uuid` column query.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * True when a thrown error is a Postgres invalid-text-representation, i.e. a
 * value (often a slug) being cast to a typed column such as `uuid`. PG raises
 * SQLSTATE 22P02 with a message like
 * `invalid input syntax for type uuid: "support-rag"`. We surface these as a
 * clear 400 instead of a 500.
 */
function isInvalidTextRepresentation(e: unknown): boolean {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  if (code === "22P02") return true;
  const msg =
    e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /invalid input syntax for type uuid/i.test(msg);
}

// ---------------------------------------------------------------------------
// Routing table
// ---------------------------------------------------------------------------

type Handler = (ctx: RouteContext) => Promise<AppResponse>;

interface Route {
  method: string;
  /** Pattern segments; `:name` captures a path param. */
  segments: string[];
  handler: Handler;
}

interface RouteContext {
  request: AppRequest;
  params: Record<string, string>;
  principal: Principal;
  deps: AppDeps;
}

function compile(pattern: string): string[] {
  return pattern.split("/").filter((part) => part.length > 0);
}

function matchRoute(
  route: Route,
  method: string,
  pathSegments: string[]
): Record<string, string> | undefined {
  if (route.method !== method) return undefined;
  if (route.segments.length !== pathSegments.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < route.segments.length; i += 1) {
    const seg = route.segments[i];
    if (seg.startsWith(":")) {
      params[seg.slice(1)] = decodeURIComponent(pathSegments[i]);
    } else if (seg !== pathSegments[i]) {
      return undefined;
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// createApp
// ---------------------------------------------------------------------------

export function createApp(deps: AppDeps): App {
  const routes: Route[] = [];
  const route = (method: string, pattern: string, handler: Handler): void => {
    routes.push({ method, segments: compile(pattern), handler });
  };

  // Resolve optional Wave-B repositories to concrete instances once. Harnesses
  // that omit them get fresh InMemory stores so folder/activation/schedule
  // routes work without the caller having to wire anything new.
  const pipelineFolders: PipelineFolderRepository =
    deps.pipelineFolders ?? new InMemoryPipelineFolderRepository();
  const pipelineActivations: PipelineActivationRepository =
    deps.pipelineActivations ?? new InMemoryPipelineActivationRepository();
  const schedules: ScheduleRepository =
    deps.schedules ?? new InMemoryScheduleRepository();
  const tenantPipelines: TenantPipelineRepository =
    deps.tenantPipelines ?? new InMemoryTenantPipelineRepository();
  const environments: EnvironmentRepository =
    deps.environments ?? new InMemoryEnvironmentRepository();

  // ---- audit helper -------------------------------------------------------
  async function audit(
    ctx: RouteContext,
    action: string,
    targetType: string,
    targetId: string,
    before: unknown,
    after: unknown
  ): Promise<void> {
    await deps.auditLogs.append({
      actorId: ctx.principal.id,
      tenantId: ctx.principal.tenantId ?? null,
      pipelineId: null,
      action,
      targetType,
      targetId,
      beforeRedacted: before === undefined ? undefined : redactValue(before),
      afterRedacted: after === undefined ? undefined : redactValue(after),
      requestId: headerValue(ctx.request.headers, "x-request-id") ?? null,
      sourceIp: headerValue(ctx.request.headers, "x-forwarded-for") ?? null,
      userAgent: headerValue(ctx.request.headers, "user-agent") ?? null,
      createdAt: nowIso()
    });
  }

  /** Tenant scope from explicit header, falling back to the principal. */
  function tenantScope(ctx: RouteContext): string | undefined {
    return headerValue(ctx.request.headers, "x-tenant-id") ?? ctx.principal.tenantId;
  }

  /**
   * Record which folder a pipeline lives in so a non-empty folder delete
   * raises 409. The InMemory folder repo exposes a `trackPipelineFolder`
   * hook; a Postgres-backed repo derives emptiness from the pipelines table
   * via its own FK so the call is a no-op there.
   */
  function trackFolder(pipelineId: string, folderId: string | null): void {
    const repo = pipelineFolders as unknown as {
      trackPipelineFolder?: (p: string, f: string | null) => void;
    };
    repo.trackPipelineFolder?.(pipelineId, folderId);
  }

  /**
   * Resolve a pipeline `:id` path param that may be EITHER a UUID or a
   * slug/name. The web builder POSTs `/api/pipelines/<slug>/run`, so a route
   * that blindly fed `:id` into a Postgres `uuid` query would throw
   * `invalid input syntax for type uuid` and surface as a 500.
   *
   * Strategy: if the param looks like a UUID, try `pipelines.get` first; if
   * that misses (or the param is not a UUID) fall back to
   * `pipelines.findBySlug`. A non-UUID is never passed to `.get` (which would
   * hit a uuid column). Returns the resolved row, or an `error(404,
   * "pipeline_not_found")` response the caller should return as-is. Callers
   * MUST use the returned `pipeline.id` (the real UUID) for every downstream
   * lookup (versions/deployments/activations).
   */
  async function resolvePipelineRef(
    ref: string
  ): Promise<PipelineRow | AppResponse> {
    let pipeline: PipelineRow | undefined;
    if (isUuid(ref)) {
      pipeline = await deps.pipelines.get(ref);
    }
    if (!pipeline) {
      pipeline = await deps.pipelines.findBySlug(ref);
    }
    if (!pipeline) {
      return error(404, "pipeline_not_found", {
        message: `no pipeline with id or slug '${ref}'`
      });
    }
    return pipeline;
  }

  /** Narrow the union returned by `resolvePipelineRef`. */
  function isAppResponse(v: PipelineRow | AppResponse): v is AppResponse {
    return (
      typeof (v as AppResponse).status === "number" &&
      "headers" in (v as AppResponse)
    );
  }

  // ---- health -------------------------------------------------------------
  route("GET", "/healthz", async () => ok({ ok: true, status: "alive" }));
  route("GET", "/readyz", async () => ok({ ok: true, status: "ready" }));

  // ---- tenants ------------------------------------------------------------
  route("GET", "/api/tenants", async (ctx) => {
    enforce(ctx.principal, "audit:view");
    const all = await deps.tenants.list();
    const scoped = ctx.principal.roles.includes("platform_admin")
      ? all
      : all.filter((tenant) => tenant.id === ctx.principal.tenantId);
    return ok({ tenants: scoped });
  });

  route("GET", "/api/tenants/:id", async (ctx) => {
    enforce(ctx.principal, "audit:view", { tenantId: ctx.params.id });
    const tenant = await deps.tenants.get(ctx.params.id);
    if (!tenant) return error(404, "not_found");
    if (
      !ctx.principal.roles.includes("platform_admin") &&
      ctx.principal.tenantId !== tenant.id
    ) {
      return error(403, "forbidden");
    }
    return ok({ tenant });
  });

  route("POST", "/api/tenants", async (ctx) => {
    enforce(ctx.principal, "config:edit_global");
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.slug !== "string" || typeof body.name !== "string") {
      return error(422, "validation_failed", {
        issues: [{ path: "slug|name", message: "slug and name are required strings" }]
      });
    }
    const existing = await deps.tenants.findBySlug(body.slug);
    if (existing) return error(409, "conflict", { message: "slug already exists" });
    const row: TenantRow = {
      id: typeof body.id === "string" ? body.id : randomUUID(),
      slug: body.slug,
      name: body.name,
      status: typeof body.status === "string" ? body.status : "active",
      metadata: isObject(body.metadata) ? body.metadata : {},
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    const created = await deps.tenants.create(row);
    await audit(ctx, "tenant.create", "tenant", created.id, undefined, created);
    return ok({ tenant: created }, 201);
  });

  route("PUT", "/api/tenants/:id", async (ctx) => {
    enforce(ctx.principal, "config:edit_global");
    const before = await deps.tenants.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    const body = ctx.request.body;
    if (!isObject(body)) return error(422, "validation_failed", { issues: [] });
    const patch: Partial<TenantRow> = { updatedAt: nowIso() };
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.status === "string") patch.status = body.status;
    if (isObject(body.metadata)) patch.metadata = body.metadata;
    const updated = await deps.tenants.update(ctx.params.id, patch);
    await audit(ctx, "tenant.update", "tenant", updated.id, before, updated);
    return ok({ tenant: updated });
  });

  route("DELETE", "/api/tenants/:id", async (ctx) => {
    enforce(ctx.principal, "config:edit_global");
    const before = await deps.tenants.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    await deps.tenants.delete(ctx.params.id);
    await audit(ctx, "tenant.delete", "tenant", ctx.params.id, before, undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  // ---- tenant environments ------------------------------------------------
  // Per-tenant environment catalog. Each row is identified by its uuid id;
  // names are not unique (a tenant may keep its own "staging"). This feeds
  // every environment picker in the web app and is managed from the tenant
  // screen. `environment` stays free text on the rest of the stack.
  route("GET", "/api/tenants/:id/environments", async (ctx) => {
    enforce(ctx.principal, "audit:view", { tenantId: ctx.params.id });
    if (
      !ctx.principal.roles.includes("platform_admin") &&
      ctx.principal.tenantId !== ctx.params.id
    ) {
      return error(403, "forbidden");
    }
    return ok({ environments: await environments.listByTenant(ctx.params.id) });
  });

  route("POST", "/api/tenants/:id/environments", async (ctx) => {
    enforce(ctx.principal, "config:edit_global");
    const tenant = await deps.tenants.get(ctx.params.id);
    if (!tenant) {
      return error(404, "not_found", { message: "tenant not found" });
    }
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.name !== "string" || !body.name.trim()) {
      return error(422, "validation_failed", {
        issues: [{ path: "name", message: "name is required" }]
      });
    }
    const row: EnvironmentRow = {
      id: typeof body.id === "string" ? body.id : randomUUID(),
      tenantId: ctx.params.id,
      name: body.name.trim(),
      description:
        typeof body.description === "string" ? body.description : null,
      isProduction: body.isProduction === true,
      createdAt: nowIso()
    };
    const created = await environments.create(row);
    await audit(
      ctx,
      "environment.create",
      "environment",
      created.id,
      undefined,
      created
    );
    return ok({ environment: created }, 201);
  });

  route("PUT", "/api/tenants/:id/environments/:envId", async (ctx) => {
    enforce(ctx.principal, "config:edit_global");
    const before = await environments.get(ctx.params.envId);
    if (!before || before.tenantId !== ctx.params.id) {
      return error(404, "not_found");
    }
    const body = ctx.request.body;
    if (!isObject(body)) return error(422, "validation_failed", { issues: [] });
    const patch: Partial<EnvironmentRow> = {};
    if (typeof body.name === "string" && body.name.trim()) {
      patch.name = body.name.trim();
    }
    if (typeof body.description === "string" || body.description === null) {
      patch.description = body.description as string | null;
    }
    if (typeof body.isProduction === "boolean") {
      patch.isProduction = body.isProduction;
    }
    const updated = await environments.update(ctx.params.envId, patch);
    await audit(
      ctx,
      "environment.update",
      "environment",
      updated.id,
      before,
      updated
    );
    return ok({ environment: updated });
  });

  route("DELETE", "/api/tenants/:id/environments/:envId", async (ctx) => {
    enforce(ctx.principal, "config:edit_global");
    const before = await environments.get(ctx.params.envId);
    if (!before || before.tenantId !== ctx.params.id) {
      return error(404, "not_found");
    }
    await environments.delete(ctx.params.envId);
    await audit(
      ctx,
      "environment.delete",
      "environment",
      ctx.params.envId,
      before,
      undefined
    );
    return { status: 204, body: undefined, headers: {} };
  });

  // ---- pipelines ----------------------------------------------------------
  route("GET", "/api/pipelines", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    return ok({ pipelines: await deps.pipelines.list() });
  });

  route("GET", "/api/pipelines/:id", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const resolved = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(resolved)) return resolved;
    return ok({ pipeline: resolved });
  });

  route("POST", "/api/pipelines", async (ctx) => {
    enforce(ctx.principal, "pipeline:create");
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.slug !== "string" || typeof body.name !== "string") {
      return error(422, "validation_failed", {
        issues: [{ path: "slug|name", message: "slug and name are required strings" }]
      });
    }
    const existing = await deps.pipelines.findBySlug(body.slug);
    if (existing) return error(409, "conflict", { message: "slug already exists" });
    const folderId =
      typeof body.folderId === "string" ? body.folderId : null;
    if (folderId !== null && !(await pipelineFolders.get(folderId))) {
      return error(404, "not_found", { message: "folder not found" });
    }
    const row: PipelineRow = {
      id: typeof body.id === "string" ? body.id : randomUUID(),
      slug: body.slug,
      name: body.name,
      description: typeof body.description === "string" ? body.description : null,
      labels: isObject(body.labels) ? (body.labels as Record<string, string>) : {},
      folderId,
      latestVersionId: null,
      createdBy: ctx.principal.id,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    const created = await deps.pipelines.create(row);
    if (folderId !== null) trackFolder(created.id, folderId);
    await audit(ctx, "pipeline.create", "pipeline", created.id, undefined, created);
    return ok({ pipeline: created }, 201);
  });

  route("PUT", "/api/pipelines/:id", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const before = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(before)) return before;
    const body = ctx.request.body;
    if (!isObject(body)) return error(422, "validation_failed", { issues: [] });
    const patch: Partial<PipelineRow> = { updatedAt: nowIso() };
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.description === "string") patch.description = body.description;
    if (isObject(body.labels)) patch.labels = body.labels as Record<string, string>;
    const updated = await deps.pipelines.update(before.id, patch);
    await audit(ctx, "pipeline.update", "pipeline", updated.id, before, updated);
    return ok({ pipeline: updated });
  });

  route("DELETE", "/api/pipelines/:id", async (ctx) => {
    enforce(ctx.principal, "pipeline:delete");
    const before = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(before)) return before;
    await deps.pipelines.delete(before.id);
    await audit(ctx, "pipeline.delete", "pipeline", before.id, before, undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  // ---- pipeline folders ---------------------------------------------------
  route("GET", "/api/folders", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    return ok({ folders: await pipelineFolders.tree() });
  });

  route("POST", "/api/folders", async (ctx) => {
    enforce(ctx.principal, "pipeline:create");
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.name !== "string" || body.name.length === 0) {
      return error(422, "validation_failed", {
        issues: [{ path: "name", message: "name is required" }]
      });
    }
    const parentId = typeof body.parentId === "string" ? body.parentId : null;
    if (parentId !== null && !(await pipelineFolders.get(parentId))) {
      return error(404, "not_found", { message: "parent folder not found" });
    }
    const row: PipelineFolderRow = {
      id: typeof body.id === "string" ? body.id : randomUUID(),
      parentId,
      name: body.name,
      createdAt: nowIso()
    };
    const created = await pipelineFolders.create(row);
    await audit(ctx, "pipeline_folder.create", "pipeline_folder", created.id, undefined, created);
    return ok({ folder: created }, 201);
  });

  route("PUT", "/api/folders/:id", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const before = await pipelineFolders.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    const body = ctx.request.body;
    if (!isObject(body)) return error(422, "validation_failed", { issues: [] });
    let updated = before;
    if (typeof body.name === "string" && body.name.length > 0) {
      updated = await pipelineFolders.rename(ctx.params.id, body.name);
    }
    if ("parentId" in body) {
      const parentId =
        typeof body.parentId === "string" ? body.parentId : null;
      if (parentId === ctx.params.id) {
        return error(422, "validation_failed", {
          issues: [{ path: "parentId", message: "folder cannot be its own parent" }]
        });
      }
      if (parentId !== null && !(await pipelineFolders.get(parentId))) {
        return error(404, "not_found", { message: "parent folder not found" });
      }
      updated = await pipelineFolders.update(ctx.params.id, {
        parentId
      } as Partial<PipelineFolderRow>);
    }
    await audit(ctx, "pipeline_folder.update", "pipeline_folder", updated.id, before, updated);
    return ok({ folder: updated });
  });

  route("DELETE", "/api/folders/:id", async (ctx) => {
    enforce(ctx.principal, "pipeline:delete");
    const before = await pipelineFolders.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    // Repo throws ConflictError when the folder still has children/pipelines;
    // the global handler maps that to 409 conflict.
    await pipelineFolders.delete(ctx.params.id);
    await audit(ctx, "pipeline_folder.delete", "pipeline_folder", ctx.params.id, before, undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  route("PUT", "/api/pipelines/:id/folder", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const body = ctx.request.body;
    if (!isObject(body) || !("folderId" in body)) {
      return error(422, "validation_failed", {
        issues: [{ path: "folderId", message: "folderId is required (string or null)" }]
      });
    }
    const folderId = typeof body.folderId === "string" ? body.folderId : null;
    if (folderId !== null && !(await pipelineFolders.get(folderId))) {
      return error(404, "not_found", { message: "folder not found" });
    }
    const updated = await deps.pipelines.setFolder(pipeline.id, folderId);
    trackFolder(pipeline.id, folderId);
    await audit(ctx, "pipeline.set_folder", "pipeline", updated.id, pipeline, updated);
    return ok({ pipeline: updated });
  });

  // ---- pipeline spec validation ------------------------------------------
  route("POST", "/api/pipelines/validate", async (ctx) => {
    enforce(ctx.principal, "pipeline:create");
    const spec = parseSpec(ctx.request.body);
    if (!spec) return error(422, "validation_failed", { issues: [{ message: "invalid spec" }] });
    return ok(validatePipelineSpec(spec, deps.pluginRegistry));
  });

  // ---- pipeline versions --------------------------------------------------
  route("GET", "/api/pipelines/:id/versions", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const rows = await deps.pipelineVersions.listByPipeline(pipeline.id);
    const latestId = pipeline.latestVersionId ?? null;
    const versions = rows.map((row) => ({
      ...row,
      parentVersionId: row.parentVersionId ?? null,
      isLatest: row.id === latestId
    }));
    return ok({ versions, latestVersionId: latestId });
  });

  route("POST", "/api/pipelines/:id/versions", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const pipelineId = pipeline.id;
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.version !== "string") {
      return error(422, "validation_failed", {
        issues: [{ path: "version", message: "version is required" }]
      });
    }
    const spec = parseSpec(body.spec);
    if (!spec) {
      return error(422, "validation_failed", {
        issues: [{ path: "spec", message: "spec is missing or invalid" }]
      });
    }
    const validation = validatePipelineSpec(spec, deps.pluginRegistry);
    if (!validation.valid) {
      return error(422, "validation_failed", { issues: validation.errors });
    }

    const publish = body.publish === true;
    const existingRows = await deps.pipelineVersions.listByPipeline(pipelineId);
    const existingRecords: PipelineVersionRecord[] = existingRows.map((row) => ({
      pipelineId: row.pipelineId,
      version: row.version,
      status: row.status,
      spec: row.spec as PipelineSpec,
      checksum: row.checksum,
      createdAt: row.createdAt,
      publishedAt: row.publishedAt ?? undefined
    }));

    if (publish) {
      let record: PipelineVersionRecord;
      try {
        record = publishVersion(existingRecords, spec, body.version, {
          pipelineId
        });
      } catch (e) {
        if (e instanceof ImmutableVersionError) {
          return error(409, "immutable_version", { message: e.message });
        }
        throw e;
      }
      const priorRow = existingRows.find(
        (row) => row.version === body.version && row.status === "published"
      );
      if (priorRow) {
        // Idempotent republish of identical content.
        return ok({ version: priorRow }, 200);
      }
      const versionRow: PipelineVersionRow = {
        id: randomUUID(),
        pipelineId,
        version: record.version,
        status: "published",
        spec: record.spec,
        checksum: record.checksum,
        createdBy: ctx.principal.id,
        createdAt: record.createdAt,
        publishedAt: record.publishedAt ?? nowIso()
      };
      const created = await deps.pipelineVersions.create(versionRow);
      await audit(ctx, "pipeline_version.publish", "pipeline_version", created.id, undefined, {
        version: created.version,
        checksum: created.checksum
      });
      return ok({ version: created }, 201);
    }

    // Draft save (mutable). Overwrite an existing draft with the same version.
    const existingDraft = existingRows.find(
      (row) => row.version === body.version && row.status === "draft"
    );
    if (existingDraft) {
      const updated = await deps.pipelineVersions.update(existingDraft.id, {
        spec,
        checksum: specChecksum(spec)
      });
      await audit(ctx, "pipeline_version.save_draft", "pipeline_version", updated.id, existingDraft, {
        version: updated.version
      });
      return ok({ version: updated }, 200);
    }
    const blockingPublished = existingRows.find(
      (row) => row.version === body.version && row.status === "published"
    );
    if (blockingPublished) {
      return error(409, "immutable_version", {
        message: `version ${body.version} is already published`
      });
    }
    const draftRow: PipelineVersionRow = {
      id: randomUUID(),
      pipelineId,
      version: body.version,
      status: "draft",
      spec,
      checksum: specChecksum(spec),
      createdBy: ctx.principal.id,
      createdAt: nowIso(),
      publishedAt: null
    };
    const created = await deps.pipelineVersions.create(draftRow);
    await audit(ctx, "pipeline_version.save_draft", "pipeline_version", created.id, undefined, {
      version: created.version
    });
    return ok({ version: created }, 201);
  });

  // ---- save (auto-version) + rollback ------------------------------------
  route("POST", "/api/pipelines/:id/save", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const pipelineId = pipeline.id;
    const body = ctx.request.body;
    if (!isObject(body)) {
      return error(422, "validation_failed", { issues: [{ message: "body required" }] });
    }
    const spec = parseSpec(body.spec);
    if (!spec) {
      return error(422, "validation_failed", {
        issues: [{ path: "spec", message: "spec is missing or invalid" }]
      });
    }
    const validation = validatePipelineSpec(spec, deps.pluginRegistry);
    if (!validation.valid) {
      return error(422, "validation_failed", { issues: validation.errors });
    }
    const level =
      body.level === "minor" || body.level === "major" || body.level === "patch"
        ? (body.level as "patch" | "minor" | "major")
        : "patch";

    const rows = await deps.pipelineVersions.listByPipeline(pipelineId);
    const toRecord = (row: PipelineVersionRow): PipelineVersionRecord => ({
      id: row.id,
      pipelineId: row.pipelineId,
      version: row.version,
      status: row.status,
      spec: row.spec as PipelineSpec,
      checksum: row.checksum,
      parentVersionId: row.parentVersionId ?? null,
      createdAt: row.createdAt,
      publishedAt: row.publishedAt ?? undefined
    });
    const existingVersions = rows.map(toRecord);
    const latestRow = pipeline.latestVersionId
      ? rows.find((row) => row.id === pipeline.latestVersionId)
      : undefined;

    const result = nextVersionOnSave({
      existingVersions,
      latest: latestRow ? toRecord(latestRow) : undefined,
      spec,
      level,
      pipelineId
    });

    if (result.kind === "idempotent") {
      // Identical spec as the current latest: no new row, pointer unchanged.
      const unchanged = rows.find((row) => row.id === result.version.id);
      return ok({ version: unchanged, created: false });
    }

    const versionRow: PipelineVersionRow = {
      id: randomUUID(),
      pipelineId,
      version: result.record.version,
      status: "published",
      spec: result.record.spec,
      checksum: result.record.checksum,
      parentVersionId: result.record.parentVersionId ?? null,
      createdBy: ctx.principal.id,
      createdAt: result.record.createdAt,
      publishedAt: result.record.publishedAt ?? nowIso()
    };
    const created = await deps.pipelineVersions.create(versionRow);
    const updatedPipeline = await deps.pipelines.setLatestVersion(
      pipelineId,
      created.id
    );
    await audit(ctx, "pipeline_version.save", "pipeline_version", created.id, undefined, {
      version: created.version,
      checksum: created.checksum,
      parentVersionId: created.parentVersionId,
      latestVersionId: updatedPipeline.latestVersionId
    });
    return ok({ version: created, created: true }, 201);
  });

  route("POST", "/api/pipelines/:id/rollback", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const pipelineId = pipeline.id;
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.versionId !== "string") {
      return error(422, "validation_failed", {
        issues: [{ path: "versionId", message: "versionId is required" }]
      });
    }
    const rows = await deps.pipelineVersions.listByPipeline(pipelineId);
    let targetId: string;
    try {
      targetId = rollbackPointer(
        rows.map((row) => ({
          id: row.id,
          pipelineId: row.pipelineId,
          version: row.version,
          status: row.status,
          spec: row.spec as PipelineSpec,
          checksum: row.checksum,
          createdAt: row.createdAt
        })),
        body.versionId
      );
    } catch (e) {
      if (e instanceof VersionNotFoundError) {
        return error(404, "not_found", { message: e.message });
      }
      throw e;
    }
    const updated = await deps.pipelines.setLatestVersion(pipelineId, targetId);
    await audit(ctx, "pipeline_version.rollback", "pipeline", pipelineId, pipeline, {
      latestVersionId: updated.latestVersionId
    });
    return ok({ pipeline: updated, latestVersionId: updated.latestVersionId });
  });

  route("POST", "/api/pipelines/:id/versions/:version/archive", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const found = await deps.pipelineVersions.findByVersion(pipeline.id, ctx.params.version);
    if (!found) return error(404, "not_found");
    const archived = archiveVersion({
      pipelineId: found.pipelineId,
      version: found.version,
      status: found.status,
      spec: found.spec as PipelineSpec,
      checksum: found.checksum,
      createdAt: found.createdAt,
      publishedAt: found.publishedAt ?? undefined
    });
    const updated = await deps.pipelineVersions.update(found.id, { status: archived.status });
    await audit(ctx, "pipeline_version.archive", "pipeline_version", updated.id, found, updated);
    return ok({ version: updated });
  });

  route("GET", "/api/pipelines/:id/versions/:version/export", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const found = await deps.pipelineVersions.findByVersion(pipeline.id, ctx.params.version);
    if (!found) return error(404, "not_found");
    const format = ctx.request.query.format === "yaml" ? "yaml" : "json";
    const text = exportSpec(found.spec as PipelineSpec, format);
    return {
      status: 200,
      body: text,
      headers: { "content-type": format === "yaml" ? "application/yaml" : "application/json" }
    };
  });

  // ---- deployments --------------------------------------------------------
  route("GET", "/api/pipelines/:id/deployments", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    return ok({ deployments: await deps.deployments.listByPipeline(pipeline.id) });
  });

  route("POST", "/api/pipelines/:id/deployments", async (ctx) => {
    enforce(ctx.principal, "pipeline:deploy");
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const pipelineId = pipeline.id;
    const body = ctx.request.body;
    if (
      !isObject(body) ||
      typeof body.version !== "string" ||
      typeof body.environment !== "string"
    ) {
      return error(422, "validation_failed", {
        issues: [{ message: "version and environment are required" }]
      });
    }
    const version = await deps.pipelineVersions.findByVersion(pipelineId, body.version);
    if (!version) return error(404, "not_found", { message: "pipeline version not found" });
    if (version.status !== "published") {
      return error(422, "validation_failed", {
        issues: [{ message: "only published versions can be deployed" }]
      });
    }
    const deploymentRow: PipelineDeploymentRow = {
      id: randomUUID(),
      pipelineId,
      pipelineVersionId: version.id,
      environment: body.environment,
      tenantId: typeof body.tenantId === "string" ? body.tenantId : null,
      status: "active",
      deployedBy: ctx.principal.id,
      deployedAt: nowIso()
    };
    const created = await deps.deployments.create(deploymentRow);
    await audit(ctx, "pipeline.deploy", "pipeline_deployment", created.id, undefined, created);
    return ok({ deployment: created }, 201);
  });

  // ---- tenant <-> pipeline associations + activations ---------------------
  function activationEnv(ctx: RouteContext, body: unknown): string {
    if (isObject(body) && typeof body.environment === "string" && body.environment) {
      return body.environment;
    }
    return ctx.request.query.environment ?? "dev";
  }

  function projectActivation(
    row: PipelineActivationRow,
    pipelineLatestVersionId: string | null
  ): Record<string, unknown> {
    let effective: string | null = null;
    try {
      effective = effectiveVersionId(
        { trackLatest: row.trackLatest, pipelineVersionId: row.pipelineVersionId ?? null },
        pipelineLatestVersionId
      );
    } catch {
      effective = null;
    }
    return {
      id: row.id,
      label: row.label,
      environment: row.environment,
      pipelineVersionId: row.pipelineVersionId ?? null,
      trackLatest: row.trackLatest,
      enabled: row.enabled,
      effectiveVersionId: effective
    };
  }

  route("GET", "/api/tenants/:id/pipelines", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs", { tenantId: ctx.params.id });
    if (
      !ctx.principal.roles.includes("platform_admin") &&
      ctx.principal.tenantId &&
      ctx.principal.tenantId !== ctx.params.id
    ) {
      return error(403, "forbidden");
    }
    const associations = await tenantPipelines.listByTenant(ctx.params.id);
    const activations = await pipelineActivations.listByTenant(ctx.params.id);
    const byPipeline = new Map<string, PipelineActivationRow[]>();
    for (const act of activations) {
      const bucket = byPipeline.get(act.pipelineId) ?? [];
      bucket.push(act);
      byPipeline.set(act.pipelineId, bucket);
    }
    const pipelineIds = new Set<string>([
      ...associations.map((a) => a.pipelineId),
      ...activations.map((a) => a.pipelineId)
    ]);
    const out: Array<Record<string, unknown>> = [];
    for (const pipelineId of pipelineIds) {
      const pipeline = await deps.pipelines.get(pipelineId);
      const assoc = associations.find((a) => a.pipelineId === pipelineId);
      out.push({
        pipelineId,
        enabled: assoc ? assoc.enabled : false,
        activations: (byPipeline.get(pipelineId) ?? []).map((row) =>
          projectActivation(row, pipeline?.latestVersionId ?? null)
        )
      });
    }
    return ok({ pipelines: out });
  });

  route("POST", "/api/tenants/:id/pipelines", async (ctx) => {
    enforce(ctx.principal, "config:edit_tenant", { tenantId: ctx.params.id });
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.pipelineId !== "string") {
      return error(422, "validation_failed", {
        issues: [{ path: "pipelineId", message: "pipelineId is required" }]
      });
    }
    const pipeline = await deps.pipelines.get(body.pipelineId);
    if (!pipeline) return error(404, "not_found", { message: "pipeline not found" });
    const environment =
      typeof body.environment === "string" && body.environment
        ? body.environment
        : "dev";
    const row: TenantPipelineRow = {
      tenantId: ctx.params.id,
      pipelineId: body.pipelineId,
      environment,
      enabled: true,
      vectorIsolation: isObject(body.vectorIsolation) ? body.vectorIsolation : {},
      providerPolicy: isObject(body.providerPolicy) ? body.providerPolicy : {},
      rateLimitPolicy: isObject(body.rateLimitPolicy) ? body.rateLimitPolicy : {},
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    const saved = await tenantPipelines.upsert(row);
    await audit(ctx, "tenant_pipeline.associate", "tenant_pipeline", `${ctx.params.id}:${body.pipelineId}`, undefined, saved);
    return ok({ association: saved }, 201);
  });

  route("PATCH", "/api/tenants/:id/pipelines/:pid", async (ctx) => {
    enforce(ctx.principal, "config:edit_tenant", { tenantId: ctx.params.id });
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.enabled !== "boolean") {
      return error(422, "validation_failed", {
        issues: [{ path: "enabled", message: "enabled (boolean) is required" }]
      });
    }
    const environment =
      typeof body.environment === "string" && body.environment
        ? body.environment
        : "dev";
    const existing = await tenantPipelines.get({
      tenantId: ctx.params.id,
      pipelineId: ctx.params.pid,
      environment
    });
    if (!existing) return error(404, "not_found", { message: "association not found" });
    const saved = await tenantPipelines.upsert({
      ...existing,
      enabled: body.enabled,
      updatedAt: nowIso()
    });
    await audit(ctx, "tenant_pipeline.update", "tenant_pipeline", `${ctx.params.id}:${ctx.params.pid}`, existing, saved);
    return ok({ association: saved });
  });

  route("GET", "/api/tenants/:id/pipelines/:pid/activations", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs", { tenantId: ctx.params.id });
    if (
      !ctx.principal.roles.includes("platform_admin") &&
      ctx.principal.tenantId &&
      ctx.principal.tenantId !== ctx.params.id
    ) {
      return error(403, "forbidden");
    }
    const pipeline = await resolvePipelineRef(ctx.params.pid);
    if (isAppResponse(pipeline)) return pipeline;
    const rows = (
      await pipelineActivations.listByTenant(ctx.params.id)
    ).filter((row) => row.pipelineId === pipeline.id);
    return ok({
      activations: rows.map((row) =>
        projectActivation(row, pipeline.latestVersionId ?? null)
      )
    });
  });

  route("POST", "/api/tenants/:id/pipelines/:pid/activations", async (ctx) => {
    enforce(ctx.principal, "config:edit_tenant", { tenantId: ctx.params.id });
    const pipeline = await resolvePipelineRef(ctx.params.pid);
    if (isAppResponse(pipeline)) return pipeline;
    const body = ctx.request.body;
    if (
      !isObject(body) ||
      typeof body.label !== "string" ||
      body.label.length === 0 ||
      typeof body.environment !== "string" ||
      body.environment.length === 0
    ) {
      return error(422, "validation_failed", {
        issues: [{ message: "label and environment are required" }]
      });
    }
    const trackLatest = body.trackLatest === true;
    if (
      !trackLatest &&
      (typeof body.pipelineVersionId !== "string" || body.pipelineVersionId.length === 0)
    ) {
      return error(422, "validation_failed", {
        issues: [
          { message: "a pinned activation requires pipelineVersionId or trackLatest:true" }
        ]
      });
    }
    const row: PipelineActivationRow = {
      id: typeof body.id === "string" ? body.id : randomUUID(),
      tenantId: ctx.params.id,
      pipelineId: pipeline.id,
      environment: body.environment,
      label: body.label,
      pipelineVersionId:
        typeof body.pipelineVersionId === "string" ? body.pipelineVersionId : null,
      trackLatest,
      enabled: body.enabled !== false,
      createdAt: nowIso()
    };
    // Repo throws ConflictError on a duplicate (tenant,pipeline,env,label);
    // the global handler maps it to 409 conflict.
    const created = await pipelineActivations.create(row);
    await audit(ctx, "pipeline_activation.create", "pipeline_activation", created.id, undefined, created);
    return ok(
      { activation: projectActivation(created, pipeline.latestVersionId ?? null) },
      201
    );
  });

  route(
    "PATCH",
    "/api/tenants/:id/pipelines/:pid/activations/:aid",
    async (ctx) => {
      enforce(ctx.principal, "config:edit_tenant", { tenantId: ctx.params.id });
      const pipeline = await resolvePipelineRef(ctx.params.pid);
      if (isAppResponse(pipeline)) return pipeline;
      const before = await pipelineActivations.get(ctx.params.aid);
      if (
        !before ||
        before.tenantId !== ctx.params.id ||
        before.pipelineId !== pipeline.id
      ) {
        return error(404, "not_found");
      }
      const body = ctx.request.body;
      if (!isObject(body)) return error(422, "validation_failed", { issues: [] });
      const patch: Partial<PipelineActivationRow> = {};
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (typeof body.trackLatest === "boolean") patch.trackLatest = body.trackLatest;
      if (typeof body.label === "string" && body.label.length > 0) {
        patch.label = body.label;
      }
      if ("pipelineVersionId" in body) {
        patch.pipelineVersionId =
          typeof body.pipelineVersionId === "string"
            ? body.pipelineVersionId
            : null;
      }
      const updated = await pipelineActivations.update(ctx.params.aid, patch);
      await audit(ctx, "pipeline_activation.update", "pipeline_activation", updated.id, before, updated);
      return ok({
        activation: projectActivation(updated, pipeline.latestVersionId ?? null)
      });
    }
  );

  route(
    "DELETE",
    "/api/tenants/:id/pipelines/:pid/activations/:aid",
    async (ctx) => {
      enforce(ctx.principal, "config:edit_tenant", { tenantId: ctx.params.id });
      const pipeline = await resolvePipelineRef(ctx.params.pid);
      if (isAppResponse(pipeline)) return pipeline;
      const before = await pipelineActivations.get(ctx.params.aid);
      if (
        !before ||
        before.tenantId !== ctx.params.id ||
        before.pipelineId !== pipeline.id
      ) {
        return error(404, "not_found");
      }
      await pipelineActivations.delete(ctx.params.aid);
      await audit(ctx, "pipeline_activation.delete", "pipeline_activation", ctx.params.aid, before, undefined);
      return { status: 204, body: undefined, headers: {} };
    }
  );

  // ---- schedules ----------------------------------------------------------
  function scheduleNextRun(cron: string): { ok: true; next: string } | { ok: false } {
    try {
      parseCron(cron);
    } catch (e) {
      if (e instanceof CronParseError) return { ok: false };
      throw e;
    }
    return { ok: true, next: nextAfter(cron, new Date()).toISOString() };
  }

  route("GET", "/api/schedules", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    let rows = await schedules.list();
    const tenant = ctx.request.query.tenant;
    const pipeline = ctx.request.query.pipeline;
    if (
      !ctx.principal.roles.includes("platform_admin") &&
      ctx.principal.tenantId
    ) {
      rows = rows.filter((row) => row.tenantId === ctx.principal.tenantId);
    }
    if (tenant) rows = rows.filter((row) => row.tenantId === tenant);
    if (pipeline) rows = rows.filter((row) => row.pipelineId === pipeline);
    return ok({ schedules: rows });
  });

  route("POST", "/api/schedules", async (ctx) => {
    const body = ctx.request.body;
    if (
      !isObject(body) ||
      typeof body.tenantId !== "string" ||
      typeof body.pipelineId !== "string" ||
      typeof body.environment !== "string" ||
      typeof body.cron !== "string"
    ) {
      return error(422, "validation_failed", {
        issues: [
          { message: "tenantId, pipelineId, environment and cron are required" }
        ]
      });
    }
    enforce(ctx.principal, "config:edit_tenant", { tenantId: body.tenantId });
    const next = scheduleNextRun(body.cron);
    if (!next.ok) {
      return error(422, "validation_failed", {
        issues: [{ path: "cron", message: `invalid cron expression: ${body.cron}` }]
      });
    }
    const row: ScheduleRow = {
      id: typeof body.id === "string" ? body.id : randomUUID(),
      tenantId: body.tenantId,
      pipelineId: body.pipelineId,
      environment: body.environment,
      activationLabel:
        typeof body.activationLabel === "string" ? body.activationLabel : null,
      cron: body.cron,
      timezone: typeof body.timezone === "string" ? body.timezone : "UTC",
      input: isObject(body.input) ? body.input : {},
      enabled: body.enabled !== false,
      lastRunAt: null,
      nextRunAt: next.next,
      createdAt: nowIso()
    };
    const created = await schedules.create(row);
    await audit(ctx, "schedule.create", "schedule", created.id, undefined, created);
    return ok({ schedule: created }, 201);
  });

  route("PUT", "/api/schedules/:id", async (ctx) => {
    const before = await schedules.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    enforce(ctx.principal, "config:edit_tenant", { tenantId: before.tenantId });
    const body = ctx.request.body;
    if (!isObject(body)) return error(422, "validation_failed", { issues: [] });
    const patch: Partial<ScheduleRow> = {};
    if (typeof body.environment === "string") patch.environment = body.environment;
    if ("activationLabel" in body) {
      patch.activationLabel =
        typeof body.activationLabel === "string" ? body.activationLabel : null;
    }
    if (typeof body.timezone === "string") patch.timezone = body.timezone;
    if (isObject(body.input)) patch.input = body.input;
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.cron === "string") {
      const next = scheduleNextRun(body.cron);
      if (!next.ok) {
        return error(422, "validation_failed", {
          issues: [{ path: "cron", message: `invalid cron expression: ${body.cron}` }]
        });
      }
      patch.cron = body.cron;
      patch.nextRunAt = next.next;
    }
    const updated = await schedules.update(ctx.params.id, patch);
    await audit(ctx, "schedule.update", "schedule", updated.id, before, updated);
    return ok({ schedule: updated });
  });

  route("PATCH", "/api/schedules/:id", async (ctx) => {
    const before = await schedules.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    enforce(ctx.principal, "config:edit_tenant", { tenantId: before.tenantId });
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.enabled !== "boolean") {
      return error(422, "validation_failed", {
        issues: [{ path: "enabled", message: "enabled (boolean) is required" }]
      });
    }
    const updated = await schedules.update(ctx.params.id, { enabled: body.enabled });
    await audit(ctx, "schedule.toggle", "schedule", updated.id, before, updated);
    return ok({ schedule: updated });
  });

  route("DELETE", "/api/schedules/:id", async (ctx) => {
    const before = await schedules.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    enforce(ctx.principal, "config:edit_tenant", { tenantId: before.tenantId });
    await schedules.delete(ctx.params.id);
    await audit(ctx, "schedule.delete", "schedule", ctx.params.id, before, undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  // ---- config definitions -------------------------------------------------
  route("GET", "/api/config/definitions", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    return ok({ definitions: await deps.configDefinitions.list() });
  });

  route("PUT", "/api/config/definitions/:key", async (ctx) => {
    enforce(ctx.principal, "config:edit_global");
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.type !== "string") {
      return error(422, "validation_failed", {
        issues: [{ path: "type", message: "type is required" }]
      });
    }
    const before = await deps.configDefinitions.get(ctx.params.key);
    const row: ConfigDefinitionRow = {
      key: ctx.params.key,
      type: body.type as ConfigDefinitionRow["type"],
      defaultValue: body.defaultValue,
      allowedScopes: Array.isArray(body.allowedScopes)
        ? (body.allowedScopes as ConfigDefinitionRow["allowedScopes"])
        : ["global"],
      required: body.required === true,
      secret: body.secret === true,
      sensitive: body.sensitive === true,
      overridable: body.overridable !== false,
      inherited: body.inherited !== false,
      nullable: body.nullable === true,
      tenantOverridable: body.tenantOverridable === true,
      runtimeOverridable: body.runtimeOverridable === true,
      validation: isObject(body.validation) ? body.validation : {},
      description: typeof body.description === "string" ? body.description : null
    };
    const saved = await deps.configDefinitions.upsert(row);
    await audit(ctx, "config_definition.upsert", "config_definition", saved.key, before, saved);
    return ok({ definition: saved }, before ? 200 : 201);
  });

  route("DELETE", "/api/config/definitions/:key", async (ctx) => {
    enforce(ctx.principal, "config:edit_global");
    const before = await deps.configDefinitions.get(ctx.params.key);
    if (!before) return error(404, "not_found");
    await deps.configDefinitions.delete(ctx.params.key);
    await audit(ctx, "config_definition.delete", "config_definition", ctx.params.key, before, undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  // ---- config values ------------------------------------------------------
  route("GET", "/api/config/values", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const values = await deps.configValues.listConfigValues({
      key: ctx.request.query.key,
      scope: ctx.request.query.scope as ConfigValueRow["scope"] | undefined,
      // Accept both snake_case (scope_id) and camelCase (scopeId) so the web
      // can build a global -> tenant -> pipeline tree with either convention.
      scopeId: ctx.request.query.scope_id ?? ctx.request.query.scopeId
    });
    // Redact sensitive-looking values defensively.
    return ok({
      values: values.map((value) => ({ ...value, value: redactValue(value.value) }))
    });
  });

  route("POST", "/api/config/values", async (ctx) => {
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.key !== "string" || typeof body.scope !== "string") {
      return error(422, "validation_failed", {
        issues: [{ message: "key and scope are required" }]
      });
    }
    // Pick the permission appropriate to the scope being written.
    const scope = body.scope as ConfigValueRow["scope"];
    const permission: Permission =
      scope === "tenant" || scope === "tenant_pipeline"
        ? "config:edit_tenant"
        : scope === "global" || scope === "environment"
          ? "config:edit_global"
          : "config:edit_pipeline";
    enforce(ctx.principal, permission, {
      tenantId:
        scope === "tenant" ? (body.scopeId as string | undefined) : ctx.principal.tenantId
    });
    const saved = await deps.configValues.upsert({
      key: body.key,
      value: body.value,
      scope,
      scopeId: typeof body.scopeId === "string" ? body.scopeId : null,
      locked: body.locked === true,
      createdBy: ctx.principal.id
    });
    await audit(ctx, "config_value.upsert", "config_value", saved.id, undefined, {
      key: saved.key,
      scope: saved.scope,
      scopeId: saved.scopeId,
      value: redactValue(saved.value)
    });
    return ok({ value: { ...saved, value: redactValue(saved.value) } }, 201);
  });

  route("DELETE", "/api/config/values/:id", async (ctx) => {
    enforce(ctx.principal, "config:edit_pipeline");
    const existing = await deps.configValues.get(ctx.params.id);
    if (!existing) return error(404, "not_found");
    await deps.configValues.delete(ctx.params.id);
    await audit(ctx, "config_value.delete", "config_value", ctx.params.id, existing, undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  // ---- resolved config ----------------------------------------------------
  route("GET", "/api/config/resolved", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const pipelineId = ctx.request.query.pipeline_id;
    const tenantId = ctx.request.query.tenant_id;
    const environment = ctx.request.query.environment;
    if (!pipelineId || !tenantId || !environment) {
      return error(422, "validation_failed", {
        issues: [{ message: "pipeline_id, tenant_id, environment are required" }]
      });
    }
    if (
      !ctx.principal.roles.includes("platform_admin") &&
      ctx.principal.tenantId &&
      ctx.principal.tenantId !== tenantId
    ) {
      return error(403, "forbidden");
    }
    const definitionRows = await deps.configDefinitions.list();
    const definitions: ConfigDefinition[] = definitionRows.map((row) => ({
      key: row.key,
      type: row.type,
      defaultValue: row.defaultValue,
      allowedScopes: row.allowedScopes,
      required: row.required,
      secret: row.secret,
      sensitive: row.sensitive,
      overridable: row.overridable,
      inherited: row.inherited,
      nullable: row.nullable,
      tenantOverridable: row.tenantOverridable,
      runtimeOverridable: row.runtimeOverridable,
      description: row.description ?? undefined
    }));
    const valueRows = await deps.configValues.listConfigValues();
    const values: ConfigValue[] = valueRows.map((row) => ({
      key: row.key,
      value: row.value,
      scope: row.scope,
      scopeId: row.scopeId ?? undefined,
      locked: row.locked
    }));
    const resolver = new ConfigResolver(definitions);
    const resolved = resolver.resolve(
      { pipelineId, tenantId, environment, values },
      { redactSecrets: true }
    );
    return ok(resolved);
  });

  // ---- secrets ------------------------------------------------------------
  route("GET", "/api/secrets", async (ctx) => {
    enforce(ctx.principal, "secret:manage_tenant");
    const tenantId = tenantScope(ctx);
    const scope: Partial<SecretRef> = tenantId ? { tenantId } : {};
    const records = await deps.secretProvider.list(scope);
    return ok({
      secrets: records.map((record) => ({
        id: record.id,
        provider: record.provider,
        ref: record.ref,
        version: record.version,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        metadata: record.metadata,
        value: "REDACTED"
      }))
    });
  });

  route("POST", "/api/secrets", async (ctx) => {
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.key !== "string" || typeof body.value !== "string") {
      return error(422, "validation_failed", {
        issues: [{ message: "key and value are required" }]
      });
    }
    const ref = buildSecretRef(body, tenantScope(ctx));
    enforce(ctx.principal, "secret:manage_tenant", { tenantId: ref.tenantId });
    const record = await deps.secretProvider.put(
      ref,
      body.value,
      isObject(body.metadata) ? body.metadata : undefined
    );
    await audit(ctx, "secret.create", "secret", record.id, undefined, {
      ref: record.ref,
      version: record.version,
      value: "REDACTED"
    });
    return ok(
      {
        secret: {
          id: record.id,
          ref: record.ref,
          version: record.version,
          value: "REDACTED"
        }
      },
      201
    );
  });

  route("PUT", "/api/secrets/:id", async (ctx) => {
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.key !== "string" || typeof body.value !== "string") {
      return error(422, "validation_failed", {
        issues: [{ message: "key and value are required to rotate" }]
      });
    }
    const ref = buildSecretRef(body, tenantScope(ctx));
    enforce(ctx.principal, "secret:manage_tenant", { tenantId: ref.tenantId });
    const record = await deps.secretProvider.put(
      ref,
      body.value,
      isObject(body.metadata) ? body.metadata : undefined
    );
    await audit(ctx, "secret.rotate", "secret", record.id, undefined, {
      ref: record.ref,
      version: record.version,
      value: "REDACTED"
    });
    return ok({
      secret: { id: record.id, ref: record.ref, version: record.version, value: "REDACTED" }
    });
  });

  route("DELETE", "/api/secrets/:id", async (ctx) => {
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.key !== "string") {
      return error(422, "validation_failed", {
        issues: [{ message: "key (and scope) required to identify the secret" }]
      });
    }
    const ref = buildSecretRef(body, tenantScope(ctx));
    enforce(ctx.principal, "secret:manage_tenant", { tenantId: ref.tenantId });
    await deps.secretProvider.delete(ref, ref.tenantId);
    await audit(ctx, "secret.delete", "secret", ctx.params.id, { ref }, undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  // ---- executions ---------------------------------------------------------
  route("GET", "/api/executions", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const tenantId = tenantScope(ctx);
    const scope =
      ctx.principal.roles.includes("platform_admin") || !tenantId
        ? undefined
        : tenantId;
    const executions = await deps.executionStore.listExecutions(scope);
    return ok({ executions });
  });

  route("GET", "/api/executions/:id", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const execution = await deps.executionStore.getExecution(ctx.params.id);
    if (!execution) return error(404, "not_found");
    if (
      !ctx.principal.roles.includes("platform_admin") &&
      ctx.principal.tenantId &&
      execution.tenantId !== ctx.principal.tenantId
    ) {
      return error(403, "forbidden");
    }
    return ok({ execution });
  });

  route("GET", "/api/executions/:id/trace", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const execution = await deps.executionStore.getExecution(ctx.params.id);
    if (!execution) return error(404, "not_found");
    if (
      !ctx.principal.roles.includes("platform_admin") &&
      ctx.principal.tenantId &&
      execution.tenantId !== ctx.principal.tenantId
    ) {
      return error(403, "forbidden");
    }
    const nodes = await deps.executionStore.listNodes(ctx.params.id);
    return ok({ executionId: ctx.params.id, execution, nodes });
  });

  // ---- audit --------------------------------------------------------------
  route("GET", "/api/audit", async (ctx) => {
    enforce(ctx.principal, "audit:view");
    const tenantId = ctx.principal.roles.includes("platform_admin")
      ? (ctx.request.query.tenant_id ?? undefined)
      : ctx.principal.tenantId;
    const limit = ctx.request.query.limit ? Number(ctx.request.query.limit) : undefined;
    const logs = await deps.auditLogs.list({ tenantId, limit });
    return ok({ logs });
  });

  // ---- usage --------------------------------------------------------------
  route("GET", "/api/usage", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const tenantId = ctx.principal.roles.includes("platform_admin")
      ? (ctx.request.query.tenant_id ?? undefined)
      : ctx.principal.tenantId;
    const records = await deps.usageRecords.list({
      tenantId,
      executionId: ctx.request.query.execution_id
    });
    const summary = records.reduce(
      (acc, record) => {
        acc.inputTokens += record.inputTokens;
        acc.outputTokens += record.outputTokens;
        acc.embeddingTokens += record.embeddingTokens;
        acc.estimatedCostUsd += record.estimatedCostUsd;
        acc.count += 1;
        return acc;
      },
      { inputTokens: 0, outputTokens: 0, embeddingTokens: 0, estimatedCostUsd: 0, count: 0 }
    );
    return ok({ summary, records });
  });

  // ---- plugins ------------------------------------------------------------
  route("GET", "/api/plugins", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const plugins = deps.pluginRegistry.list().map(projectPlugin);
    return ok({ plugins });
  });

  route("GET", "/api/plugins/:category/:id/:version", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const found = deps.pluginRegistry.get({
      category: ctx.params.category as PluginRef["category"],
      id: ctx.params.id,
      version: ctx.params.version
    });
    if (!found) return error(404, "not_found");
    return ok({ plugin: projectPlugin(found) });
  });

  // ---- providers ----------------------------------------------------------
  route("GET", "/api/providers", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const providers = deps.providerRegistry.list().map((provider) => ({
      id: provider.id,
      displayName: provider.displayName
    }));
    return ok({ providers });
  });

  route("GET", "/api/providers/:id/models", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    let provider;
    try {
      provider = deps.providerRegistry.require(ctx.params.id);
    } catch {
      return error(404, "not_found");
    }
    return ok({ provider: provider.id, models: await provider.models() });
  });

  // ---- run ----------------------------------------------------------------
  route("POST", "/api/pipelines/:id/run", async (ctx) => {
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const pipelineId = pipeline.id;
    enforce(ctx.principal, "pipeline:run", {
      tenantId: ctx.principal.tenantId,
      pipelineId
    });
    const body = isObject(ctx.request.body) ? ctx.request.body : {};
    const tenantId = tenantScope(ctx);
    if (!tenantId) {
      return error(422, "validation_failed", {
        issues: [{ message: "tenant context required (x-tenant-id or principal tenant)" }]
      });
    }
    const environment =
      (typeof body.environment === "string" && body.environment) ||
      ctx.request.query.environment ||
      "dev";
    const activationLabel =
      typeof body.activation === "string" ? body.activation : undefined;

    // Resolution precedence:
    //  1. If the tenant has ANY activation for (tenant,pipeline,env), resolve
    //     through it: resolveActivation(label?) -> effectiveVersionId. This
    //     supports multiple concurrent activations (pinned + track-latest).
    //  2. Otherwise fall back to the existing deployment path (so the
    //     local-demo seed + current e2e keep passing unchanged).
    let resolved: PipelineVersionRow | undefined;
    let resolvedVia: "activation" | "deployment" = "deployment";
    let resolvedLabel: string | undefined;

    const activations = await pipelineActivations.listByTenantPipelineEnv(
      tenantId,
      pipelineId,
      environment
    );
    if (activations.length > 0) {
      resolvedVia = "activation";
      let chosen: PipelineActivationRow;
      try {
        chosen = resolveActivation(activations, activationLabel);
      } catch (e) {
        if (e instanceof ActivationResolutionError) {
          return error(409, "activation_unresolved", { message: e.message });
        }
        throw e;
      }
      let versionId: string;
      try {
        versionId = effectiveVersionId(
          {
            trackLatest: chosen.trackLatest,
            pipelineVersionId: chosen.pipelineVersionId ?? null
          },
          pipeline.latestVersionId ?? null
        );
      } catch (e) {
        if (e instanceof ActivationResolutionError) {
          return error(409, "activation_unresolved", { message: e.message });
        }
        throw e;
      }
      resolvedLabel = chosen.label;
      resolved = await deps.pipelineVersions.get(versionId);
      if (!resolved) {
        return error(409, "activation_unresolved", {
          message: `activation "${chosen.label}" resolves to unknown version ${versionId}`
        });
      }
    } else {
      resolved = await resolveDeployedVersion(
        deps,
        pipelineId,
        environment,
        tenantId
      );
      if (!resolved) {
        return error(409, "no_active_deployment", {
          message: `no active deployment for pipeline ${pipelineId} in ${environment}`
        });
      }
    }

    const validation = validatePipelineSpec(
      resolved.spec as PipelineSpec,
      deps.pluginRegistry
    );
    if (!validation.valid) {
      return error(422, "validation_failed", { issues: validation.errors });
    }

    const executionId = randomUUID();
    const jobId = randomUUID();
    const job: ApiQueueJob<{
      tenantId: string;
      pipelineId: string;
      pipelineVersionId: string;
      environment: string;
      executionId: string;
      input: unknown;
      activationLabel?: string;
    }> = {
      id: jobId,
      type: "run_pipeline",
      payload: {
        tenantId,
        pipelineId,
        pipelineVersionId: resolved.id,
        environment,
        executionId,
        input: body.input,
        ...(resolvedLabel !== undefined ? { activationLabel: resolvedLabel } : {})
      }
    };
    await deps.queue.enqueue(job as unknown as QueueJob);
    // Seed a queued execution record so GET /executions reflects the request.
    await deps.executionStore.start({
      executionId,
      tenantId,
      pipelineId,
      pipelineVersionId: resolved.id,
      status: "running",
      startedAt: nowIso(),
      input: redactValue(body.input)
    });
    await audit(ctx, "pipeline.run", "execution", executionId, undefined, {
      pipelineId,
      version: resolved.version,
      resolvedVia,
      activationLabel: resolvedLabel ?? null,
      input: redactValue(body.input)
    });
    return ok(
      {
        executionId,
        jobId,
        pipelineId,
        pipelineVersionId: resolved.id,
        version: resolved.version,
        resolvedVia,
        ...(resolvedLabel !== undefined ? { activationLabel: resolvedLabel } : {}),
        status: "accepted"
      },
      202
    );
  });

  // ---- ingest -------------------------------------------------------------
  route("POST", "/api/pipelines/:id/ingest", async (ctx) => {
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const pipelineId = pipeline.id;
    enforce(ctx.principal, "pipeline:run", {
      tenantId: ctx.principal.tenantId,
      pipelineId
    });
    const body = isObject(ctx.request.body) ? ctx.request.body : {};
    const tenantId = tenantScope(ctx);
    if (!tenantId) {
      return error(422, "validation_failed", {
        issues: [{ message: "tenant context required" }]
      });
    }
    const environment =
      (typeof body.environment === "string" && body.environment) ||
      ctx.request.query.environment ||
      "dev";
    const resolved = await resolveDeployedVersion(deps, pipelineId, environment, tenantId);
    if (!resolved) {
      return error(409, "no_active_deployment", {
        message: `no active deployment for pipeline ${pipelineId} in ${environment}`
      });
    }
    const jobId = randomUUID();
    const job: QueueJob<{
      tenantId: string;
      pipelineId: string;
      pipelineVersionId: string;
      environment: string;
      datasource: unknown;
    }> = {
      id: jobId,
      type: "ingest_datasource",
      payload: {
        tenantId,
        pipelineId,
        pipelineVersionId: resolved.id,
        environment,
        datasource: body.datasource ?? body.input
      }
    };
    await deps.queue.enqueue(job);
    await audit(ctx, "pipeline.ingest", "ingestion", jobId, undefined, {
      pipelineId,
      datasource: redactValue(body.datasource ?? body.input)
    });
    return ok(
      { jobId, pipelineId, pipelineVersionId: resolved.id, status: "accepted" },
      202
    );
  });

  // ---- stream (SSE) -------------------------------------------------------
  route("POST", "/api/pipelines/:id/stream", async (ctx) => {
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const pipelineId = pipeline.id;
    enforce(ctx.principal, "pipeline:run", {
      tenantId: ctx.principal.tenantId,
      pipelineId
    });
    const tenantId = tenantScope(ctx);
    if (!tenantId) {
      return error(422, "validation_failed", {
        issues: [{ message: "tenant context required" }]
      });
    }
    const environment =
      (isObject(ctx.request.body) && typeof ctx.request.body.environment === "string"
        ? ctx.request.body.environment
        : undefined) ||
      ctx.request.query.environment ||
      "dev";
    const resolved = await resolveDeployedVersion(deps, pipelineId, environment, tenantId);
    if (!resolved) {
      return error(409, "no_active_deployment", {
        message: `no active deployment for pipeline ${pipelineId} in ${environment}`
      });
    }
    // Honest scaffold: no streaming-capable provider wired in the API process.
    // We return a small, well-formed SSE event sequence so clients can
    // integrate, while clearly documenting that token streaming arrives via a
    // streaming provider in the worker. The body is the raw SSE text.
    const events = [
      `event: status\ndata: ${JSON.stringify({ status: "not_enabled", reason: "streaming provider not configured in control-plane; use /run via worker" })}\n\n`,
      `event: done\ndata: ${JSON.stringify({ pipelineId, pipelineVersionId: resolved.id })}\n\n`
    ];
    return {
      status: 200,
      body: events.join(""),
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      }
    };
  });

  // ---- router -------------------------------------------------------------
  async function handle(request: AppRequest): Promise<AppResponse> {
    const pathSegments = compile(request.path);

    let matched: Route | undefined;
    let params: Record<string, string> = {};
    for (const r of routes) {
      const m = matchRoute(r, request.method, pathSegments);
      if (m) {
        matched = r;
        params = m;
        break;
      }
    }

    if (!matched) {
      // Distinguish a known path with the wrong method (405) from 404.
      const pathExists = routes.some(
        (r) => matchRoute({ ...r, method: r.method }, r.method, pathSegments) !== undefined
      );
      return error(pathExists ? 405 : 404, pathExists ? "method_not_allowed" : "not_found");
    }

    const isPublic = request.path === "/healthz" || request.path === "/readyz";

    let principal: Principal = { id: "anonymous", type: "service", roles: [] };
    if (!isPublic) {
      try {
        principal = await deps.auth.resolve({ headers: request.headers });
      } catch (e) {
        if (
          e instanceof UnauthorizedError ||
          e instanceof InvalidCredentialsError ||
          e instanceof TokenInvalidError ||
          e instanceof TokenExpiredError
        ) {
          return error(401, "unauthorized", { message: e.message });
        }
        throw e;
      }

      // The DevAuthProvider fallback must never be honored in production.
      if (
        (deps.env ?? "development") === "production" &&
        principal.id === "dev-user"
      ) {
        return error(401, "unauthorized", {
          message: "dev auth fallback disabled in production"
        });
      }
    }

    try {
      const response = await matched.handler({
        request,
        params,
        principal,
        deps
      });
      return response;
    } catch (e) {
      if (e instanceof AuthorizationError) {
        return error(403, "forbidden", { message: e.message });
      }
      if (e instanceof NotFoundError || e instanceof SecretNotFoundError) {
        return error(404, "not_found", { message: e.message });
      }
      if (e instanceof SecretAccessDeniedError) {
        return error(403, "forbidden", { message: e.message });
      }
      if (e instanceof ConflictError) {
        return error(409, "conflict", { message: e.message });
      }
      // A non-UUID value (typically a pipeline slug) reaching a Postgres
      // `uuid` column raises SQLSTATE 22P02 / "invalid input syntax for type
      // uuid". That is bad client input, not a server fault: surface 400, not
      // 500. (The id-or-slug resolver normally prevents this; this is a
      // defense-in-depth backstop for any path that still casts directly.)
      if (isInvalidTextRepresentation(e)) {
        const message = e instanceof Error ? e.message : String(e);
        deps.logger.error("invalid_identifier", {
          path: request.path,
          method: request.method,
          error: message
        });
        return error(400, "invalid_identifier", { message });
      }
      deps.logger.error("unhandled_route_error", {
        path: request.path,
        method: request.method,
        error: e instanceof Error ? e.message : String(e)
      });
      return error(500, "internal_error", {
        message: e instanceof Error ? e.message : String(e)
      });
    }
  }

  return { handle };
}

// ---------------------------------------------------------------------------
// Module-level helpers (no closure over deps)
// ---------------------------------------------------------------------------

/**
 * Projects a registered plugin's manifest onto the public shape consumed by
 * the web UI to render schema-driven config/secret forms. This is the single
 * source of truth shared by `GET /api/plugins` and the per-plugin route, so
 * both responses always match the documented contract.
 */
function projectPlugin(plugin: RegisteredPlugin): {
  id: string;
  name: string;
  version: string;
  category: string;
  description: string;
  mode: string;
  capabilities: string[];
  configSchema?: unknown;
  secretsSchema?: unknown;
  ui?: {
    icon?: string;
    color?: string;
    formHints?: Record<string, unknown>;
    paletteGroup?: string;
    module?: string;
  };
} {
  const m = plugin.manifest;
  const ui = m.ui
    ? {
        ...(m.ui.icon !== undefined ? { icon: m.ui.icon } : {}),
        ...(m.ui.color !== undefined ? { color: m.ui.color } : {}),
        ...(m.ui.formHints !== undefined ? { formHints: m.ui.formHints } : {}),
        ...(m.ui.paletteGroup !== undefined ? { paletteGroup: m.ui.paletteGroup } : {}),
        ...(m.ui.module !== undefined ? { module: m.ui.module } : {})
      }
    : undefined;
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    category: m.category,
    description: m.description,
    mode: plugin.mode,
    capabilities: m.capabilities ?? [],
    ...(m.configSchema !== undefined ? { configSchema: m.configSchema } : {}),
    ...(m.secretsSchema !== undefined ? { secretsSchema: m.secretsSchema } : {}),
    ...(ui !== undefined ? { ui } : {})
  };
}

function parseSpec(input: unknown): PipelineSpec | undefined {
  if (typeof input === "string") {
    try {
      return loadPipelineSpec(input);
    } catch {
      return undefined;
    }
  }
  if (isObject(input) && "apiVersion" in input && "kind" in input && "spec" in input) {
    return input as unknown as PipelineSpec;
  }
  return undefined;
}

function buildSecretRef(
  body: Record<string, unknown>,
  fallbackTenant: string | undefined
): SecretRef {
  const scope = (typeof body.scope === "string" ? body.scope : "tenant") as SecretRef["scope"];
  return {
    provider: "database_encrypted",
    scope,
    tenantId:
      typeof body.tenantId === "string"
        ? body.tenantId
        : scope === "tenant" || scope === "tenant_provider" || scope === "datasource"
          ? fallbackTenant
          : undefined,
    environment: typeof body.environment === "string" ? body.environment : undefined,
    key: body.key as string,
    version: typeof body.version === "string" ? body.version : undefined
  };
}

async function resolveDeployedVersion(
  deps: AppDeps,
  pipelineId: string,
  environment: string,
  tenantId: string
): Promise<PipelineVersionRow | undefined> {
  // Prefer the repository's active-deployment lookup (tenant-scoped first).
  const tenantDeployment = await deps.deployments.getActiveDeployment(
    pipelineId,
    environment,
    tenantId
  );
  const envDeployment =
    tenantDeployment ??
    (await deps.deployments.getActiveDeployment(pipelineId, environment, null));

  let versionId = envDeployment?.pipelineVersionId;

  if (!versionId) {
    // Fall back to the pipeline-spec selector over the full deployment list.
    const all = await deps.deployments.listByPipeline(pipelineId);
    const deployments: PipelineDeployment[] = all
      .filter((row) => row.status === "active")
      .map((row) => ({
        pipelineId: row.pipelineId,
        environment: row.environment,
        version: row.pipelineVersionId,
        tenantId: row.tenantId ?? undefined
      }));
    const selected = selectDeployedVersion(deployments, {
      environment,
      tenantId,
      pipelineId
    });
    versionId = selected?.version;
  }

  if (!versionId) return undefined;
  return deps.pipelineVersions.get(versionId);
}
