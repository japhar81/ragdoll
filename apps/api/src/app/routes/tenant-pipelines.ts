/**
 * Tenant ↔ pipeline associations + their activations.
 *
 * - `/api/tenants/:id/pipelines` — per-tenant view that unions the
 *   association rows + their activations bucketed by (pipelineId,
 *   environment).
 * - Activation CRUD lets a tenant pin a pipeline to a specific version
 *   (or track-latest) per environment with a stable label.
 */
import { randomUUID } from "node:crypto";
import { enforce } from "../../../../../packages/auth/src/index.ts";
import type {
  PipelineActivationRow,
  PipelineActivationRepository,
  TenantPipelineRow,
  TenantPipelineRepository
} from "../../../../../packages/db/src/index.ts";
import { ok, error, isObject, nowIso } from "../http-utils.ts";
import { projectActivation } from "../projections.ts";
import {
  resolvePipelineRef,
  isAppResponse
} from "../pipeline-resolution.ts";
import type { AppDeps } from "../types.ts";
import type { RouteRegistry, AuditWriter } from "./types.ts";

interface TenantPipelinesServices {
  deps: AppDeps;
  audit: AuditWriter;
  tenantPipelines: TenantPipelineRepository;
  pipelineActivations: PipelineActivationRepository;
}

export function registerTenantPipelinesRoutes(
  api: RouteRegistry,
  svc: TenantPipelinesServices
): void {
  const { deps, audit, tenantPipelines, pipelineActivations } = svc;

  api.route("GET", "/api/tenants/:id/pipelines", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs", { tenantId: ctx.params.id });
    if (
      !ctx.principal.roles.includes("platform_admin") &&
      ctx.principal.tenantId &&
      ctx.principal.tenantId !== ctx.params.id
    ) {
      return error(403, "forbidden");
    }
    const associations = await tenantPipelines.listByTenant(ctx.params.id);
    const activations = await pipelineActivations.listByTenant(ctx.params.id);
    const byPipelineEnv = new Map<string, PipelineActivationRow[]>();
    const envKey = (pipelineId: string, environment: string): string =>
      `${pipelineId}::${environment}`;
    for (const act of activations) {
      const k = envKey(act.pipelineId, act.environment);
      const bucket = byPipelineEnv.get(k) ?? [];
      bucket.push(act);
      byPipelineEnv.set(k, bucket);
    }
    const seen = new Set<string>();
    const pairs: Array<{ pipelineId: string; environment: string }> = [];
    for (const a of associations) {
      const k = envKey(a.pipelineId, a.environment);
      if (!seen.has(k)) {
        seen.add(k);
        pairs.push({ pipelineId: a.pipelineId, environment: a.environment });
      }
    }
    for (const a of activations) {
      const k = envKey(a.pipelineId, a.environment);
      if (!seen.has(k)) {
        seen.add(k);
        pairs.push({ pipelineId: a.pipelineId, environment: a.environment });
      }
    }
    const out: Array<Record<string, unknown>> = [];
    for (const { pipelineId, environment } of pairs) {
      const pipeline = await deps.pipelines.get(pipelineId);
      const assoc = associations.find(
        (a) => a.pipelineId === pipelineId && a.environment === environment
      );
      out.push({
        pipelineId,
        environment,
        enabled: assoc ? assoc.enabled : false,
        activations: (byPipelineEnv.get(envKey(pipelineId, environment)) ?? []).map((row) =>
          projectActivation(row, pipeline?.latestVersionId ?? null)
        )
      });
    }
    return ok({ pipelines: out });
  });

  api.route("POST", "/api/tenants/:id/pipelines", async (ctx) => {
    enforce(ctx.principal, "config:edit_tenant", { tenantId: ctx.params.id });
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.pipelineId !== "string") {
      return error(422, "validation_failed", {
        issues: [{ path: "pipelineId", message: "pipelineId is required" }]
      });
    }
    const pipeline = await deps.pipelines.get(body.pipelineId);
    if (!pipeline) return error(404, "not_found", { message: "pipeline not found" });
    const environment =
      typeof body.environment === "string" && body.environment
        ? body.environment
        : "dev";
    const row: TenantPipelineRow = {
      tenantId: ctx.params.id,
      pipelineId: body.pipelineId,
      environment,
      enabled: true,
      vectorIsolation: isObject(body.vectorIsolation) ? body.vectorIsolation : {},
      providerPolicy: isObject(body.providerPolicy) ? body.providerPolicy : {},
      rateLimitPolicy: isObject(body.rateLimitPolicy) ? body.rateLimitPolicy : {},
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    const saved = await tenantPipelines.upsert(row);
    await audit(ctx, "tenant_pipeline.associate", "tenant_pipeline", `${ctx.params.id}:${body.pipelineId}`, undefined, saved);
    return ok({ association: saved }, 201);
  });

  api.route("PATCH", "/api/tenants/:id/pipelines/:pid", async (ctx) => {
    enforce(ctx.principal, "config:edit_tenant", { tenantId: ctx.params.id });
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.enabled !== "boolean") {
      return error(422, "validation_failed", {
        issues: [{ path: "enabled", message: "enabled (boolean) is required" }]
      });
    }
    const environment =
      typeof body.environment === "string" && body.environment
        ? body.environment
        : "dev";
    const existing = await tenantPipelines.get({
      tenantId: ctx.params.id,
      pipelineId: ctx.params.pid,
      environment
    });
    if (!existing) return error(404, "not_found", { message: "association not found" });
    const saved = await tenantPipelines.upsert({
      ...existing,
      enabled: body.enabled,
      updatedAt: nowIso()
    });
    await audit(ctx, "tenant_pipeline.update", "tenant_pipeline", `${ctx.params.id}:${ctx.params.pid}`, existing, saved);
    return ok({ association: saved });
  });

  api.route("GET", "/api/tenants/:id/pipelines/:pid/activations", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs", { tenantId: ctx.params.id });
    if (
      !ctx.principal.roles.includes("platform_admin") &&
      ctx.principal.tenantId &&
      ctx.principal.tenantId !== ctx.params.id
    ) {
      return error(403, "forbidden");
    }
    const pipeline = await resolvePipelineRef(deps.pipelines, ctx.params.pid);
    if (isAppResponse(pipeline)) return pipeline;
    const rows = (
      await pipelineActivations.listByTenant(ctx.params.id)
    ).filter((row) => row.pipelineId === pipeline.id);
    return ok({
      activations: rows.map((row) =>
        projectActivation(row, pipeline.latestVersionId ?? null)
      )
    });
  });

  api.route("POST", "/api/tenants/:id/pipelines/:pid/activations", async (ctx) => {
    enforce(ctx.principal, "config:edit_tenant", { tenantId: ctx.params.id });
    const pipeline = await resolvePipelineRef(deps.pipelines, ctx.params.pid);
    if (isAppResponse(pipeline)) return pipeline;
    const body = ctx.request.body;
    if (
      !isObject(body) ||
      typeof body.label !== "string" ||
      body.label.length === 0 ||
      typeof body.environment !== "string" ||
      body.environment.length === 0
    ) {
      return error(422, "validation_failed", {
        issues: [{ message: "label and environment are required" }]
      });
    }
    const trackLatest = body.trackLatest === true;
    if (
      !trackLatest &&
      (typeof body.pipelineVersionId !== "string" || body.pipelineVersionId.length === 0)
    ) {
      return error(422, "validation_failed", {
        issues: [
          { message: "a pinned activation requires pipelineVersionId or trackLatest:true" }
        ]
      });
    }
    const row: PipelineActivationRow = {
      id: typeof body.id === "string" ? body.id : randomUUID(),
      tenantId: ctx.params.id,
      pipelineId: pipeline.id,
      environment: body.environment,
      label: body.label,
      pipelineVersionId:
        typeof body.pipelineVersionId === "string" ? body.pipelineVersionId : null,
      trackLatest,
      enabled: body.enabled !== false,
      createdAt: nowIso()
    };
    const created = await pipelineActivations.create(row);
    await audit(ctx, "pipeline_activation.create", "pipeline_activation", created.id, undefined, created);
    return ok(
      { activation: projectActivation(created, pipeline.latestVersionId ?? null) },
      201
    );
  });

  api.route(
    "PATCH",
    "/api/tenants/:id/pipelines/:pid/activations/:aid",
    async (ctx) => {
      enforce(ctx.principal, "config:edit_tenant", { tenantId: ctx.params.id });
      const pipeline = await resolvePipelineRef(deps.pipelines, ctx.params.pid);
      if (isAppResponse(pipeline)) return pipeline;
      const before = await pipelineActivations.get(ctx.params.aid);
      if (
        !before ||
        before.tenantId !== ctx.params.id ||
        before.pipelineId !== pipeline.id
      ) {
        return error(404, "not_found");
      }
      const body = ctx.request.body;
      if (!isObject(body)) return error(422, "validation_failed", { issues: [] });
      const patch: Partial<PipelineActivationRow> = {};
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (typeof body.trackLatest === "boolean") patch.trackLatest = body.trackLatest;
      if (typeof body.label === "string" && body.label.length > 0) {
        patch.label = body.label;
      }
      if ("pipelineVersionId" in body) {
        patch.pipelineVersionId =
          typeof body.pipelineVersionId === "string"
            ? body.pipelineVersionId
            : null;
      }
      const updated = await pipelineActivations.update(ctx.params.aid, patch);
      await audit(ctx, "pipeline_activation.update", "pipeline_activation", updated.id, before, updated);
      return ok({
        activation: projectActivation(updated, pipeline.latestVersionId ?? null)
      });
    }
  );

  api.route(
    "DELETE",
    "/api/tenants/:id/pipelines/:pid/activations/:aid",
    async (ctx) => {
      enforce(ctx.principal, "config:edit_tenant", { tenantId: ctx.params.id });
      const pipeline = await resolvePipelineRef(deps.pipelines, ctx.params.pid);
      if (isAppResponse(pipeline)) return pipeline;
      const before = await pipelineActivations.get(ctx.params.aid);
      if (
        !before ||
        before.tenantId !== ctx.params.id ||
        before.pipelineId !== pipeline.id
      ) {
        return error(404, "not_found");
      }
      await pipelineActivations.delete(ctx.params.aid);
      await audit(ctx, "pipeline_activation.delete", "pipeline_activation", ctx.params.aid, before, undefined);
      return { status: 204, body: undefined, headers: {} };
    }
  );
}
