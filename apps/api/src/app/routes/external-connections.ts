/**
 * ADR-0021: External Connections Registry — REST surface.
 *
 *   GET    /api/external-connections          list visible at the caller's scope
 *   POST   /api/external-connections          create (admin)
 *   GET    /api/external-connections/:id      fetch one
 *   PUT    /api/external-connections/:id      update (admin)
 *   DELETE /api/external-connections/:id      soft-archive (admin)
 *   POST   /api/external-connections/:id/probe   run a health probe (admin)
 *
 * Auth surface:
 *   - `external_connection:read`  for GET endpoints.
 *   - `external_connection:admin` for create/update/delete/probe.
 *   - `external_connection:use`   is enforced separately at execute time
 *     by the runtime when a node references `connection.slug` (NOT here).
 *
 * Secrets are NEVER returned in the response — the row only carries the
 * pointer (`secretRefId`); the plaintext lives in `secrets` and is
 * resolved at execute time through `SecretProvider`.
 */
import { randomUUID } from "node:crypto";
import { enforce } from "../../../../../packages/auth/src/index.ts";
import type {
  ExternalConnectionRow,
  ExternalConnectionRepository
} from "../../../../../packages/db/src/index.ts";
import {
  ExternalConnectionResolver,
  probeConnection
} from "../../../../../packages/external-connections/src/index.ts";
import { ok, error, isObject, nowIso } from "../http-utils.ts";
import type { AppDeps } from "../types.ts";
import type { RouteContext, RouteRegistry, AuditWriter } from "./types.ts";

interface ExternalConnectionsServices {
  deps: AppDeps;
  audit: AuditWriter;
  externalConnections: ExternalConnectionRepository;
  tenantScope: (ctx: RouteContext) => string | undefined;
}

/** Per-row resource scope for `enforce()` — same shape datasets use. */
function rowResource(row: {
  scope: ExternalConnectionRow["scope"];
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

/** Public projection — explicitly omits any field that could carry a
 *  secret value. `secretRefId` IS returned (it's just an opaque
 *  reference). */
function publicConn(row: ExternalConnectionRow): Record<string, unknown> {
  return {
    id: row.id,
    scope: row.scope,
    tenantId: row.tenantId ?? null,
    environmentId: row.environmentId ?? null,
    slug: row.slug,
    displayName: row.displayName,
    description: row.description ?? null,
    kind: row.kind,
    secretRefId: row.secretRefId ?? null,
    options: row.options ?? {},
    lastProbedAt: row.lastProbedAt ?? null,
    lastProbeOk: row.lastProbeOk ?? null,
    lastProbeError: row.lastProbeError ?? null,
    archivedAt: row.archivedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/** Validate the scope-shape invariant (mirrors the SQL CHECK + InMemory). */
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

export function registerExternalConnectionsRoutes(
  api: RouteRegistry,
  svc: ExternalConnectionsServices
): void {
  const { deps, audit, externalConnections, tenantScope } = svc;

  api.route("GET", "/api/external-connections", async (ctx) => {
    enforce(ctx.principal, "external_connection:read");
    // Use the cascade view so the caller sees globals + their tenant's
    // connections + (when env header is set) the env-scoped ones.
    const tenantId = tenantScope(ctx);
    const envId = ctx.request.headers["x-ragdoll-env"];
    const rows = await externalConnections.listVisibleAt({
      tenantId,
      environmentId: typeof envId === "string" ? envId : undefined
    });
    return ok({ connections: rows.map(publicConn) });
  });

  api.route("GET", "/api/external-connections/:id", async (ctx) => {
    const row = await externalConnections.get(ctx.params.id);
    if (!row) return error(404, "not_found");
    enforce(ctx.principal, "external_connection:read", rowResource(row));
    return ok({ connection: publicConn(row) });
  });

  api.route("POST", "/api/external-connections", async (ctx) => {
    const body = isObject(ctx.request.body) ? ctx.request.body : {};
    enforce(
      ctx.principal,
      "external_connection:admin",
      // Best-effort scope hint from the body so a tenant-admin who can
      // only manage their own tenant doesn't accidentally create a
      // global. The repo's per-scope uniqueness still wins at the DB.
      body.scope === "tenant" || body.scope === "environment"
        ? rowResource({
            scope: body.scope as ExternalConnectionRow["scope"],
            tenantId:
              typeof body.tenantId === "string" ? body.tenantId : null,
            environmentId:
              typeof body.environmentId === "string"
                ? body.environmentId
                : null
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
    const row: ExternalConnectionRow = {
      id: typeof body.id === "string" ? body.id : randomUUID(),
      scope: body.scope as ExternalConnectionRow["scope"],
      tenantId: typeof body.tenantId === "string" ? body.tenantId : null,
      environmentId:
        typeof body.environmentId === "string" ? body.environmentId : null,
      slug: body.slug as string,
      displayName: body.displayName as string,
      description:
        typeof body.description === "string" ? body.description : null,
      kind: body.kind as string,
      secretRefId:
        typeof body.secretRefId === "string" ? body.secretRefId : null,
      options: isObject(body.options) ? body.options : {},
      createdAt: now,
      updatedAt: now
    };
    const created = await externalConnections.create(row);
    await audit(
      ctx,
      "external_connection.create",
      "external_connection",
      created.id,
      undefined,
      publicConn(created)
    );
    return ok({ connection: publicConn(created) }, 201);
  });

  api.route("PUT", "/api/external-connections/:id", async (ctx) => {
    const before = await externalConnections.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    enforce(ctx.principal, "external_connection:admin", rowResource(before));
    const body = isObject(ctx.request.body) ? ctx.request.body : {};
    const patch: Partial<ExternalConnectionRow> = {};
    if (typeof body.displayName === "string") patch.displayName = body.displayName;
    if ("description" in body)
      patch.description =
        typeof body.description === "string" ? body.description : null;
    if (typeof body.kind === "string") patch.kind = body.kind;
    if ("secretRefId" in body)
      patch.secretRefId =
        typeof body.secretRefId === "string" ? body.secretRefId : null;
    if (isObject(body.options)) patch.options = body.options;
    if ("archivedAt" in body)
      patch.archivedAt =
        typeof body.archivedAt === "string" ? body.archivedAt : null;
    const updated = await externalConnections.update(ctx.params.id, patch);
    await audit(
      ctx,
      "external_connection.update",
      "external_connection",
      updated.id,
      publicConn(before),
      publicConn(updated)
    );
    return ok({ connection: publicConn(updated) });
  });

  api.route("DELETE", "/api/external-connections/:id", async (ctx) => {
    const before = await externalConnections.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    enforce(ctx.principal, "external_connection:admin", rowResource(before));
    // Soft-archive (mirrors datasets — connection rows are referenced
    // from pipeline specs by slug; hard-deleting would silently break
    // those nodes at execute time).
    await externalConnections.update(ctx.params.id, {
      archivedAt: nowIso()
    });
    await audit(
      ctx,
      "external_connection.archive",
      "external_connection",
      ctx.params.id,
      publicConn(before),
      undefined
    );
    return { status: 204, body: undefined, headers: {} };
  });

  api.route("POST", "/api/external-connections/:id/probe", async (ctx) => {
    const row = await externalConnections.get(ctx.params.id);
    if (!row) return error(404, "not_found");
    enforce(ctx.principal, "external_connection:admin", rowResource(row));
    // Use the resolver to fetch the secret, then run the driver's probe.
    // Drivers register themselves in their plugin module's top-level
    // `registerConnectionDriver()` call; if none registered for this kind
    // the probe surfaces a clear error.
    const resolver = new ExternalConnectionResolver(
      externalConnections,
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
    await externalConnections.recordProbe(row.id, {
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
