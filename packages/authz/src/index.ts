/**
 * @ragdoll/authz — RBAC with hierarchical scopes.
 *
 * Authorization is a Casbin policy: a user holds a *role* within a *scope*
 * (Casbin `g`), and a role grants *permissions* (Casbin `p`). The scope is the
 * Casbin domain and is hierarchical:
 *
 *     *                       global (platform-wide)
 *     t/<tenantId>            a whole tenant
 *     t/<tenantId>/e/<env>    one environment of a tenant
 *     t/<tenantId>/p/<pid>    one pipeline of a tenant
 *
 * A grant at an ancestor scope covers every descendant request scope, so a
 * tenant-admin grant (`t/T`) authorizes pipeline-level actions inside tenant T
 * while an env-admin grant (`t/T/e/prod`) does not authorize tenant-wide ones.
 *
 * Two decision engines implement the SAME model: a dependency-free
 * {@link BuiltinPolicyEngine} (used by the install-free test runner and as the
 * production fallback) and a real Casbin engine in `./casbin.ts`. A conformance
 * test pins them to identical decisions.
 *
 * The legacy `authorize`/`requirePermission`/`ROLE_PERMISSIONS` API is retained
 * unchanged so existing callers and tests keep working; new code goes through
 * {@link Authorizer}.
 */

// ---------------------------------------------------------------------------
// Roles & permissions
// ---------------------------------------------------------------------------

export type Role =
  | "platform_admin"
  | "environment_admin"
  | "pipeline_admin"
  | "pipeline_editor"
  | "tenant_admin"
  | "tenant_operator"
  | "viewer"
  | "auditor";

export type Permission =
  | "pipeline:create"
  | "pipeline:update"
  | "pipeline:delete"
  | "pipeline:deploy"
  | "config:edit_global"
  | "config:edit_pipeline"
  | "config:edit_tenant"
  | "secret:manage_tenant"
  | "execution:view_logs"
  | "execution:view_sensitive"
  | "audit:view"
  | "pipeline:run"
  | "plugin:manage"
  | "provider:manage"
  // Access-control administration (new).
  | "user:manage"
  | "role:manage"
  | "idp:manage"
  | "auth:settings";

export interface Principal {
  id: string;
  tenantId?: string;
  roles: Role[];
}

export interface Resource {
  tenantId?: string;
  pipelineId?: string;
  environment?: string;
}

/**
 * Built-in default role -> permission catalog. This is the source of truth for
 * a fresh / in-memory install (and the legacy `authorize`). When the database
 * `rbac_role_permissions` table is populated it overrides this entirely, so
 * operators can edit roles in the admin UI.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  platform_admin: [
    "pipeline:create", "pipeline:update", "pipeline:delete", "pipeline:deploy",
    "config:edit_global", "config:edit_pipeline", "config:edit_tenant",
    "secret:manage_tenant", "execution:view_logs", "execution:view_sensitive",
    "audit:view", "pipeline:run", "plugin:manage", "provider:manage",
    "user:manage", "role:manage", "idp:manage", "auth:settings"
  ],
  environment_admin: ["pipeline:deploy", "config:edit_pipeline", "execution:view_logs", "audit:view", "pipeline:run"],
  pipeline_admin: ["pipeline:create", "pipeline:update", "pipeline:delete", "pipeline:deploy", "config:edit_pipeline", "execution:view_logs", "pipeline:run"],
  pipeline_editor: ["pipeline:create", "pipeline:update", "config:edit_pipeline", "pipeline:run"],
  tenant_admin: ["config:edit_tenant", "secret:manage_tenant", "execution:view_logs", "pipeline:run", "user:manage"],
  tenant_operator: ["execution:view_logs", "pipeline:run"],
  viewer: ["execution:view_logs"],
  auditor: ["audit:view", "execution:view_logs"]
};

/** Back-compat alias (was the only exported catalog before scopes existed). */
export const ROLE_PERMISSIONS = DEFAULT_ROLE_PERMISSIONS;

/** Every known permission, e.g. for the role editor UI. */
export const ALL_PERMISSIONS: Permission[] = [
  ...new Set(Object.values(DEFAULT_ROLE_PERMISSIONS).flat())
] as Permission[];

export const ALL_ROLES: Role[] = Object.keys(DEFAULT_ROLE_PERMISSIONS) as Role[];

export class AuthorizationError extends Error {
  constructor(permission: string) {
    super(`Missing permission ${permission}`);
    this.name = "AuthorizationError";
  }
}

// ---------------------------------------------------------------------------
// Legacy flat RBAC (unchanged behaviour; used by `enforce` fallback + tests)
// ---------------------------------------------------------------------------

export function authorize(principal: Principal, permission: Permission, resource: Resource = {}): boolean {
  const permissions = new Set(principal.roles.flatMap((role) => DEFAULT_ROLE_PERMISSIONS[role] ?? []));
  if (!permissions.has(permission)) return false;
  if (principal.roles.includes("platform_admin")) return true;
  if (resource.tenantId && principal.tenantId && principal.tenantId !== resource.tenantId) return false;
  return true;
}

export function requirePermission(principal: Principal, permission: Permission, resource: Resource = {}): void {
  if (!authorize(principal, permission, resource)) {
    throw new AuthorizationError(permission);
  }
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

export interface ScopeInput {
  tenantId?: string | null;
  environment?: string | null;
  pipelineId?: string | null;
}

export const GLOBAL_SCOPE = "*";

/**
 * Canonical scope string for a resource. Environment and pipeline are only
 * meaningful within a tenant; a pipeline scope wins over an environment scope
 * when both are present (the action targets a specific pipeline).
 */
export function scopeToString(input: ScopeInput): string {
  const t = input.tenantId?.trim();
  if (!t) return GLOBAL_SCOPE;
  if (input.pipelineId?.trim()) return `t/${t}/p/${input.pipelineId.trim()}`;
  if (input.environment?.trim()) return `t/${t}/e/${input.environment.trim()}`;
  return `t/${t}`;
}

export function resourceToScope(resource: Resource = {}): string {
  return scopeToString(resource);
}

/** Parse a scope string back into its parts (for display / validation). */
export function parseScope(scope: string): ScopeInput {
  if (!scope || scope === GLOBAL_SCOPE) return {};
  const m = /^t\/([^/]+)(?:\/(e|p)\/(.+))?$/.exec(scope);
  if (!m) return {};
  const out: ScopeInput = { tenantId: m[1] };
  if (m[2] === "e") out.environment = m[3];
  if (m[2] === "p") out.pipelineId = m[3];
  return out;
}

/**
 * True when a grant made at `grantScope` authorizes a request at
 * `requestScope` — i.e. the grant scope is an ancestor of (or equal to) the
 * request scope. This is the Casbin domain-matching function and the heart of
 * the hierarchy.
 */
export function scopeCovers(grantScope: string, requestScope: string): boolean {
  if (grantScope === GLOBAL_SCOPE) return true;
  if (grantScope === requestScope) return true;
  const g = parseScope(grantScope);
  const r = parseScope(requestScope);
  if (!g.tenantId) return false; // only `*` (handled above) is tenant-less
  if (g.tenantId !== r.tenantId) return false;
  // Tenant-wide grant (`t/T`) covers any env/pipeline request in that tenant.
  if (!g.environment && !g.pipelineId) return true;
  // Env grant covers only that exact environment; pipeline grant only that
  // exact pipeline. (Equality already handled above.)
  return false;
}

// ---------------------------------------------------------------------------
// Policy engine
// ---------------------------------------------------------------------------

export interface Grant {
  role: string;
  scope: string;
}

export interface RolePermissionRow {
  role: string;
  permission: string;
}

/** role -> set of permissions ("*" means all). */
export type RoleCatalog = Map<string, Set<string>>;

export function buildCatalog(rows: RolePermissionRow[]): RoleCatalog {
  const catalog: RoleCatalog = new Map();
  for (const { role, permission } of rows) {
    let set = catalog.get(role);
    if (!set) {
      set = new Set();
      catalog.set(role, set);
    }
    set.add(permission);
  }
  return catalog;
}

/** The built-in defaults as catalog rows (used when the DB store is empty). */
export function defaultCatalogRows(): RolePermissionRow[] {
  const rows: RolePermissionRow[] = [];
  for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    for (const permission of perms) rows.push({ role, permission });
  }
  return rows;
}

/**
 * Pure decision over an explicit grant list. Allowed iff some grant's role
 * grants `permission` (or `*`) AND the grant's scope covers the request scope.
 */
export function evaluate(
  grants: Grant[],
  catalog: RoleCatalog,
  permission: string,
  requestScope: string
): boolean {
  for (const grant of grants) {
    if (!scopeCovers(grant.scope, requestScope)) continue;
    const perms = catalog.get(grant.role);
    if (!perms) continue;
    if (perms.has("*") || perms.has(permission)) return true;
  }
  return false;
}

/** A prepared, synchronous decision function for one principal's grant set. */
export type ScopedDecider = (
  permission: string,
  requestScope: string
) => boolean;

export interface PolicyEngine {
  /**
   * Compile a principal's grants + the catalog into a synchronous decider.
   * Async so the Casbin engine can build its enforcer here (off the hot path
   * of the ~65 synchronous `enforce(...)` route call sites).
   */
  prepare(grants: Grant[], catalog: RoleCatalog): Promise<ScopedDecider>;
}

/** Dependency-free reference engine. Default everywhere; fallback in prod. */
export class BuiltinPolicyEngine implements PolicyEngine {
  async prepare(
    grants: Grant[],
    catalog: RoleCatalog
  ): Promise<ScopedDecider> {
    return (permission, requestScope) =>
      evaluate(grants, catalog, permission, requestScope);
  }
}

/**
 * The Casbin model. Domains are scope strings; `scopeCovers` is registered as
 * the named domain-matching function for `g`, giving hierarchical inheritance.
 * `p` is scope-independent (the role -> permission catalog); `*` is a wildcard
 * permission used by `platform_admin`.
 */
export const CASBIN_MODEL = `
[request_definition]
r = sub, dom, obj

[policy_definition]
p = sub, obj

[role_definition]
g = _, _, _

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub, p.sub, r.dom) && (p.obj == r.obj || p.obj == "*")
`.trim();

// ---------------------------------------------------------------------------
// Authorizer
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of the RBAC policy store (the db package's
 * `RbacPolicyRepository` satisfies this without authz depending on db).
 */
export interface PolicyStore {
  listRolePermissions(): Promise<RolePermissionRow[]>;
  listGrantsForUser(userId: string): Promise<Grant[]>;
}

export type PrincipalKind = "user" | "service" | "api_key";

export interface AuthorizablePrincipal {
  id: string;
  type: PrincipalKind;
  tenantId?: string;
  roles: Role[];
}

/**
 * Resolves a principal's effective grants from the store (real users) or by
 * synthesising them from carried roles (API keys / service / dev), then hands
 * back a SYNCHRONOUS decision closure so route handlers keep calling
 * `enforce(...)` without becoming async. The catalog and per-user grants are
 * cached; `invalidate()` is called by the admin routes after any RBAC write so
 * changes (including revocations) take effect immediately.
 */
export class Authorizer {
  private engine: PolicyEngine;
  private store?: PolicyStore;
  private catalog?: RoleCatalog;
  private grantCache = new Map<string, Grant[]>();

  constructor(options: { engine?: PolicyEngine; store?: PolicyStore } = {}) {
    this.engine = options.engine ?? new BuiltinPolicyEngine();
    this.store = options.store;
  }

  invalidate(userId?: string): void {
    this.catalog = undefined;
    if (userId) this.grantCache.delete(userId);
    else this.grantCache.clear();
  }

  private async loadCatalog(): Promise<RoleCatalog> {
    if (this.catalog) return this.catalog;
    let rows: RolePermissionRow[] = [];
    if (this.store) {
      try {
        rows = await this.store.listRolePermissions();
      } catch {
        rows = [];
      }
    }
    // Empty store => brand-new/in-memory install: fall back to built-ins so a
    // fresh deployment (and the test harness) is immediately functional.
    const catalog = buildCatalog(rows.length ? rows : defaultCatalogRows());
    this.catalog = catalog;
    return catalog;
  }

  /** Grants a non-user principal carries, mapped onto its scope. */
  private synthesizeGrants(p: AuthorizablePrincipal): Grant[] {
    const scope = p.tenantId ? `t/${p.tenantId}` : GLOBAL_SCOPE;
    return p.roles.map((role) => ({ role, scope }));
  }

  private async grantsFor(p: AuthorizablePrincipal): Promise<Grant[]> {
    // Principals that carry explicit roles (API keys, services, the dev
    // provider) are authorised from those roles at their own scope. Only
    // session users — who carry NO roles in their token, so grants are looked
    // up live for instant revocation — go through the policy store.
    if ((p.roles && p.roles.length > 0) || p.type !== "user" || !this.store) {
      return this.synthesizeGrants(p);
    }
    const cached = this.grantCache.get(p.id);
    if (cached) return cached;
    let grants: Grant[] = [];
    try {
      grants = (await this.store.listGrantsForUser(p.id)).map((g) => ({
        role: g.role,
        scope: g.scope
      }));
    } catch {
      grants = [];
    }
    this.grantCache.set(p.id, grants);
    return grants;
  }

  /** Effective grants for display/debugging (no caching guarantees). */
  async resolveGrants(p: AuthorizablePrincipal): Promise<Grant[]> {
    return this.grantsFor(p);
  }

  /**
   * Build the per-request sync authorizer closure. Call once after the
   * principal is resolved; attach the result so `enforce` can use it.
   */
  async authorizeClosure(
    p: AuthorizablePrincipal,
    options: { defaultTenantId?: string } = {}
  ): Promise<(permission: string, resource?: Resource) => boolean> {
    const catalog = await this.loadCatalog();
    const grants = await this.grantsFor(p);
    const decider = await this.engine.prepare(grants, catalog);
    // Mirror the legacy `tenantId ?? principal.tenantId` merge: when a route
    // does not name a tenant, fall back to the request's tenant context (the
    // selected `x-tenant-id`, else the principal's own tenant). This keeps the
    // ~65 existing `enforce(...)` call sites correct without edits while still
    // gating instance-wide permissions, which only `platform_admin` (granted
    // at `*`) holds regardless of the scope the request runs in.
    const fallbackTenant = options.defaultTenantId ?? p.tenantId;
    return (permission: string, resource: Resource = {}) =>
      decider(
        permission,
        scopeToString({
          tenantId: resource.tenantId ?? fallbackTenant,
          environment: resource.environment,
          pipelineId: resource.pipelineId
        })
      );
  }
}
