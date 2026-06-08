/**
 * Local auth: login / signup / logout + the /me + password endpoints.
 * SSO + providers live in ./auth-sso.ts; admin user management lives
 * in ./users.ts.
 */
import {
  enforce,
  InvalidCredentialsError,
  AccountDisabledError,
  SignupDisabledError,
  EmailInUseError,
  type AccountService,
  type PasswordService
} from "../../../../../packages/auth/src/index.ts";
import type {
  UserRow,
  UserRepository,
  RbacPolicyRepository
} from "../../../../../packages/db/src/index.ts";
import { ok, error, isObject, nowIso } from "../http-utils.ts";
import { publicUser } from "../projections.ts";
import { effectiveCatalog } from "../rbac-helpers.ts";
import type { AppDeps } from "../types.ts";
import type { RouteRegistry, AuditWriter } from "./types.ts";

interface AuthServices {
  deps: AppDeps;
  audit: AuditWriter;
  accounts?: AccountService;
  passwords: PasswordService;
  users: UserRepository;
  rbacPolicies: RbacPolicyRepository;
}

export function registerAuthRoutes(
  api: RouteRegistry,
  svc: AuthServices
): void {
  const { audit, accounts, passwords, users, rbacPolicies } = svc;
  void svc.deps; // future-use; keeps the deps signature uniform

  api.route("POST", "/api/auth/login", async (ctx) => {
    if (!accounts) return error(501, "auth_not_configured");
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.email !== "string" || typeof body.password !== "string") {
      return error(422, "validation_failed", { issues: [{ message: "email and password are required" }] });
    }
    try {
      const out = await accounts.loginLocal(body.email, body.password);
      return ok({ token: out.token, user: publicUser(out.user as UserRow) });
    } catch (e) {
      if (e instanceof InvalidCredentialsError) return error(401, "invalid_credentials");
      if (e instanceof AccountDisabledError) return error(403, "account_disabled");
      throw e;
    }
  });

  api.route("POST", "/api/auth/signup", async (ctx) => {
    if (!accounts) return error(501, "auth_not_configured");
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.email !== "string" || typeof body.password !== "string") {
      return error(422, "validation_failed", { issues: [{ message: "email and password are required" }] });
    }
    try {
      const out = await accounts.signupLocal({
        email: body.email,
        password: body.password,
        displayName: typeof body.displayName === "string" ? body.displayName : undefined
      });
      return ok({ token: out.token, user: publicUser(out.user as UserRow) }, 201);
    } catch (e) {
      if (e instanceof SignupDisabledError) return error(403, "signup_disabled");
      if (e instanceof EmailInUseError) return error(409, "email_in_use");
      if (e instanceof Error && e.name === "WeakPasswordError") {
        return error(422, "weak_password", { message: e.message });
      }
      throw e;
    }
  });

  api.route("POST", "/api/auth/logout", async (ctx) => {
    // ADR-0011 follow-through: when a shared revocation store is wired,
    // log the token out for every replica (not just this one). The
    // session signer is stateless by construction, so we identify the
    // token to revoke by re-parsing the Authorization header.
    const authHeader = ctx.request.headers["authorization"];
    const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (typeof raw === "string" && raw.startsWith("Bearer ")) {
      const token = raw.slice("Bearer ".length).trim();
      if (token && svc.deps.sessions) {
        await svc.deps.sessions.revoke(token);
      }
    }
    return { status: 204, body: undefined, headers: {} };
  });

  api.route("GET", "/api/auth/me", async (ctx) => {
    const p = ctx.principal;
    const user = p.type === "user" ? await users.get(p.id) : undefined;
    let grants: Array<{ role: string; scope: string }>;
    if (p.type === "user" && (!p.roles || p.roles.length === 0)) {
      grants = (await rbacPolicies.listGrantsForUser(p.id)).map((g) => ({
        role: g.role,
        scope: g.scope
      }));
    } else {
      const scope = p.tenantId ? `t/${p.tenantId}` : "*";
      grants = (p.roles ?? []).map((role) => ({ role, scope }));
    }
    const catalog = await effectiveCatalog(rbacPolicies);
    const permissions = [
      ...new Set(grants.flatMap((g) => [...(catalog.get(g.role) ?? [])]))
    ];
    return ok({
      principal: { id: p.id, type: p.type, tenantId: p.tenantId ?? null },
      user: user ? publicUser(user) : null,
      grants,
      permissions
    });
  });

  // ---- self-service profile ----------------------------------------------
  // Any signed-in user may edit their OWN account; these need no permission
  // grant (the principal IS the resource). API-key principals have no
  // editable account, so they are refused.
  api.route("PATCH", "/api/auth/me", async (ctx) => {
    const p = ctx.principal;
    if (p.type !== "user") {
      return error(403, "forbidden", {
        message: "no editable profile for this principal"
      });
    }
    const before = await users.get(p.id);
    if (!before) return error(404, "not_found");
    const body = ctx.request.body;
    if (!isObject(body)) return error(422, "validation_failed", { issues: [] });
    const patch: Partial<UserRow> = { updatedAt: nowIso() };
    if (typeof body.displayName === "string" || body.displayName === null) {
      patch.displayName = body.displayName as string | null;
    }
    const updated = await users.update(p.id, patch);
    await audit(ctx, "user.update", "user", p.id, publicUser(before), publicUser(updated));
    return ok({ user: publicUser(updated) });
  });

  api.route("POST", "/api/auth/password", async (ctx) => {
    const p = ctx.principal;
    if (p.type !== "user") {
      return error(403, "forbidden", {
        message: "no password for this principal"
      });
    }
    const user = await users.get(p.id);
    if (!user) return error(404, "not_found");
    const body = ctx.request.body;
    if (
      !isObject(body) ||
      typeof body.newPassword !== "string" ||
      body.newPassword.length < 8
    ) {
      return error(422, "validation_failed", {
        issues: [
          { path: "newPassword", message: "newPassword must be at least 8 characters" }
        ]
      });
    }
    // A user who already has a password must prove they know it. An SSO-only
    // account (no stored hash) may set an initial password without one.
    if (user.passwordHash) {
      const current =
        typeof body.currentPassword === "string" ? body.currentPassword : "";
      if (!(await passwords.verify(current, user.passwordHash))) {
        return error(403, "invalid_credentials", {
          message: "current password is incorrect"
        });
      }
    }
    let passwordHash: string;
    try {
      passwordHash = await passwords.hash(body.newPassword);
    } catch (e) {
      if (e instanceof Error && e.name === "WeakPasswordError") {
        return error(422, "validation_failed", {
          issues: [{ path: "newPassword", message: "password is too weak" }]
        });
      }
      throw e;
    }
    await users.update(p.id, { passwordHash, updatedAt: nowIso() });
    await audit(ctx, "user.password_change", "user", p.id, undefined, undefined);
    void enforce; // imported for parity; not used in self-service paths
    return ok({ ok: true });
  });
}
