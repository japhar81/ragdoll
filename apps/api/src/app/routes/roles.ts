/**
 * Role catalog: built-in roles (from packages/authz) plus
 * user-defined ones, with editable per-role permission sets stored
 * in `rbac_role_permissions`.
 */
import { randomUUID } from "node:crypto";
import {
  enforce,
  type Authorizer
} from "../../../../../packages/auth/src/index.ts";
import {
  ALL_ROLES,
  ALL_PERMISSIONS
} from "../../../../../packages/authz/src/index.ts";
import type {
  RbacPolicyRepository,
  RoleRepository
} from "../../../../../packages/db/src/index.ts";
import { ok, error, isObject } from "../http-utils.ts";
import { parseForce, hasDependents } from "../cascade-utils.ts";
import { defaultPermsFor } from "../rbac-helpers.ts";
import type { RouteRegistry, AuditWriter } from "./types.ts";

interface RolesServices {
  audit: AuditWriter;
  rbacPolicies: RbacPolicyRepository;
  roleCatalog: RoleRepository;
  authorizer?: Authorizer;
}

export function registerRolesRoutes(
  api: RouteRegistry,
  svc: RolesServices
): void {
  const { audit, rbacPolicies, roleCatalog, authorizer } = svc;

  api.route("GET", "/api/roles", async (ctx) => {
    enforce(ctx.principal, "role:manage");
    const rows = await rbacPolicies.listRolePermissions();
    const byRole = new Map<string, string[]>();
    for (const { role, permission } of rows) {
      byRole.set(role, [...(byRole.get(role) ?? []), permission]);
    }
    const custom = await roleCatalog.list();
    const names = new Set<string>([
      ...ALL_ROLES,
      ...byRole.keys(),
      ...custom.map((r) => r.name)
    ]);
    const roles = [...names].map((name) => ({
      name,
      builtin: (ALL_ROLES as string[]).includes(name),
      description: custom.find((r) => r.name === name)?.description ?? null,
      permissions: byRole.get(name) ?? defaultPermsFor(name)
    }));
    return ok({ roles, allPermissions: ALL_PERMISSIONS });
  });

  api.route("POST", "/api/roles", async (ctx) => {
    enforce(ctx.principal, "role:manage");
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.name !== "string" || !body.name.trim()) {
      return error(422, "validation_failed", { issues: [{ path: "name", message: "name is required" }] });
    }
    if (await roleCatalog.findByName(body.name)) {
      return error(409, "conflict", { message: "role already exists" });
    }
    const created = await roleCatalog.create({
      id: randomUUID(),
      name: body.name.trim(),
      description: typeof body.description === "string" ? body.description : null
    });
    await audit(ctx, "role.create", "role", created.id, undefined, created);
    return ok({ role: created }, 201);
  });

  api.route("PUT", "/api/roles/:name/permissions", async (ctx) => {
    enforce(ctx.principal, "role:manage");
    const body = ctx.request.body;
    if (!isObject(body) || !Array.isArray(body.permissions)) {
      return error(422, "validation_failed", { issues: [{ path: "permissions", message: "permissions[] required" }] });
    }
    const perms = (body.permissions as unknown[]).filter(
      (p): p is string => typeof p === "string"
    );
    await rbacPolicies.setRolePermissions(ctx.params.name, perms);
    if (authorizer) authorizer.invalidate();
    await audit(ctx, "role.set_permissions", "role", ctx.params.name, undefined, { permissions: perms });
    return ok({ role: ctx.params.name, permissions: perms });
  });

  api.route("DELETE", "/api/roles/:name", async (ctx) => {
    enforce(ctx.principal, "role:manage");
    if ((ALL_ROLES as string[]).includes(ctx.params.name)) {
      return error(409, "conflict", { message: "cannot delete a built-in role" });
    }
    const existing = await roleCatalog.findByName(ctx.params.name);
    if (!existing) {
      return error(404, "not_found", { message: `role "${ctx.params.name}" not found` });
    }
    const force = parseForce(ctx.request);
    // rbac_grants.role is a text column (no FK), so deleting the role
    // catalog row would silently leave dangling grants whose
    // authorize() checks then fail. Count + refuse by default; with
    // force=true, drop every grant holding this role first.
    const allGrants = await rbacPolicies.listGrants();
    const heldBy = allGrants.filter((g) => g.role === ctx.params.name);
    if (!force && heldBy.length > 0) {
      return hasDependents(`role "${ctx.params.name}"`, { grants: heldBy.length });
    }
    for (const g of heldBy) {
      await rbacPolicies.removeGrant(g.id);
    }
    await rbacPolicies.setRolePermissions(ctx.params.name, []);
    await roleCatalog.delete(existing.id);
    if (authorizer) authorizer.invalidate();
    await audit(
      ctx,
      "role.delete",
      "role",
      ctx.params.name,
      heldBy.length > 0 ? { cascaded: { grants: heldBy.length } } : undefined,
      undefined
    );
    return { status: 204, body: undefined, headers: {} };
  });
}
