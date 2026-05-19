/**
 * Pure, DOM-free helpers for the app's tenant/auth request context.
 *
 * The control-plane's DevAuthProvider reads `x-roles` and `x-tenant-id`
 * headers to synthesize a principal outside production. Tenant-scoped routes
 * (run, resolved-config, deploy, tenant-pipelines, activations, schedules,
 * config, secrets) reject requests with no tenant context
 * (HTTP 422 validation_failed — "tenant context required").
 *
 * Critically the `x-tenant-id` header must be the tenant **UUID**, never the
 * slug: deployments/activations are keyed by tenant uuid, so a slug yields
 * 409/empty. `buildAuthHeaders` therefore drops a non-UUID tenant id rather
 * than send a slug, and `pickDefaultTenant` returns the row (so callers read
 * `.id`) instead of a bare string.
 *
 * No React/DOM imports so this is unit-testable with `node --test`, zero
 * install. Kept independent of api.ts so the tests need no fetch shim.
 */

/** Minimal tenant row shape (a structural subset of api.ts `TenantRow`). */
export interface TenantLike {
  id: string;
  slug: string;
  name: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical 8-4-4-4-12 UUID string (any version). */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

/** The dev role the control-plane's DevAuthProvider grants to admins. */
export const DEV_ADMIN_ROLE = "platform_admin";

export interface AuthContext {
  /** Bearer token, when one is configured. */
  token?: string;
  /** Static API key, when one is configured. */
  apiKey?: string;
  /** Selected tenant — MUST be a tenant UUID, not a slug. */
  tenantId?: string;
  /** Dev roles header value (defaults to `platform_admin`). */
  roles?: string;
}

/**
 * Build the headers every `/api/*` request should carry.
 *
 * The control plane is default-deny: real auth is a `Bearer` session token
 * (issued by /api/auth/login or SSO). The insecure `x-roles` dev header is
 * only emitted when a caller *explicitly* sets `roles` AND the server has
 * RAGDOLL_DEV_AUTH=1 — it is never defaulted. `x-tenant-id` is sent only when
 * a UUID tenant is selected (a slug is dropped; it would 409/empty downstream).
 *
 * Returns a fresh object; never mutates the input.
 */
export function buildAuthHeaders(ctx: AuthContext = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (ctx.roles && ctx.roles.trim()) headers["x-roles"] = ctx.roles.trim();
  if (ctx.token) headers.authorization = `Bearer ${ctx.token}`;
  if (ctx.apiKey) headers["x-api-key"] = ctx.apiKey;
  if (ctx.tenantId && isUuid(ctx.tenantId)) {
    headers["x-tenant-id"] = ctx.tenantId.trim();
  }
  return headers;
}

/**
 * Choose a sensible default tenant from a fetched list so the bundled demo
 * "just works": prefer the one whose slug matches `preferredSlug` (defaults
 * to `tenant-local`), else fall back to the first tenant. Returns the row
 * (callers read `.id`) or `undefined` when the list is empty/missing.
 */
export function pickDefaultTenant(
  tenants: readonly TenantLike[] | undefined | null,
  preferredSlug = "tenant-local"
): TenantLike | undefined {
  if (!tenants || tenants.length === 0) return undefined;
  return tenants.find((t) => t.slug === preferredSlug) ?? tenants[0];
}

/**
 * Extract the tenant id from a Config/Secrets scope-tree key. Keys look like
 * `global`, `tenant:<id>`, or `tenant:<id>|pipeline:<id>`. Returns the tenant
 * id segment, or `undefined` for the global root (no tenant scope).
 */
export function tenantIdFromScopeKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const m = /^tenant:([^|]+)/.exec(key);
  return m ? m[1] : undefined;
}
