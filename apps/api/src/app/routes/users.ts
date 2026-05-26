/**
 * User CRUD + per-user grant management. All routes require
 * `user:manage`; grant routes additionally check the operator holds
 * `user:manage` at the TARGET scope so a tenant_admin can't grant a
 * role at a scope they don't themselves cover.
 */
import { randomUUID } from "node:crypto";
import {
  enforce,
  type Authorizer,
  type PasswordService
} from "../../../../../packages/auth/src/index.ts";
import {
  parseScope,
  scopeToString
} from "../../../../../packages/authz/src/index.ts";
import type {
  UserRow,
  UserRepository,
  RbacGrantRow,
  RbacPolicyRepository
} from "../../../../../packages/db/src/index.ts";
import { ok, error, isObject, nowIso } from "../http-utils.ts";
import { publicUser } from "../projections.ts";
import {
  scopeInputFromBody,
  scopeResource
} from "../rbac-helpers.ts";
import type { RouteRegistry, AuditWriter } from "./types.ts";

interface UsersServices {
  audit: AuditWriter;
  users: UserRepository;
  passwords: PasswordService;
  rbacPolicies: RbacPolicyRepository;
  authorizer?: Authorizer;
}

export function registerUsersRoutes(
  api: RouteRegistry,
  svc: UsersServices
): void {
  const { audit, users, passwords, rbacPolicies, authorizer } = svc;

  api.route("GET", "/api/users", async (ctx) => {
    enforce(ctx.principal, "user:manage");
    const all = await users.list();
    return ok({ users: all.map(publicUser) });
  });

  api.route("POST", "/api/users", async (ctx) => {
    enforce(ctx.principal, "user:manage");
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.email !== "string") {
      return error(422, "validation_failed", { issues: [{ path: "email", message: "email is required" }] });
    }
    const email = body.email.trim().toLowerCase();
    if (await users.findByEmail(email)) {
      return error(409, "conflict", { message: "email already exists" });
    }
    const now = nowIso();
    const row: UserRow = {
      id: typeof body.id === "string" ? body.id : randomUUID(),
      email,
      displayName: typeof body.displayName === "string" ? body.displayName : null,
      passwordHash:
        typeof body.password === "string" && body.password.length > 0
          ? await passwords.hash(body.password)
          : null,
      status: body.status === "disabled" ? "disabled" : "active",
      createdAt: now,
      updatedAt: now
    };
    const created = await users.create(row);
    await audit(ctx, "user.create", "user", created.id, undefined, publicUser(created));
    return ok({ user: publicUser(created) }, 201);
  });

  api.route("PATCH", "/api/users/:id", async (ctx) => {
    enforce(ctx.principal, "user:manage");
    const before = await users.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    const body = ctx.request.body;
    if (!isObject(body)) return error(422, "validation_failed", { issues: [] });
    const patch: Partial<UserRow> = { updatedAt: nowIso() };
    if (typeof body.displayName === "string" || body.displayName === null) {
      patch.displayName = body.displayName as string | null;
    }
    if (body.status === "active" || body.status === "disabled") {
      patch.status = body.status;
    }
    if (typeof body.password === "string" && body.password.length > 0) {
      patch.passwordHash = await passwords.hash(body.password);
    }
    const updated = await users.update(ctx.params.id, patch);
    await audit(ctx, "user.update", "user", updated.id, publicUser(before), publicUser(updated));
    return ok({ user: publicUser(updated) });
  });

  api.route("DELETE", "/api/users/:id", async (ctx) => {
    enforce(ctx.principal, "user:manage");
    const before = await users.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    await users.delete(ctx.params.id);
    if (authorizer) authorizer.invalidate(ctx.params.id);
    await audit(ctx, "user.delete", "user", ctx.params.id, publicUser(before), undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  api.route("GET", "/api/users/:id/grants", async (ctx) => {
    enforce(ctx.principal, "user:manage");
    const user = await users.get(ctx.params.id);
    if (!user) return error(404, "not_found");
    const grants = await rbacPolicies.listGrantsForUser(ctx.params.id);
    return ok({
      grants: grants.map((g) => ({
        id: g.id,
        role: g.role,
        scope: g.scope,
        ...parseScope(g.scope)
      }))
    });
  });

  api.route("POST", "/api/users/:id/grants", async (ctx) => {
    const user = await users.get(ctx.params.id);
    if (!user) return error(404, "not_found");
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.role !== "string") {
      return error(422, "validation_failed", { issues: [{ path: "role", message: "role is required" }] });
    }
    const scope = scopeToString(scopeInputFromBody(body));
    enforce(ctx.principal, "user:manage", scopeResource(scope));
    const row: RbacGrantRow = {
      id: randomUUID(),
      userId: ctx.params.id,
      role: body.role,
      scope,
      createdAt: nowIso()
    };
    const created = await rbacPolicies.addGrant(row);
    if (authorizer) authorizer.invalidate(ctx.params.id);
    await audit(ctx, "user.grant", "user", ctx.params.id, undefined, { role: created.role, scope: created.scope });
    return ok({ grant: { id: created.id, role: created.role, scope: created.scope, ...parseScope(created.scope) } }, 201);
  });

  api.route("DELETE", "/api/users/:id/grants/:grantId", async (ctx) => {
    const user = await users.get(ctx.params.id);
    if (!user) return error(404, "not_found");
    const grants = await rbacPolicies.listGrantsForUser(ctx.params.id);
    const target = grants.find((g) => g.id === ctx.params.grantId);
    if (!target) return error(404, "not_found", { message: "grant not found" });
    enforce(ctx.principal, "user:manage", scopeResource(target.scope));
    await rbacPolicies.removeGrant(ctx.params.grantId);
    if (authorizer) authorizer.invalidate(ctx.params.id);
    await audit(ctx, "user.revoke", "user", ctx.params.id, { role: target.role, scope: target.scope }, undefined);
    return { status: 204, body: undefined, headers: {} };
  });
}
