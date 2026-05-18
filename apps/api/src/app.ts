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
  ImmutableVersionError,
  type PipelineVersionRecord,
  type PipelineDeployment
} from "../../../packages/pipeline-spec/src/index.ts";
import {
  NotFoundError,
  ConflictError,
  type TenantRepository,
  type PipelineRepository,
  type PipelineVersionRepository,
  type PipelineDeploymentRepository,
  type ConfigDefinitionRepository,
  type ConfigValueRepository,
  type AuditLogRepository,
  type UsageRecordRepository,
  type PluginRepository,
  type ProviderRepository,
  type DatasourceConnectionRepository,
  type VectorCollectionRepository,
  type TenantRow,
  type PipelineRow,
  type PipelineVersionRow,
  type PipelineDeploymentRow,
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

  // ---- pipelines ----------------------------------------------------------
  route("GET", "/api/pipelines", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    return ok({ pipelines: await deps.pipelines.list() });
  });

  route("GET", "/api/pipelines/:id", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const pipeline = await deps.pipelines.get(ctx.params.id);
    if (!pipeline) return error(404, "not_found");
    return ok({ pipeline });
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
    const row: PipelineRow = {
      id: typeof body.id === "string" ? body.id : randomUUID(),
      slug: body.slug,
      name: body.name,
      description: typeof body.description === "string" ? body.description : null,
      labels: isObject(body.labels) ? (body.labels as Record<string, string>) : {},
      createdBy: ctx.principal.id,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    const created = await deps.pipelines.create(row);
    await audit(ctx, "pipeline.create", "pipeline", created.id, undefined, created);
    return ok({ pipeline: created }, 201);
  });

  route("PUT", "/api/pipelines/:id", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const before = await deps.pipelines.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    const body = ctx.request.body;
    if (!isObject(body)) return error(422, "validation_failed", { issues: [] });
    const patch: Partial<PipelineRow> = { updatedAt: nowIso() };
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.description === "string") patch.description = body.description;
    if (isObject(body.labels)) patch.labels = body.labels as Record<string, string>;
    const updated = await deps.pipelines.update(ctx.params.id, patch);
    await audit(ctx, "pipeline.update", "pipeline", updated.id, before, updated);
    return ok({ pipeline: updated });
  });

  route("DELETE", "/api/pipelines/:id", async (ctx) => {
    enforce(ctx.principal, "pipeline:delete");
    const before = await deps.pipelines.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    await deps.pipelines.delete(ctx.params.id);
    await audit(ctx, "pipeline.delete", "pipeline", ctx.params.id, before, undefined);
    return { status: 204, body: undefined, headers: {} };
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
    const pipeline = await deps.pipelines.get(ctx.params.id);
    if (!pipeline) return error(404, "not_found");
    const versions = await deps.pipelineVersions.listByPipeline(ctx.params.id);
    return ok({ versions });
  });

  route("POST", "/api/pipelines/:id/versions", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const pipeline = await deps.pipelines.get(ctx.params.id);
    if (!pipeline) return error(404, "not_found");
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
    const existingRows = await deps.pipelineVersions.listByPipeline(ctx.params.id);
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
          pipelineId: ctx.params.id
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
        pipelineId: ctx.params.id,
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
      pipelineId: ctx.params.id,
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

  route("POST", "/api/pipelines/:id/versions/:version/archive", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const found = await deps.pipelineVersions.findByVersion(ctx.params.id, ctx.params.version);
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
    const found = await deps.pipelineVersions.findByVersion(ctx.params.id, ctx.params.version);
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
    const pipeline = await deps.pipelines.get(ctx.params.id);
    if (!pipeline) return error(404, "not_found");
    return ok({ deployments: await deps.deployments.listByPipeline(ctx.params.id) });
  });

  route("POST", "/api/pipelines/:id/deployments", async (ctx) => {
    enforce(ctx.principal, "pipeline:deploy");
    const pipeline = await deps.pipelines.get(ctx.params.id);
    if (!pipeline) return error(404, "not_found");
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
    const version = await deps.pipelineVersions.findByVersion(ctx.params.id, body.version);
    if (!version) return error(404, "not_found", { message: "pipeline version not found" });
    if (version.status !== "published") {
      return error(422, "validation_failed", {
        issues: [{ message: "only published versions can be deployed" }]
      });
    }
    const deploymentRow: PipelineDeploymentRow = {
      id: randomUUID(),
      pipelineId: ctx.params.id,
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
      scopeId: ctx.request.query.scope_id
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
    const pipeline = await deps.pipelines.get(ctx.params.id);
    if (!pipeline) return error(404, "not_found");
    enforce(ctx.principal, "pipeline:run", {
      tenantId: ctx.principal.tenantId,
      pipelineId: ctx.params.id
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

    const resolved = await resolveDeployedVersion(deps, ctx.params.id, environment, tenantId);
    if (!resolved) {
      return error(409, "no_active_deployment", {
        message: `no active deployment for pipeline ${ctx.params.id} in ${environment}`
      });
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
    }> = {
      id: jobId,
      type: "run_pipeline",
      payload: {
        tenantId,
        pipelineId: ctx.params.id,
        pipelineVersionId: resolved.id,
        environment,
        executionId,
        input: body.input
      }
    };
    await deps.queue.enqueue(job as unknown as QueueJob);
    // Seed a queued execution record so GET /executions reflects the request.
    await deps.executionStore.start({
      executionId,
      tenantId,
      pipelineId: ctx.params.id,
      pipelineVersionId: resolved.id,
      status: "running",
      startedAt: nowIso(),
      input: redactValue(body.input)
    });
    await audit(ctx, "pipeline.run", "execution", executionId, undefined, {
      pipelineId: ctx.params.id,
      version: resolved.version,
      input: redactValue(body.input)
    });
    return ok(
      {
        executionId,
        jobId,
        pipelineId: ctx.params.id,
        pipelineVersionId: resolved.id,
        version: resolved.version,
        status: "accepted"
      },
      202
    );
  });

  // ---- ingest -------------------------------------------------------------
  route("POST", "/api/pipelines/:id/ingest", async (ctx) => {
    const pipeline = await deps.pipelines.get(ctx.params.id);
    if (!pipeline) return error(404, "not_found");
    enforce(ctx.principal, "pipeline:run", {
      tenantId: ctx.principal.tenantId,
      pipelineId: ctx.params.id
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
    const resolved = await resolveDeployedVersion(deps, ctx.params.id, environment, tenantId);
    if (!resolved) {
      return error(409, "no_active_deployment", {
        message: `no active deployment for pipeline ${ctx.params.id} in ${environment}`
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
        pipelineId: ctx.params.id,
        pipelineVersionId: resolved.id,
        environment,
        datasource: body.datasource ?? body.input
      }
    };
    await deps.queue.enqueue(job);
    await audit(ctx, "pipeline.ingest", "ingestion", jobId, undefined, {
      pipelineId: ctx.params.id,
      datasource: redactValue(body.datasource ?? body.input)
    });
    return ok(
      { jobId, pipelineId: ctx.params.id, pipelineVersionId: resolved.id, status: "accepted" },
      202
    );
  });

  // ---- stream (SSE) -------------------------------------------------------
  route("POST", "/api/pipelines/:id/stream", async (ctx) => {
    const pipeline = await deps.pipelines.get(ctx.params.id);
    if (!pipeline) return error(404, "not_found");
    enforce(ctx.principal, "pipeline:run", {
      tenantId: ctx.principal.tenantId,
      pipelineId: ctx.params.id
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
    const resolved = await resolveDeployedVersion(deps, ctx.params.id, environment, tenantId);
    if (!resolved) {
      return error(409, "no_active_deployment", {
        message: `no active deployment for pipeline ${ctx.params.id} in ${environment}`
      });
    }
    // Honest scaffold: no streaming-capable provider wired in the API process.
    // We return a small, well-formed SSE event sequence so clients can
    // integrate, while clearly documenting that token streaming arrives via a
    // streaming provider in the worker. The body is the raw SSE text.
    const events = [
      `event: status\ndata: ${JSON.stringify({ status: "not_enabled", reason: "streaming provider not configured in control-plane; use /run via worker" })}\n\n`,
      `event: done\ndata: ${JSON.stringify({ pipelineId: ctx.params.id, pipelineVersionId: resolved.id })}\n\n`
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
