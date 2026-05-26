/**
 * Platform config registry: definition schema, scoped values, and the
 * resolver that combines them.
 *
 * - `/api/config/definitions` — admin CRUD over the platform-wide
 *   declarations (what keys exist, what types, default values, scopes).
 * - `/api/config/values` — scoped overrides (global / environment /
 *   tenant / tenant_pipeline / pipeline). Reads are redacted; writes
 *   demand a permission proportionate to the scope being written.
 * - `/api/config/resolved` — runs the full resolver for a (pipeline,
 *   tenant, environment) tuple so the UI can show the effective view.
 */
import {
  enforce,
  type Permission
} from "../../../../../packages/auth/src/index.ts";
import {
  redactValue,
  type ConfigDefinition,
  type ConfigValue
} from "../../../../../packages/core/src/index.ts";
import { ConfigResolver } from "../../../../../packages/config-resolver/src/index.ts";
import type {
  ConfigDefinitionRow,
  ConfigValueRow
} from "../../../../../packages/db/src/index.ts";
import { ok, error, isObject } from "../http-utils.ts";
import type { AppDeps } from "../types.ts";
import type { RouteRegistry, AuditWriter } from "./types.ts";

interface ConfigServices {
  deps: AppDeps;
  audit: AuditWriter;
}

export function registerConfigRoutes(
  api: RouteRegistry,
  svc: ConfigServices
): void {
  const { deps, audit } = svc;

  api.route("GET", "/api/config/definitions", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    return ok({ definitions: await deps.configDefinitions.list() });
  });

  api.route("PUT", "/api/config/definitions/:key", async (ctx) => {
    enforce(ctx.principal, "config:edit_global");
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.type !== "string") {
      return error(422, "validation_failed", {
        issues: [{ path: "type", message: "type is required" }]
      });
    }
    const before = await deps.configDefinitions.get(ctx.params.key);
    const row: ConfigDefinitionRow = {
      key: ctx.params.key,
      type: body.type as ConfigDefinitionRow["type"],
      defaultValue: body.defaultValue,
      allowedScopes: Array.isArray(body.allowedScopes)
        ? (body.allowedScopes as ConfigDefinitionRow["allowedScopes"])
        : ["global"],
      required: body.required === true,
      secret: body.secret === true,
      sensitive: body.sensitive === true,
      overridable: body.overridable !== false,
      inherited: body.inherited !== false,
      nullable: body.nullable === true,
      tenantOverridable: body.tenantOverridable === true,
      runtimeOverridable: body.runtimeOverridable === true,
      validation: isObject(body.validation) ? body.validation : {},
      description: typeof body.description === "string" ? body.description : null
    };
    const saved = await deps.configDefinitions.upsert(row);
    await audit(ctx, "config_definition.upsert", "config_definition", saved.key, before, saved);
    return ok({ definition: saved }, before ? 200 : 201);
  });

  api.route("DELETE", "/api/config/definitions/:key", async (ctx) => {
    enforce(ctx.principal, "config:edit_global");
    const before = await deps.configDefinitions.get(ctx.params.key);
    if (!before) return error(404, "not_found");
    await deps.configDefinitions.delete(ctx.params.key);
    await audit(ctx, "config_definition.delete", "config_definition", ctx.params.key, before, undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  api.route("GET", "/api/config/values", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const values = await deps.configValues.listConfigValues({
      key: ctx.request.query.key,
      scope: ctx.request.query.scope as ConfigValueRow["scope"] | undefined,
      // Accept both snake_case (scope_id) and camelCase (scopeId) so the web
      // can build a global -> tenant -> pipeline tree with either convention.
      scopeId: ctx.request.query.scope_id ?? ctx.request.query.scopeId
    });
    return ok({
      values: values.map((value) => ({ ...value, value: redactValue(value.value) }))
    });
  });

  api.route("POST", "/api/config/values", async (ctx) => {
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.key !== "string" || typeof body.scope !== "string") {
      return error(422, "validation_failed", {
        issues: [{ message: "key and scope are required" }]
      });
    }
    const scope = body.scope as ConfigValueRow["scope"];
    const permission: Permission =
      scope === "tenant" || scope === "tenant_pipeline"
        ? "config:edit_tenant"
        : scope === "global" || scope === "environment"
          ? "config:edit_global"
          : "config:edit_pipeline";
    enforce(ctx.principal, permission, {
      tenantId:
        scope === "tenant" ? (body.scopeId as string | undefined) : ctx.principal.tenantId
    });
    const saved = await deps.configValues.upsert({
      key: body.key,
      value: body.value,
      scope,
      scopeId: typeof body.scopeId === "string" ? body.scopeId : null,
      locked: body.locked === true,
      createdBy: ctx.principal.id
    });
    await audit(ctx, "config_value.upsert", "config_value", saved.id, undefined, {
      key: saved.key,
      scope: saved.scope,
      scopeId: saved.scopeId,
      value: redactValue(saved.value)
    });
    return ok({ value: { ...saved, value: redactValue(saved.value) } }, 201);
  });

  api.route("DELETE", "/api/config/values/:id", async (ctx) => {
    enforce(ctx.principal, "config:edit_pipeline");
    const existing = await deps.configValues.get(ctx.params.id);
    if (!existing) return error(404, "not_found");
    await deps.configValues.delete(ctx.params.id);
    await audit(ctx, "config_value.delete", "config_value", ctx.params.id, existing, undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  api.route("GET", "/api/config/resolved", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const pipelineId = ctx.request.query.pipeline_id;
    const tenantId = ctx.request.query.tenant_id;
    const environment = ctx.request.query.environment;
    if (!pipelineId || !tenantId || !environment) {
      return error(422, "validation_failed", {
        issues: [{ message: "pipeline_id, tenant_id, environment are required" }]
      });
    }
    if (
      !ctx.principal.roles.includes("platform_admin") &&
      ctx.principal.tenantId &&
      ctx.principal.tenantId !== tenantId
    ) {
      return error(403, "forbidden");
    }
    const definitionRows = await deps.configDefinitions.list();
    const definitions: ConfigDefinition[] = definitionRows.map((row) => ({
      key: row.key,
      type: row.type,
      defaultValue: row.defaultValue,
      allowedScopes: row.allowedScopes,
      required: row.required,
      secret: row.secret,
      sensitive: row.sensitive,
      overridable: row.overridable,
      inherited: row.inherited,
      nullable: row.nullable,
      tenantOverridable: row.tenantOverridable,
      runtimeOverridable: row.runtimeOverridable,
      description: row.description ?? undefined
    }));
    const valueRows = await deps.configValues.listConfigValues();
    const values: ConfigValue[] = valueRows.map((row) => ({
      key: row.key,
      value: row.value,
      scope: row.scope,
      scopeId: row.scopeId ?? undefined,
      locked: row.locked
    }));
    const resolver = new ConfigResolver(definitions);
    const resolved = resolver.resolve(
      { pipelineId, tenantId, environment, values },
      { redactSecrets: true }
    );
    return ok(resolved);
  });
}
