/**
 * Per-(pipeline, tenant, env) dataset binding overrides — CRUD.
 *
 * Pipeline specs reference datasets by slug. The default resolution
 * walks the dataset scope cascade (env→tenant→global). When an
 * operator wants a specific pipeline-on-this-tenant-on-this-env to
 * resolve a slug to a different physical dataset row, they create a
 * binding here.
 *
 * RBAC: a binding override is an operator-grade decision (it changes
 * which dataset the runtime actually writes to). We gate on
 * `dataset:admin` for the targeted tenant — same control surface the
 * Datasets / Connections screens use.
 */
import { randomUUID } from "node:crypto";
import { enforce } from "../../../../../packages/auth/src/index.ts";
import type {
  PipelineDatasetBindingRow,
  PipelineDatasetBindingRepository,
  DatasetRepository,
  EnvironmentRepository,
  PipelineRepository,
  TenantRepository
} from "../../../../../packages/db/src/index.ts";
import { ok, error, isObject, nowIso } from "../http-utils.ts";
import type { AppDeps } from "../types.ts";
import type { RouteContext, RouteRegistry, AuditWriter } from "./types.ts";

interface PipelineBindingsServices {
  deps: AppDeps;
  audit: AuditWriter;
  bindings: PipelineDatasetBindingRepository;
  datasets: DatasetRepository;
  environments: EnvironmentRepository;
  pipelines: PipelineRepository;
  tenants: TenantRepository;
  tenantScope: (ctx: RouteContext) => string | undefined;
}

function publicBinding(row: PipelineDatasetBindingRow): Record<string, unknown> {
  return {
    id: row.id,
    pipelineId: row.pipelineId,
    tenantId: row.tenantId,
    environmentId: row.environmentId ?? null,
    sourceSlug: row.sourceSlug,
    targetDatasetId: row.targetDatasetId,
    createdAt: row.createdAt,
    createdBy: row.createdBy ?? null,
    updatedAt: row.updatedAt
  };
}

export function registerPipelineBindingsRoutes(
  api: RouteRegistry,
  svc: PipelineBindingsServices
): void {
  const { audit, bindings, datasets, environments, pipelines, tenants } = svc;

  // List bindings for one pipeline. Returns ALL tenants' bindings —
  // the UI's tenant filter narrows client-side.
  api.route("GET", "/api/pipelines/:id/dataset-bindings", async (ctx) => {
    enforce(ctx.principal, "dataset:read");
    const pipeline = await pipelines.get(ctx.params.id);
    if (!pipeline) return error(404, "not_found", { message: "pipeline not found" });
    const rows = await bindings.listByPipeline(pipeline.id);
    return ok({ bindings: rows.map(publicBinding) });
  });

  api.route("POST", "/api/pipelines/:id/dataset-bindings", async (ctx) => {
    const pipeline = await pipelines.get(ctx.params.id);
    if (!pipeline) return error(404, "not_found", { message: "pipeline not found" });
    const body = ctx.request.body;
    if (!isObject(body)) {
      return error(422, "validation_failed", { issues: [{ message: "body required" }] });
    }
    const tenantId =
      (typeof body.tenantId === "string" && body.tenantId) || svc.tenantScope(ctx);
    if (!tenantId) {
      return error(422, "validation_failed", {
        issues: [{ path: "tenantId", message: "tenantId required" }]
      });
    }
    if (typeof body.sourceSlug !== "string" || !body.sourceSlug) {
      return error(422, "validation_failed", {
        issues: [{ path: "sourceSlug", message: "sourceSlug required" }]
      });
    }
    if (typeof body.targetDatasetId !== "string" || !body.targetDatasetId) {
      return error(422, "validation_failed", {
        issues: [{ path: "targetDatasetId", message: "targetDatasetId required" }]
      });
    }
    const environmentId =
      typeof body.environmentId === "string" && body.environmentId
        ? body.environmentId
        : null;
    const tenant = await tenants.get(tenantId);
    if (!tenant) {
      return error(422, "validation_failed", {
        issues: [{ path: "tenantId", message: "unknown tenant" }]
      });
    }
    if (environmentId) {
      const envs = await environments.listByTenant(tenantId);
      if (!envs.find((e) => e.name === environmentId)) {
        return error(422, "validation_failed", {
          issues: [{ path: "environmentId", message: `unknown environment: ${environmentId}` }]
        });
      }
    }
    const target = await datasets.get(body.targetDatasetId);
    if (!target) {
      return error(422, "validation_failed", {
        issues: [{ path: "targetDatasetId", message: "unknown dataset" }]
      });
    }
    enforce(ctx.principal, "dataset:admin", { tenantId, environment: environmentId ?? undefined });

    const now = nowIso();
    const created = await bindings.create({
      id: randomUUID(),
      pipelineId: pipeline.id,
      tenantId,
      environmentId,
      sourceSlug: body.sourceSlug,
      targetDatasetId: target.id,
      createdAt: now,
      createdBy: ctx.principal.id ?? null,
      updatedAt: now
    });
    await audit(
      ctx,
      "pipeline_dataset_binding.create",
      "pipeline_dataset_binding",
      created.id,
      undefined,
      publicBinding(created)
    );
    return ok({ binding: publicBinding(created) }, 201);
  });

  api.route("PATCH", "/api/dataset-bindings/:id", async (ctx) => {
    const before = await bindings.get(ctx.params.id);
    if (!before) return error(404, "not_found", { message: "binding not found" });
    enforce(ctx.principal, "dataset:admin", {
      tenantId: before.tenantId,
      environment: before.environmentId ?? undefined
    });
    const body = ctx.request.body;
    if (!isObject(body)) {
      return error(422, "validation_failed", { issues: [{ message: "body required" }] });
    }
    const patch: Partial<PipelineDatasetBindingRow> = {};
    if (typeof body.targetDatasetId === "string" && body.targetDatasetId) {
      const target = await datasets.get(body.targetDatasetId);
      if (!target) {
        return error(422, "validation_failed", {
          issues: [{ path: "targetDatasetId", message: "unknown dataset" }]
        });
      }
      patch.targetDatasetId = target.id;
    }
    patch.updatedAt = nowIso();
    const updated = await bindings.update(before.id, patch);
    await audit(
      ctx,
      "pipeline_dataset_binding.update",
      "pipeline_dataset_binding",
      updated.id,
      publicBinding(before),
      publicBinding(updated)
    );
    return ok({ binding: publicBinding(updated) });
  });

  api.route("DELETE", "/api/dataset-bindings/:id", async (ctx) => {
    const before = await bindings.get(ctx.params.id);
    if (!before) return error(404, "not_found", { message: "binding not found" });
    enforce(ctx.principal, "dataset:admin", {
      tenantId: before.tenantId,
      environment: before.environmentId ?? undefined
    });
    await bindings.delete(before.id);
    await audit(
      ctx,
      "pipeline_dataset_binding.delete",
      "pipeline_dataset_binding",
      before.id,
      publicBinding(before),
      undefined
    );
    return { status: 204, body: undefined, headers: {} };
  });
}
