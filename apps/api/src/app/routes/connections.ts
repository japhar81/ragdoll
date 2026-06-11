/**
 * Connections REST surface (ADR-0023).
 *
 * Single CRUD + probe surface for the unified connections registry.
 * Supersedes the per-tenant `datasource_connections` routes (ADR-0020)
 * AND the `external_connections` routes (ADR-0021) — both folded in
 * here. Slug resolution is env → tenant → global; cascade visibility
 * shows globals + tenant + env-scoped rows in one list when scope
 * context is provided.
 *
 * Auth:
 *   - GET endpoints: `connection:read`
 *   - POST/PUT/DELETE/probe: `connection:admin`
 *
 * `connection:use` is enforced separately by the runtime at executor
 * entry — see ADR-0023 §6.
 *
 * Secrets are never returned. `secretRefId` is an opaque pointer the
 * operator resolves out-of-band.
 */
import { randomUUID } from "node:crypto";
import { enforce } from "../../../../../packages/auth/src/index.ts";
import type {
  ConnectionRow,
  ConnectionRepository,
  EnvironmentRepository,
  TenantRepository
} from "../../../../../packages/db/src/index.ts";
import {
  ExternalConnectionResolver,
  probeConnection,
  listConnectionKinds,
  closeClient
} from "../../../../../packages/external-connections/src/index.ts";
import { ok, error, isObject, nowIso } from "../http-utils.ts";
import { parseForce, hasDependents } from "../cascade-utils.ts";
import type { AppDeps } from "../types.ts";
import type { RouteContext, RouteRegistry, AuditWriter } from "./types.ts";

interface ConnectionsServices {
  deps: AppDeps;
  audit: AuditWriter;
  connections: ConnectionRepository;
  environments: EnvironmentRepository;
  tenants: TenantRepository;
  tenantScope: (ctx: RouteContext) => string | undefined;
}

function rowResource(row: {
  scope: ConnectionRow["scope"];
  tenantId?: string | null;
  environmentId?: string | null;
}): { tenantId?: string; environment?: string } {
  if (row.scope === "tenant") return { tenantId: row.tenantId ?? undefined };
  if (row.scope === "environment") {
    return {
      tenantId: row.tenantId ?? undefined,
      environment: row.environmentId ?? undefined
    };
  }
  return {};
}

function publicConnection(row: ConnectionRow): Record<string, unknown> {
  return {
    id: row.id,
    scope: row.scope,
    tenantId: row.tenantId ?? null,
    environmentId: row.environmentId ?? null,
    slug: row.slug,
    displayName: row.displayName,
    description: row.description ?? null,
    kind: row.kind,
    config: row.config ?? {},
    secretRefId: row.secretRefId ?? null,
    allowedHosts: row.allowedHosts ?? [],
    denyPrivateNetworks: !!row.denyPrivateNetworks,
    lastProbedAt: row.lastProbedAt ?? null,
    lastProbeOk: row.lastProbeOk ?? null,
    lastProbeError: row.lastProbeError ?? null,
    archivedAt: row.archivedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function validateScopeShape(
  body: Record<string, unknown>
): Array<{ path: string; message: string }> {
  const scope = body.scope;
  const tenantId = body.tenantId;
  const envId = body.environmentId;
  const issues: Array<{ path: string; message: string }> = [];
  if (scope === "global") {
    if (tenantId != null)
      issues.push({ path: "tenantId", message: "must be null at global scope" });
    if (envId != null)
      issues.push({ path: "environmentId", message: "must be null at global scope" });
  } else if (scope === "tenant") {
    if (typeof tenantId !== "string")
      issues.push({ path: "tenantId", message: "required at tenant scope" });
    if (envId != null)
      issues.push({ path: "environmentId", message: "must be null at tenant scope" });
  } else if (scope === "environment") {
    if (typeof tenantId !== "string")
      issues.push({ path: "tenantId", message: "required at environment scope" });
    if (typeof envId !== "string")
      issues.push({ path: "environmentId", message: "required at environment scope" });
  } else {
    issues.push({
      path: "scope",
      message: "must be one of: global, tenant, environment"
    });
  }
  return issues;
}

export function registerConnectionsRoutes(
  api: RouteRegistry,
  svc: ConnectionsServices
): void {
  const { deps, audit, connections, tenantScope } = svc;

  // ADR-0024: catalog of loaded connection driver plugins. The web UI
  // calls this to populate the Type dropdown + render the per-kind
  // config form from the driver's manifest.configSchema (no
  // hand-rolled TSX per kind). Open to any authenticated user with
  // `connection:read` — the catalog has no secrets.
  api.route("GET", "/api/connection-kinds", async (ctx) => {
    enforce(ctx.principal, "connection:read");
    return ok({ kinds: listConnectionKinds() });
  });

  api.route("GET", "/api/connections", async (ctx) => {
    enforce(ctx.principal, "connection:read");
    const tenantId = tenantScope(ctx);
    const envHeader = ctx.request.headers["x-ragdoll-env"];
    const envId = typeof envHeader === "string" ? envHeader : undefined;
    const rows = tenantId
      ? await connections.listVisibleAt({ tenantId, environmentId: envId })
      : await connections.listAll({ scope: "global" });
    return ok({ connections: rows.map(publicConnection) });
  });

  api.route("GET", "/api/connections/:id", async (ctx) => {
    const row = await connections.get(ctx.params.id);
    if (!row) return error(404, "not_found");
    enforce(ctx.principal, "connection:read", rowResource(row));
    return ok({ connection: publicConnection(row) });
  });

  api.route("POST", "/api/connections", async (ctx) => {
    const body = isObject(ctx.request.body) ? ctx.request.body : {};
    enforce(
      ctx.principal,
      "connection:admin",
      body.scope === "tenant" || body.scope === "environment"
        ? rowResource({
            scope: body.scope as ConnectionRow["scope"],
            tenantId: typeof body.tenantId === "string" ? body.tenantId : null,
            environmentId:
              typeof body.environmentId === "string" ? body.environmentId : null
          })
        : {}
    );
    const scopeIssues = validateScopeShape(body);
    if (
      typeof body.slug !== "string" ||
      typeof body.displayName !== "string" ||
      typeof body.kind !== "string"
    ) {
      scopeIssues.push({
        path: "",
        message: "slug, displayName, kind are required strings"
      });
    }
    if (scopeIssues.length > 0) {
      return error(422, "validation_failed", { issues: scopeIssues });
    }
    const now = nowIso();
    const row: ConnectionRow = {
      id: typeof body.id === "string" ? body.id : randomUUID(),
      scope: body.scope as ConnectionRow["scope"],
      tenantId: typeof body.tenantId === "string" ? body.tenantId : null,
      environmentId:
        typeof body.environmentId === "string" ? body.environmentId : null,
      slug: body.slug as string,
      displayName: body.displayName as string,
      description:
        typeof body.description === "string" ? body.description : null,
      kind: body.kind as string,
      config: isObject(body.config) ? body.config : {},
      secretRefId:
        typeof body.secretRefId === "string" ? body.secretRefId : null,
      allowedHosts: Array.isArray(body.allowedHosts)
        ? (body.allowedHosts as string[])
        : [],
      denyPrivateNetworks: !!body.denyPrivateNetworks,
      createdAt: now,
      updatedAt: now
    };
    const created = await connections.create(row);
    await audit(
      ctx,
      "connection.create",
      "connection",
      created.id,
      undefined,
      publicConnection(created)
    );
    return ok({ connection: publicConnection(created) }, 201);
  });

  api.route("PUT", "/api/connections/:id", async (ctx) => {
    const before = await connections.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    enforce(ctx.principal, "connection:admin", rowResource(before));
    const body = isObject(ctx.request.body) ? ctx.request.body : {};
    const patch: Partial<ConnectionRow> = {};
    if (typeof body.displayName === "string") patch.displayName = body.displayName;
    if ("description" in body)
      patch.description =
        typeof body.description === "string" ? body.description : null;
    if (typeof body.kind === "string") patch.kind = body.kind;
    if ("secretRefId" in body)
      patch.secretRefId =
        typeof body.secretRefId === "string" ? body.secretRefId : null;
    if (isObject(body.config)) patch.config = body.config;
    if (Array.isArray(body.allowedHosts))
      patch.allowedHosts = body.allowedHosts as string[];
    if (typeof body.denyPrivateNetworks === "boolean")
      patch.denyPrivateNetworks = body.denyPrivateNetworks;
    if ("archivedAt" in body)
      patch.archivedAt =
        typeof body.archivedAt === "string" ? body.archivedAt : null;
    const updated = await connections.update(ctx.params.id, patch);
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
    if (!before) return error(404, "not_found");
    enforce(ctx.principal, "connection:admin", rowResource(before));
    const force = parseForce(ctx.request);
    if (!force) {
      // Default posture: soft-archive (sets archivedAt). Rows stay in
      // the DB so historical execution traces still resolve their
      // connection envelope; the UI filters archived rows out of the
      // primary listing. This is intentionally NON-destructive — the
      // operator opts into hard delete via ?force=true.
      await connections.update(ctx.params.id, { archivedAt: nowIso() });
      await audit(
        ctx,
        "connection.archive",
        "connection",
        ctx.params.id,
        publicConnection(before),
        undefined
      );
      return { status: 204, body: undefined, headers: {} };
    }
    // Force path: hard delete the row. Count dataset bindings + pipeline
    // spec node.connection.slug references first — neither has an FK
    // CASCADE (both are jsonb blobs), so without this count the
    // operator could blow away a connection out from under live
    // pipelines without warning. With dependents and force=true, we
    // STILL refuse — force here means "yes, even though it's archived
    // / has been around a while, drop the row" but doesn't blanket-
    // override the dependent safety. Operator must clean refs first.
    const [allDatasets, allPipelines] = await Promise.all([
      deps.datasets?.listAll ? deps.datasets.listAll() : Promise.resolve([]),
      deps.pipelines.list()
    ]);
    let datasetBindingCount = 0;
    for (const ds of allDatasets) {
      const bindings = (ds.bindings ?? {}) as Record<
        string,
        { connection?: string }
      >;
      const hit = Object.values(bindings).some(
        (b) => b?.connection === before.slug
      );
      if (hit) datasetBindingCount += 1;
    }
    let pipelineNodeCount = 0;
    for (const p of allPipelines) {
      const vers = await deps.pipelineVersions.listByPipeline(p.id);
      if (vers.length === 0) continue;
      const latest = vers[vers.length - 1];
      const spec = (latest.spec ?? {}) as {
        spec?: { nodes?: Array<{ connection?: { slug?: string } }> };
      };
      const nodes = spec.spec?.nodes ?? [];
      if (nodes.some((n) => n.connection?.slug === before.slug)) {
        pipelineNodeCount += 1;
      }
    }
    const depCounts = {
      datasetBindings: datasetBindingCount,
      pipelineReferences: pipelineNodeCount
    };
    if (datasetBindingCount > 0 || pipelineNodeCount > 0) {
      return hasDependents(`connection "${before.slug}"`, depCounts);
    }
    await connections.delete(ctx.params.id);
    // Drop any pooled client keyed to this connection's id so a
    // future row that happens to recycle the id (unlikely with UUIDs
    // but possible in tests) doesn't see a stale client.
    await closeClient(ctx.params.id).catch(() => undefined);
    await audit(
      ctx,
      "connection.delete",
      "connection",
      ctx.params.id,
      { ...publicConnection(before), cascaded: depCounts },
      undefined
    );
    return { status: 204, body: undefined, headers: {} };
  });

  api.route("POST", "/api/connections/:id/probe", async (ctx) => {
    const row = await connections.get(ctx.params.id);
    if (!row) return error(404, "not_found");
    enforce(ctx.principal, "connection:admin", rowResource(row));
    const resolver = new ExternalConnectionResolver(
      connections,
      deps.secretProvider
    );
    const resolved = await resolver.resolve({
      slug: row.slug,
      tenantId: row.tenantId ?? undefined,
      environmentId: row.environmentId ?? undefined
    });
    if (!resolved) {
      return error(500, "probe_failed", {
        message: "connection resolved to undefined (race with archive?)"
      });
    }
    const result = await probeConnection(resolved);
    await connections.recordProbe(row.id, {
      ok: result.ok,
      error: result.error,
      at: nowIso()
    });
    return ok({
      ok: result.ok,
      error: result.error ?? null,
      probedAt: nowIso()
    });
  });
}
