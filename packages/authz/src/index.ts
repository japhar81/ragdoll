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
  | "provider:manage";

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

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  platform_admin: [
    "pipeline:create", "pipeline:update", "pipeline:delete", "pipeline:deploy",
    "config:edit_global", "config:edit_pipeline", "config:edit_tenant",
    "secret:manage_tenant", "execution:view_logs", "execution:view_sensitive",
    "audit:view", "pipeline:run", "plugin:manage", "provider:manage"
  ],
  environment_admin: ["pipeline:deploy", "config:edit_pipeline", "execution:view_logs", "audit:view", "pipeline:run"],
  pipeline_admin: ["pipeline:create", "pipeline:update", "pipeline:delete", "pipeline:deploy", "config:edit_pipeline", "execution:view_logs", "pipeline:run"],
  pipeline_editor: ["pipeline:create", "pipeline:update", "config:edit_pipeline", "pipeline:run"],
  tenant_admin: ["config:edit_tenant", "secret:manage_tenant", "execution:view_logs", "pipeline:run"],
  tenant_operator: ["execution:view_logs", "pipeline:run"],
  viewer: ["execution:view_logs"],
  auditor: ["audit:view", "execution:view_logs"]
};

export function authorize(principal: Principal, permission: Permission, resource: Resource = {}): boolean {
  const permissions = new Set(principal.roles.flatMap((role) => ROLE_PERMISSIONS[role] ?? []));
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

export class AuthorizationError extends Error {
  constructor(permission: Permission) {
    super(`Missing permission ${permission}`);
    this.name = "AuthorizationError";
  }
}
