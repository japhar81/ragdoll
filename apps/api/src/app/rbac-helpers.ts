/**
 * RBAC scope + catalog helpers shared by the auth / users / roles
 * route modules. Pure where possible; `effectiveCatalog` is async
 * because it reads `rbac_role_permissions` (falling back to the
 * built-in defaults when the table is empty).
 */
import {
  ALL_ROLES,
  DEFAULT_ROLE_PERMISSIONS,
  parseScope,
  type ScopeInput
} from "../../../../packages/authz/src/index.ts";
import type { RbacPolicyRepository } from "../../../../packages/db/src/index.ts";

export function scopeInputFromBody(
  body: Record<string, unknown>
): ScopeInput {
  if (typeof body.scope === "string" && body.scope.length > 0) {
    return parseScope(body.scope);
  }
  return {
    tenantId: typeof body.tenantId === "string" ? body.tenantId : undefined,
    environment:
      typeof body.environment === "string" ? body.environment : undefined,
    pipelineId:
      typeof body.pipelineId === "string" ? body.pipelineId : undefined
  };
}

export function scopeResource(scope: string): {
  tenantId?: string;
  pipelineId?: string;
  environment?: string;
} {
  const s = parseScope(scope);
  return {
    tenantId: s.tenantId ?? undefined,
    environment: s.environment ?? undefined,
    pipelineId: s.pipelineId ?? undefined
  };
}

export function defaultPermsFor(role: string): string[] {
  return (
    (DEFAULT_ROLE_PERMISSIONS as Record<string, string[]>)[role] ?? []
  );
}

/**
 * Effective role → permission catalog: the DB store if populated,
 * else the built-in defaults (so a fresh / in-memory deployment works
 * with no seed).
 */
export async function effectiveCatalog(
  rbacPolicies: RbacPolicyRepository
): Promise<Map<string, Set<string>>> {
  const rows = await rbacPolicies.listRolePermissions();
  const catalog = new Map<string, Set<string>>();
  const source = rows.length
    ? rows
    : ALL_ROLES.flatMap((r) =>
        defaultPermsFor(r).map((permission) => ({ role: r, permission }))
      );
  for (const { role, permission } of source) {
    let set = catalog.get(role);
    if (!set) {
      set = new Set();
      catalog.set(role, set);
    }
    set.add(permission);
  }
  return catalog;
}
