/**
 * API key CRUD scoped to the signed-in user. Each issued key is
 * capped at its creator's authority: the role + (tenant, env) scope
 * must be one the creator already holds, so a key can never exceed
 * its issuer.
 */
import {
  enforce,
  type Permission,
  type ApiKeyRecord,
  type ApiKeyService
} from "../../../../../packages/auth/src/index.ts";
import { scopeToString } from "../../../../../packages/authz/src/index.ts";
import type {
  EnvironmentRepository
} from "../../../../../packages/db/src/index.ts";
import { ok, error, isObject, nowIso } from "../http-utils.ts";
import { publicApiKey } from "../projections.ts";
import {
  scopeResource,
  effectiveCatalog
} from "../rbac-helpers.ts";
import type { AppDeps } from "../types.ts";
import type { RouteRegistry, AuditWriter } from "./types.ts";
import type { RbacPolicyRepository } from "../../../../../packages/db/src/index.ts";

interface ApiKeysServices {
  deps: AppDeps;
  audit: AuditWriter;
  apiKeys: ApiKeyService;
  environments: EnvironmentRepository;
  rbacPolicies: RbacPolicyRepository;
}

export function registerApiKeysRoutes(
  api: RouteRegistry,
  svc: ApiKeysServices
): void {
  const { deps, audit, apiKeys, environments, rbacPolicies } = svc;

  api.route("GET", "/api/api-keys", async (ctx) => {
    const p = ctx.principal;
    if (p.type !== "user") {
      return error(403, "forbidden", {
        message: "API keys are managed by a signed-in user"
      });
    }
    const records = await apiKeys.list(p.id);
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return ok({ apiKeys: records.map(publicApiKey) });
  });

  api.route("POST", "/api/api-keys", async (ctx) => {
    const p = ctx.principal;
    if (p.type !== "user") {
      return error(403, "forbidden", {
        message: "API keys are managed by a signed-in user"
      });
    }
    const body = ctx.request.body;
    if (
      !isObject(body) ||
      typeof body.name !== "string" ||
      body.name.trim() === ""
    ) {
      return error(422, "validation_failed", {
        issues: [{ path: "name", message: "name is required" }]
      });
    }
    if (typeof body.role !== "string" || body.role === "") {
      return error(422, "validation_failed", {
        issues: [{ path: "role", message: "role is required" }]
      });
    }
    const role = body.role;
    const tenantId =
      typeof body.tenantId === "string" && body.tenantId ? body.tenantId : undefined;
    const environmentId =
      typeof body.environmentId === "string" && body.environmentId
        ? body.environmentId.trim()
        : undefined;
    let expiresAt: string | undefined;
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      if (typeof body.expiresAt !== "string") {
        return error(422, "validation_failed", {
          issues: [{ path: "expiresAt", message: "expiresAt must be an ISO 8601 string" }]
        });
      }
      const parsed = new Date(body.expiresAt);
      if (Number.isNaN(parsed.getTime())) {
        return error(422, "validation_failed", {
          issues: [{ path: "expiresAt", message: "expiresAt is not a valid date" }]
        });
      }
      if (parsed.getTime() <= Date.now()) {
        return error(422, "validation_failed", {
          issues: [{ path: "expiresAt", message: "expiresAt must be in the future" }]
        });
      }
      expiresAt = parsed.toISOString();
    }

    const catalog = await effectiveCatalog(rbacPolicies);
    if (!catalog.has(role)) {
      return error(422, "validation_failed", {
        issues: [{ path: "role", message: `unknown role: ${role}` }]
      });
    }
    if (tenantId) {
      const tenant = await deps.tenants.get(tenantId);
      if (!tenant) {
        return error(422, "validation_failed", {
          issues: [{ path: "tenantId", message: "unknown tenant" }]
        });
      }
    }
    if (environmentId) {
      if (!tenantId) {
        return error(422, "validation_failed", {
          issues: [{ path: "environmentId", message: "environmentId requires tenantId" }]
        });
      }
      const envs = await environments.listByTenant(tenantId);
      if (!envs.find((e) => e.name === environmentId)) {
        return error(422, "validation_failed", {
          issues: [{ path: "environmentId", message: `unknown environment: ${environmentId}` }]
        });
      }
    }

    // Cap the key at its creator's authority: `enforce` throws
    // AuthorizationError → 403 for any permission of `role` the
    // creator does not hold at this scope.
    const resource = scopeResource(
      scopeToString({ tenantId, environment: environmentId })
    );
    for (const permission of catalog.get(role) ?? []) {
      enforce(p, permission as Permission, resource);
    }

    const issued = await apiKeys.issue({
      principalId: p.id,
      tenantId,
      environmentId,
      name: body.name.trim(),
      roles: [role] as ApiKeyRecord["roles"],
      expiresAt
    });
    await audit(
      ctx,
      "apikey.create",
      "api_key",
      issued.id,
      undefined,
      publicApiKey(issued.record)
    );
    return ok(
      { apiKey: publicApiKey(issued.record), plaintext: issued.plaintext },
      201
    );
  });

  api.route("DELETE", "/api/api-keys/:id", async (ctx) => {
    const p = ctx.principal;
    if (p.type !== "user") {
      return error(403, "forbidden", {
        message: "API keys are managed by a signed-in user"
      });
    }
    const target = (await apiKeys.list(p.id)).find(
      (k) => k.id === ctx.params.id
    );
    if (!target) {
      return error(404, "not_found", { message: "API key not found" });
    }
    await apiKeys.revoke(target.id);
    await audit(
      ctx,
      "apikey.revoke",
      "api_key",
      target.id,
      publicApiKey(target),
      publicApiKey({ ...target, revokedAt: target.revokedAt ?? nowIso() })
    );
    return { status: 204, body: undefined, headers: {} };
  });
}
