/**
 * Datasource connections CRUD.
 *
 * A connection is the per-(tenant, env) record carrying the host /
 * port / credentials for a backing store (OpenSearch, Qdrant, Dgraph,
 * Postgres, etc). Datasets reference connections by name; plugins
 * resolve the connection via the dataset's backend block at runtime
 * (so plugins themselves never know the hostname or secret).
 *
 * Cascade: when a row carries `environment_id`, it wins for that env;
 * otherwise the `environment_id IS NULL` row (= tenant-wide default)
 * applies. The repository's `resolveForEnv` enforces this order.
 *
 * RBAC: a connection is an admin-only resource — it carries the
 * secret_ref that grants access to a backing store. We piggyback on
 * the existing `dataset:admin` permission since both are part of the
 * same operator-grade "this is what we point at" surface.
 */
import { randomUUID } from "node:crypto";
import { enforce } from "../../../../../packages/auth/src/index.ts";
import type {
  DatasourceConnectionRow,
  DatasourceConnectionRepository,
  EnvironmentRepository,
  TenantRepository
} from "../../../../../packages/db/src/index.ts";
import { ok, error, isObject, nowIso, headerValue } from "../http-utils.ts";
import type { AppDeps } from "../types.ts";
import type { RouteContext, RouteRegistry, AuditWriter } from "./types.ts";

interface ConnectionsServices {
  deps: AppDeps;
  audit: AuditWriter;
  connections: DatasourceConnectionRepository;
  environments: EnvironmentRepository;
  tenants: TenantRepository;
  tenantScope: (ctx: RouteContext) => string | undefined;
}

/**
 * Public projection. `configRedacted` already strips secrets via the
 * postgres jsonb column; we additionally surface a UI-friendly
 * `secretRefId` indicator without exposing the credential value.
 */
function publicConnection(row: DatasourceConnectionRow): Record<string, unknown> {
  return {
    id: row.id,
    tenantId: row.tenantId,
    environmentId: row.environmentId ?? null,
    name: row.name,
    datasourceType: row.datasourceType,
    secretRefId: row.secretRefId ?? null,
    config: row.configRedacted,
    allowedHosts: row.allowedHosts,
    denyPrivateNetworks: row.denyPrivateNetworks,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

const ALLOWED_TYPES = new Set([
  "opensearch",
  "qdrant",
  "dgraph",
  "pgvector",
  "postgres",
  "redis"
]);

export function registerConnectionsRoutes(
  api: RouteRegistry,
  svc: ConnectionsServices
): void {
  const { audit, connections, environments, tenants, tenantScope } = svc;

  // List — optional `?environmentId=` filter narrows to "rows that win
  // in this env" (env-specific + tenant-wide fallback). Without the
  // filter, lists every connection in the tenant.
  api.route("GET", "/api/connections", async (ctx) => {
    enforce(ctx.principal, "dataset:read");
    const tenantId = tenantScope(ctx);
    if (!tenantId) {
      return error(400, "tenant_required", {
        message: "x-tenant-id header required"
      });
    }
    const rows = await connections.listByTenant(tenantId);
    const envFilter =
      typeof ctx.request.query?.environmentId === "string"
        ? ctx.request.query.environmentId
        : headerValue(ctx.request.headers, "x-environment");
    const filtered = envFilter
      ? // Surface the row that WOULD apply per the cascade: env-specific
        // when present, otherwise the env=NULL tenant-wide fallback. We
        // dedupe by `name` so the listing matches what the resolver picks.
        Object.values(
          rows
            .filter((r) => r.environmentId === envFilter || r.environmentId == null)
            .reduce<Record<string, DatasourceConnectionRow>>((acc, row) => {
              const existing = acc[row.name];
              if (!existing) acc[row.name] = row;
              else if (existing.environmentId == null && row.environmentId === envFilter) {
                acc[row.name] = row;
              }
              return acc;
            }, {})
        )
      : rows;
    return ok({ connections: filtered.map(publicConnection) });
  });

  api.route("GET", "/api/connections/:id", async (ctx) => {
    const row = await connections.get(ctx.params.id);
    if (!row) return error(404, "not_found", { message: "connection not found" });
    enforce(ctx.principal, "dataset:read", { tenantId: row.tenantId });
    return ok({ connection: publicConnection(row) });
  });

  api.route("POST", "/api/connections", async (ctx) => {
    const body = ctx.request.body;
    if (!isObject(body)) {
      return error(422, "validation_failed", { issues: [{ message: "body required" }] });
    }
    const tenantId =
      (typeof body.tenantId === "string" && body.tenantId) || tenantScope(ctx);
    if (!tenantId) {
      return error(422, "validation_failed", {
        issues: [{ path: "tenantId", message: "tenantId required" }]
      });
    }
    if (typeof body.name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(body.name)) {
      return error(422, "validation_failed", {
        issues: [{ path: "name", message: "name must be lowercase alphanumeric + _- (1..63 chars)" }]
      });
    }
    if (typeof body.datasourceType !== "string" || !ALLOWED_TYPES.has(body.datasourceType)) {
      return error(422, "validation_failed", {
        issues: [{ path: "datasourceType", message: `must be one of: ${[...ALLOWED_TYPES].join(", ")}` }]
      });
    }
    // env_id is OPTIONAL. NULL = "tenant-wide default applied to every
    // env"; a non-null value scopes this row to a single env.
    const environmentId =
      typeof body.environmentId === "string" && body.environmentId
        ? body.environmentId
        : null;

    const tenant = await tenants.get(tenantId);
    if (!tenant) {
      return error(422, "validation_failed", {
        issues: [{ path: "tenantId", message: "unknown tenant" }]
      });
    }
    if (environmentId) {
      const envs = await environments.listByTenant(tenantId);
      if (!envs.find((e) => e.name === environmentId)) {
        return error(422, "validation_failed", {
          issues: [{ path: "environmentId", message: `unknown environment: ${environmentId}` }]
        });
      }
    }
    enforce(ctx.principal, "dataset:admin", { tenantId, environment: environmentId ?? undefined });

    const now = nowIso();
    const created = await connections.create({
      id: randomUUID(),
      tenantId,
      environmentId,
      name: body.name,
      datasourceType: body.datasourceType,
      secretRefId:
        typeof body.secretRefId === "string" && body.secretRefId ? body.secretRefId : null,
      configRedacted: isObject(body.config) ? body.config : {},
      allowedHosts:
        Array.isArray(body.allowedHosts)
          ? body.allowedHosts.filter((h: unknown): h is string => typeof h === "string")
          : [],
      denyPrivateNetworks: body.denyPrivateNetworks !== false,
      createdAt: now,
      updatedAt: now
    });
    await audit(ctx, "connection.create", "connection", created.id, undefined, publicConnection(created));
    return ok({ connection: publicConnection(created) }, 201);
  });

  api.route("PATCH", "/api/connections/:id", async (ctx) => {
    const before = await connections.get(ctx.params.id);
    if (!before) return error(404, "not_found", { message: "connection not found" });
    enforce(ctx.principal, "dataset:admin", {
      tenantId: before.tenantId,
      environment: before.environmentId ?? undefined
    });
    const body = ctx.request.body;
    if (!isObject(body)) {
      return error(422, "validation_failed", { issues: [{ message: "body required" }] });
    }
    const patch: Partial<DatasourceConnectionRow> = {};
    if (typeof body.name === "string" && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(body.name)) {
      patch.name = body.name;
    }
    if (typeof body.datasourceType === "string" && ALLOWED_TYPES.has(body.datasourceType)) {
      patch.datasourceType = body.datasourceType;
    }
    if (typeof body.secretRefId === "string" || body.secretRefId === null) {
      patch.secretRefId = (body.secretRefId as string | null) || null;
    }
    if (isObject(body.config)) patch.configRedacted = body.config;
    if (Array.isArray(body.allowedHosts)) {
      patch.allowedHosts = body.allowedHosts.filter(
        (h: unknown): h is string => typeof h === "string"
      );
    }
    if (typeof body.denyPrivateNetworks === "boolean") {
      patch.denyPrivateNetworks = body.denyPrivateNetworks;
    }
    patch.updatedAt = nowIso();
    const updated = await connections.update(before.id, patch);
    await audit(
      ctx,
      "connection.update",
      "connection",
      updated.id,
      publicConnection(before),
      publicConnection(updated)
    );
    return ok({ connection: publicConnection(updated) });
  });

  api.route("DELETE", "/api/connections/:id", async (ctx) => {
    const before = await connections.get(ctx.params.id);
    if (!before) return error(404, "not_found", { message: "connection not found" });
    enforce(ctx.principal, "dataset:admin", {
      tenantId: before.tenantId,
      environment: before.environmentId ?? undefined
    });
    await connections.delete(before.id);
    await audit(ctx, "connection.delete", "connection", before.id, publicConnection(before), undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  // Diagnostic: "for this name in this env, what would the cascade
  // resolve to?" Useful when an operator is debugging why a pipeline
  // hit the wrong cluster. Returns the winning row (or null) without
  // exposing the secret value.
  api.route("GET", "/api/connections/resolve/:name", async (ctx) => {
    enforce(ctx.principal, "dataset:read");
    const tenantId = tenantScope(ctx);
    if (!tenantId) {
      return error(400, "tenant_required", { message: "x-tenant-id header required" });
    }
    const envId =
      typeof ctx.request.query?.environmentId === "string"
        ? ctx.request.query.environmentId
        : headerValue(ctx.request.headers, "x-environment");
    const winner = await connections.resolveForEnv(tenantId, envId ?? undefined, ctx.params.name);
    if (!winner) {
      return ok({ resolved: null, reason: "no_match" });
    }
    return ok({
      resolved: publicConnection(winner),
      reason: winner.environmentId ? "env_specific" : "tenant_fallback"
    });
  });
}
