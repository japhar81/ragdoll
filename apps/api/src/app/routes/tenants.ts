/**
 * Tenant CRUD, per-tenant Git storage config, and tenant-scoped
 * environment management.
 *
 * The git-storage subset is feature-gated on `deps.tenantGitConfigs`
 * being wired — legacy harnesses omit it; createApp passes its
 * Postgres-backed instance there in production.
 */
import { randomUUID } from "node:crypto";
import { enforce } from "../../../../../packages/auth/src/index.ts";
import type {
  TenantRow,
  EnvironmentRow,
  EnvironmentRepository,
  RbacPolicyRepository
} from "../../../../../packages/db/src/index.ts";
import { ok, error, isObject, nowIso } from "../http-utils.ts";
import { parseForce, hasDependents } from "../cascade-utils.ts";
import type { AppDeps } from "../types.ts";
import type { RouteRegistry, AuditWriter } from "./types.ts";

interface TenantsServices {
  deps: AppDeps;
  audit: AuditWriter;
  environments: EnvironmentRepository;
  /** rbacPolicies is wired through here (rather than read from deps)
   *  because the user/role routes share the same repo via this service
   *  arg, and app.ts may have constructed an InMemory fallback when
   *  deps.rbacPolicies was undefined — using deps directly would point
   *  at a separate instance and miss grants the user route just wrote. */
  rbacPolicies: RbacPolicyRepository;
}

export function registerTenantsRoutes(
  api: RouteRegistry,
  svc: TenantsServices
): void {
  const { deps, audit, environments, rbacPolicies } = svc;

  api.route("GET", "/api/tenants", async (ctx) => {
    enforce(ctx.principal, "audit:view");
    const all = await deps.tenants.list();
    const scoped = ctx.principal.roles.includes("platform_admin")
      ? all
      : all.filter((tenant) => tenant.id === ctx.principal.tenantId);
    return ok({ tenants: scoped });
  });

  api.route("GET", "/api/tenants/:id", async (ctx) => {
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

  api.route("POST", "/api/tenants", async (ctx) => {
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

  api.route("PUT", "/api/tenants/:id", async (ctx) => {
    enforce(ctx.principal, "config:edit_global");
    const before = await deps.tenants.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    const body = ctx.request.body;
    if (!isObject(body)) return error(422, "validation_failed", { issues: [] });
    const patch: Partial<TenantRow> = { updatedAt: nowIso() };
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.status === "string") patch.status = body.status;
    if (isObject(body.metadata)) patch.metadata = body.metadata;
    if (body.storageMode === "db" || body.storageMode === "git") {
      patch.storageMode = body.storageMode;
    }
    const updated = await deps.tenants.update(ctx.params.id, patch);
    await audit(ctx, "tenant.update", "tenant", updated.id, before, updated);
    return ok({ tenant: updated });
  });

  // ---- per-tenant Git storage --------------------------------------------
  // CRUD over `tenant_git_configs` (migration 007) + an explicit /sync
  // trigger that the UI's "Sync now" button calls. The reconcile itself
  // lives in apps/api/src/git-mirror.ts and is shared with the worker's
  // polling loop.
  if (deps.tenantGitConfigs) {
    const tenantGitConfigs = deps.tenantGitConfigs;

    api.route("GET", "/api/tenants/:id/storage", async (ctx) => {
      enforce(ctx.principal, "config:edit_tenant", { tenantId: ctx.params.id });
      const tenant = await deps.tenants.get(ctx.params.id);
      if (!tenant) return error(404, "not_found");
      const cfg = await tenantGitConfigs.get(ctx.params.id);
      // Never return the wrapped DEK over the wire — the operator can't
      // use it, and exposing wrapped key material is a needless risk.
      const safe = cfg
        ? {
            tenantId: cfg.tenantId,
            remoteUrl: cfg.remoteUrl,
            branch: cfg.branch,
            pathPrefix: cfg.pathPrefix,
            authMethod: cfg.authMethod,
            authSecretId: cfg.authSecretId,
            pollIntervalSec: cfg.pollIntervalSec,
            lastSyncedSha: cfg.lastSyncedSha ?? null,
            lastSyncedAt: cfg.lastSyncedAt ?? null,
            lastSyncError: cfg.lastSyncError ?? null,
            createdAt: cfg.createdAt,
            updatedAt: cfg.updatedAt
          }
        : null;
      return ok({
        storageMode: tenant.storageMode ?? "db",
        git: safe
      });
    });

    api.route("PUT", "/api/tenants/:id/storage", async (ctx) => {
      enforce(ctx.principal, "config:edit_tenant", { tenantId: ctx.params.id });
      const body = ctx.request.body;
      if (
        !isObject(body) ||
        typeof body.remoteUrl !== "string" ||
        typeof body.branch !== "string" ||
        typeof body.pathPrefix !== "string" ||
        (body.authMethod !== "https" && body.authMethod !== "ssh") ||
        typeof body.authSecretId !== "string"
      ) {
        return error(422, "validation_failed", {
          issues: [
            { message: "remoteUrl, branch, pathPrefix, authMethod, authSecretId required" }
          ]
        });
      }
      const tenant = await deps.tenants.get(ctx.params.id);
      if (!tenant) return error(404, "not_found");
      // Reuse the existing DEK on edits; mint a fresh one on first config.
      const existing = await tenantGitConfigs.get(ctx.params.id);
      const kek = process.env.SECRET_ENCRYPTION_KEY ?? "dev-secret";
      const { generateDek, wrapDek } = await import(
        "../../../../../packages/git-storage/src/index.ts"
      );
      const dekWrapped = existing
        ? existing.dekWrapped
        : wrapDek(generateDek(), kek);
      const now = nowIso();
      const row = await tenantGitConfigs.upsert({
        tenantId: ctx.params.id,
        remoteUrl: body.remoteUrl,
        branch: body.branch,
        pathPrefix: body.pathPrefix,
        authMethod: body.authMethod,
        authSecretId: body.authSecretId,
        dekWrapped,
        pollIntervalSec:
          typeof body.pollIntervalSec === "number" ? body.pollIntervalSec : 60,
        lastSyncedSha: existing?.lastSyncedSha ?? null,
        lastSyncedAt: existing?.lastSyncedAt ?? null,
        lastSyncError: existing?.lastSyncError ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      });
      await deps.tenants.update(ctx.params.id, {
        storageMode: "git",
        updatedAt: now
      });
      await audit(
        ctx,
        "tenant_git.upsert",
        "tenant_git_config",
        ctx.params.id,
        existing,
        { ...row, dekWrapped: "[REDACTED]" }
      );
      return ok({
        storageMode: "git",
        git: { ...row, dekWrapped: "[REDACTED]" }
      });
    });

    api.route("DELETE", "/api/tenants/:id/storage", async (ctx) => {
      enforce(ctx.principal, "config:edit_tenant", { tenantId: ctx.params.id });
      const before = await tenantGitConfigs.get(ctx.params.id);
      if (!before) return error(404, "not_found");
      await tenantGitConfigs.delete(ctx.params.id);
      await deps.tenants.update(ctx.params.id, {
        storageMode: "db",
        updatedAt: nowIso()
      });
      await audit(
        ctx,
        "tenant_git.delete",
        "tenant_git_config",
        ctx.params.id,
        { ...before, dekWrapped: "[REDACTED]" },
        undefined
      );
      return { status: 204, body: undefined, headers: {} };
    });

    api.route("POST", "/api/tenants/:id/storage/sync", async (ctx) => {
      enforce(ctx.principal, "config:edit_tenant", { tenantId: ctx.params.id });
      const cfg = await tenantGitConfigs.get(ctx.params.id);
      if (!cfg) return error(404, "not_found", { message: "no git config" });
      await tenantGitConfigs.recordSync(ctx.params.id, {
        syncedAt: new Date(0).toISOString(),
        error: null
      });
      await audit(
        ctx,
        "tenant_git.sync_requested",
        "tenant_git_config",
        ctx.params.id,
        undefined,
        undefined
      );
      return { status: 202, body: { status: "queued" }, headers: {} };
    });
  }

  api.route("DELETE", "/api/tenants/:id", async (ctx) => {
    enforce(ctx.principal, "config:edit_global");
    const before = await deps.tenants.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    const force = parseForce(ctx.request);
    // What cascades automatically (via FK ON DELETE CASCADE per migrations
    // 001 / 003 / 004 / 007 / 013 / 019): audit_logs, usage_records,
    // executions, secrets, schedules, tenant_git_configs, environments,
    // tenant_pipelines, connections-scoped-to-this-tenant, pipelines'
    // own children chain. What does NOT cascade by FK:
    //  - rbac_grants where scope starts with `t/<tenantId>` (scope is text,
    //    no FK reference). Those grants would otherwise dangle, granting
    //    a role on a tenant that no longer exists.
    // Counts shown below are pre-delete; the force path drops them all.
    const tenantId = ctx.params.id;
    const tenantScopePrefixes = [`t/${tenantId}`];
    const [
      tenantPipelines,
      tenantDatasets,
      tenantConns,
      envs,
      allGrants
    ] = await Promise.all([
      deps.tenantPipelines?.listByTenant
        ? deps.tenantPipelines.listByTenant(tenantId)
        : Promise.resolve([] as Array<unknown>),
      deps.datasets?.listAll
        ? deps.datasets.listAll({ tenantId })
        : Promise.resolve([] as Array<unknown>),
      deps.connections.listAll(),
      deps.environments?.listByTenant
        ? deps.environments.listByTenant(tenantId)
        : Promise.resolve([] as Array<unknown>),
      rbacPolicies.listGrants()
    ]);
    const tenantConnsCount = tenantConns.filter(
      (c) => c.tenantId === tenantId
    ).length;
    const grantsInTenant = allGrants.filter((g) =>
      tenantScopePrefixes.some((prefix) => g.scope === prefix || g.scope.startsWith(`${prefix}/`))
    );
    const depCounts = {
      pipelineAssociations: tenantPipelines.length,
      datasets: tenantDatasets.length,
      connections: tenantConnsCount,
      environments: envs.length,
      grants: grantsInTenant.length
    };
    const anyDeps = Object.values(depCounts).some((n) => n > 0);
    if (!force && anyDeps) {
      return hasDependents(`tenant "${before.slug ?? before.id}"`, depCounts);
    }
    // Force path: explicitly remove the tenant-scoped grants so user
    // accounts don't end up with dangling tenant-scoped roles. The
    // user account itself survives — they just lose the role grant
    // that pointed at this tenant.
    for (const g of grantsInTenant) {
      await rbacPolicies.removeGrant(g.id);
    }
    await deps.tenants.delete(tenantId);
    await audit(
      ctx,
      "tenant.delete",
      "tenant",
      tenantId,
      { ...before, cascaded: depCounts },
      undefined
    );
    return { status: 204, body: undefined, headers: {} };
  });

  // ---- tenant environments ------------------------------------------------
  api.route("GET", "/api/tenants/:id/environments", async (ctx) => {
    enforce(ctx.principal, "audit:view", { tenantId: ctx.params.id });
    if (
      !ctx.principal.roles.includes("platform_admin") &&
      ctx.principal.tenantId !== ctx.params.id
    ) {
      return error(403, "forbidden");
    }
    return ok({ environments: await environments.listByTenant(ctx.params.id) });
  });

  api.route("POST", "/api/tenants/:id/environments", async (ctx) => {
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

  api.route("PUT", "/api/tenants/:id/environments/:envId", async (ctx) => {
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

  api.route("DELETE", "/api/tenants/:id/environments/:envId", async (ctx) => {
    enforce(ctx.principal, "config:edit_global");
    const before = await environments.get(ctx.params.envId);
    if (!before || before.tenantId !== ctx.params.id) {
      return error(404, "not_found");
    }
    // Drop deployments referencing this environment FIRST — the
    // pipeline_deployments.environment column FKs to environments.name,
    // so deleting the env row would otherwise leave orphan deployment
    // rows pointing at a missing target (or, depending on the SQL
    // dialect, refuse the env delete entirely). Mirrors the same
    // cascade the unified DELETE on folders / pipelines / datasets
    // already does for their dependents.
    const dropped = await deps.deployments.deleteByEnvironment(
      before.name,
      before.tenantId
    );
    await environments.delete(ctx.params.envId);
    await audit(
      ctx,
      "environment.delete",
      "environment",
      ctx.params.envId,
      before,
      undefined
    );
    if (dropped > 0) {
      await audit(
        ctx,
        "environment.delete_cascade",
        "pipeline_deployment",
        ctx.params.envId,
        { droppedDeployments: dropped, environment: before.name },
        undefined
      );
    }
    return { status: 204, body: undefined, headers: {} };
  });
}
