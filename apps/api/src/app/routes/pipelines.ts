/**
 * Pipeline CRUD + spec validation + version lineage + deployments.
 *
 * The same `resolvePipelineRef` (accepts a UUID OR a slug) feeds every
 * `:id` route, so a `POST /api/pipelines/<slug>/run` from the Builder
 * never tries to coerce a slug into a Postgres uuid column.
 */
import { randomUUID } from "node:crypto";
import { enforce } from "../../../../../packages/auth/src/index.ts";
import {
  validatePipelineSpec,
  autoLayoutSpec,
  exportSpec,
  specChecksum,
  publishVersion,
  archiveVersion,
  nextVersionOnSave,
  rollbackPointer,
  ImmutableVersionError,
  VersionNotFoundError,
  type PipelineVersionRecord
} from "../../../../../packages/pipeline-spec/src/index.ts";
import type {
  PipelineSpec
} from "../../../../../packages/core/src/index.ts";
import type {
  PipelineRow,
  PipelineVersionRow,
  PipelineDeploymentRow,
  PipelineFolderRepository
} from "../../../../../packages/db/src/index.ts";
import { ok, error, isObject, nowIso } from "../http-utils.ts";
import { parseForce, hasDependents } from "../cascade-utils.ts";
import { parseSpec } from "../spec-helpers.ts";
import {
  resolvePipelineRef,
  isAppResponse,
  trackFolder
} from "../pipeline-resolution.ts";
import type { AppDeps } from "../types.ts";
import type { RouteRegistry, AuditWriter, RouteContext } from "./types.ts";
import type {
  DatasetRow,
  ConnectionRow
} from "../../../../../packages/db/src/index.ts";
import type { DatasetBindingIndex } from "../../../../../packages/pipeline-spec/src/index.ts";

interface PipelinesServices {
  deps: AppDeps;
  audit: AuditWriter;
  pipelineFolders: PipelineFolderRepository;
  /** Same helper every other route uses to extract the caller's
   *  tenant from `x-tenant-id`. Passed in so the validate routes can
   *  build a binding index against the datasets / connections visible
   *  to the caller (the index drives the kind-mismatch check). */
  tenantScope: (ctx: RouteContext) => string | undefined;
}

/**
 * Build the {@link DatasetBindingIndex} the spec validator wants:
 * slug → bindings → (correctly resolved) connection kind.
 *
 * The kind comes from the unified Connections registry — looking up
 * each binding's connection SLUG against the loaded connection rows.
 * The Builder used to put the slug into `connectionKind` (heuristic
 * that worked for bundled kinds like "qdrant" but fired false-positive
 * mismatches for human-named slugs like "bulwark-wg"). Doing this on
 * the server is straightforward — we have the DB.
 *
 * `tenantId` / `environmentId` scope the visibility — same cascade the
 * runtime walks at execute time.
 */
async function buildBindingIndex(
  deps: AppDeps,
  scope: { tenantId?: string; environmentId?: string }
): Promise<DatasetBindingIndex | undefined> {
  if (!deps.datasets || !deps.connections) return undefined;
  const datasets: DatasetRow[] = scope.tenantId
    ? await deps.datasets.listVisibleAt(scope)
    : await deps.datasets.listAll({ scope: "global" });
  const connections: ConnectionRow[] = scope.tenantId
    ? await deps.connections.listVisibleAt({
        tenantId: scope.tenantId,
        environmentId: scope.environmentId
      })
    : await deps.connections.listAll({ scope: "global" });
  // slug → kind lookup once. Cascade collisions (global vs tenant)
  // are tolerated — we keep the first hit and the runtime cascade
  // walks the same order at execute time.
  const kindBySlug = new Map<string, string>();
  for (const c of connections) {
    if (!kindBySlug.has(c.slug)) kindBySlug.set(c.slug, c.kind);
  }
  const bySlug = new Map<string, Record<string, { connectionKind?: string }>>();
  for (const d of datasets) {
    const declared = (d.bindings ?? {}) as Record<
      string,
      { connection?: string } | undefined
    >;
    const merged = bySlug.get(d.slug) ?? {};
    for (const [name, b] of Object.entries(declared)) {
      if (!b) continue;
      if (!merged[name]) merged[name] = {};
      if (!merged[name].connectionKind && typeof b.connection === "string") {
        merged[name].connectionKind = kindBySlug.get(b.connection);
      }
    }
    bySlug.set(d.slug, merged);
  }
  return (slug: string) => {
    const bindings = bySlug.get(slug);
    return bindings ? { bindings } : undefined;
  };
}

export function registerPipelinesRoutes(
  api: RouteRegistry,
  svc: PipelinesServices
): void {
  const { deps, audit, pipelineFolders, tenantScope } = svc;

  // ---- pipelines ----------------------------------------------------------
  api.route("GET", "/api/pipelines", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    return ok({ pipelines: await deps.pipelines.list() });
  });

  api.route("GET", "/api/pipelines/:id", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const resolved = await resolvePipelineRef(deps.pipelines, ctx.params.id);
    if (isAppResponse(resolved)) return resolved;
    return ok({ pipeline: resolved });
  });

  api.route("POST", "/api/pipelines", async (ctx) => {
    enforce(ctx.principal, "pipeline:create");
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.slug !== "string" || typeof body.name !== "string") {
      return error(422, "validation_failed", {
        issues: [{ path: "slug|name", message: "slug and name are required strings" }]
      });
    }
    const existing = await deps.pipelines.findBySlug(body.slug);
    if (existing) return error(409, "conflict", { message: "slug already exists" });
    const folderId =
      typeof body.folderId === "string" ? body.folderId : null;
    if (folderId !== null && !(await pipelineFolders.get(folderId))) {
      return error(404, "not_found", { message: "folder not found" });
    }
    const row: PipelineRow = {
      id: typeof body.id === "string" ? body.id : randomUUID(),
      slug: body.slug,
      name: body.name,
      description: typeof body.description === "string" ? body.description : null,
      labels: isObject(body.labels) ? (body.labels as Record<string, string>) : {},
      folderId,
      latestVersionId: null,
      createdBy: ctx.principal.id,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    const created = await deps.pipelines.create(row);
    if (folderId !== null) trackFolder(pipelineFolders, created.id, folderId);
    await audit(ctx, "pipeline.create", "pipeline", created.id, undefined, created);
    return ok({ pipeline: created }, 201);
  });

  api.route("PUT", "/api/pipelines/:id", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const before = await resolvePipelineRef(deps.pipelines, ctx.params.id);
    if (isAppResponse(before)) return before;
    const body = ctx.request.body;
    if (!isObject(body)) return error(422, "validation_failed", { issues: [] });
    const patch: Partial<PipelineRow> = { updatedAt: nowIso() };
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.description === "string") patch.description = body.description;
    if (isObject(body.labels)) patch.labels = body.labels as Record<string, string>;
    const updated = await deps.pipelines.update(before.id, patch);
    await audit(ctx, "pipeline.update", "pipeline", updated.id, before, updated);
    return ok({ pipeline: updated });
  });

  api.route("DELETE", "/api/pipelines/:id", async (ctx) => {
    enforce(ctx.principal, "pipeline:delete");
    const before = await resolvePipelineRef(deps.pipelines, ctx.params.id);
    if (isAppResponse(before)) return before;
    const force = parseForce(ctx.request);
    // Count what the cascade will take with it. The DB FKs already
    // ON DELETE CASCADE versions / deployments / activations /
    // schedules / webhook_triggers / dataset_bindings (per migrations
    // 001 + 003 + 006 + 013 + 016), so a forced delete is a single
    // DELETE that fans out. Default posture: refuse + enumerate so
    // the operator sees what they're about to nuke.
    const [versions, deployments, activations, allSchedules, bindings] = await Promise.all([
      deps.pipelineVersions.listByPipeline(before.id),
      deps.deployments.listByPipeline(before.id),
      deps.pipelineActivations?.listByPipeline(before.id) ?? [],
      deps.schedules?.list() ?? [],
      deps.pipelineDatasetBindings?.listByPipeline(before.id) ?? []
    ]);
    const scheduleCount = allSchedules.filter((s) => s.pipelineId === before.id).length;
    const depCounts = {
      versions: versions.length,
      deployments: deployments.length,
      activations: activations.length,
      schedules: scheduleCount,
      bindings: bindings.length
    };
    const anyDeps = Object.values(depCounts).some((n) => n > 0);
    if (!force && anyDeps) {
      return hasDependents(`pipeline "${before.slug ?? before.id}"`, depCounts);
    }
    await deps.pipelines.delete(before.id);
    await audit(ctx, "pipeline.delete", "pipeline", before.id, { ...before, cascaded: depCounts }, undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  api.route("PUT", "/api/pipelines/:id/folder", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const pipeline = await resolvePipelineRef(deps.pipelines, ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const body = ctx.request.body;
    if (!isObject(body) || !("folderId" in body)) {
      return error(422, "validation_failed", {
        issues: [{ path: "folderId", message: "folderId is required (string or null)" }]
      });
    }
    const folderId = typeof body.folderId === "string" ? body.folderId : null;
    if (folderId !== null && !(await pipelineFolders.get(folderId))) {
      return error(404, "not_found", { message: "folder not found" });
    }
    const updated = await deps.pipelines.setFolder(pipeline.id, folderId);
    trackFolder(pipelineFolders, pipeline.id, folderId);
    await audit(ctx, "pipeline.set_folder", "pipeline", updated.id, pipeline, updated);
    return ok({ pipeline: updated });
  });

  // ---- pipeline spec validation ------------------------------------------
  api.route("POST", "/api/pipelines/validate", async (ctx) => {
    enforce(ctx.principal, "pipeline:create");
    const spec = parseSpec(ctx.request.body);
    if (!spec) return error(422, "validation_failed", { issues: [{ message: "invalid spec" }] });
    // Build the dataset/connection binding index from the caller's
    // tenant view so the validator catches dataset_binding_kind_mismatch
    // (was previously skipped server-side because no index was passed —
    // a bulwark pipeline binding a neo4j-needing node to a non-neo4j
    // connection validated clean, then failed at execute).
    const tenantId = tenantScope(ctx);
    const envHeader = ctx.request.headers["x-ragdoll-env"];
    const environmentId = typeof envHeader === "string" ? envHeader : undefined;
    const datasetIndex = await buildBindingIndex(deps, { tenantId, environmentId });
    return ok(validatePipelineSpec(spec, deps.pluginRegistry, datasetIndex));
  });

  // ---- per-pipeline validation (server-fetched spec) --------------------
  // Same envelope POST /api/pipelines/validate returns, but for an
  // already-provisioned pipeline — no need to resend the spec. Picks the
  // latest version by default; ?version=X.Y.Z pins to a specific one.
  // Surfaces the SAME validation issues the Builder lights badges from
  // (errors, warnings, missingPlugins, requiredSecrets/Config, datasetSlots)
  // so a provisioning script can detect problems without round-tripping
  // through the builder UI.
  api.route("GET", "/api/pipelines/:id/validation", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const pipeline = await resolvePipelineRef(deps.pipelines, ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const versionParam = ctx.request.query.version;
    let row: PipelineVersionRow | undefined;
    if (typeof versionParam === "string" && versionParam.length > 0) {
      row = await deps.pipelineVersions.findByVersion(pipeline.id, versionParam);
      if (!row) {
        return error(404, "not_found", {
          message: `version "${versionParam}" not found on pipeline ${pipeline.slug}`
        });
      }
    } else {
      // Latest version. Prefer the pipeline's pinned `latestVersionId` when
      // set; fall back to the most-recently-created row so a brand-new
      // pipeline that hasn't had its pointer backfilled yet still validates.
      const rows = await deps.pipelineVersions.listByPipeline(pipeline.id);
      if (rows.length === 0) {
        return error(404, "not_found", {
          message: `pipeline ${pipeline.slug} has no saved versions to validate`
        });
      }
      row =
        (pipeline.latestVersionId
          ? rows.find((r) => r.id === pipeline.latestVersionId)
          : undefined) ?? rows[rows.length - 1];
    }
    // Use the caller's tenant scope (already enforced above) to build
    // the same binding index POST /validate uses, so a provisioning
    // script polling this endpoint sees the dataset_binding_kind_mismatch
    // error as soon as it appears — not at run time.
    const tenantId = tenantScope(ctx);
    const envHeader = ctx.request.headers["x-ragdoll-env"];
    const environmentId = typeof envHeader === "string" ? envHeader : undefined;
    const datasetIndex = await buildBindingIndex(deps, { tenantId, environmentId });
    const validation = validatePipelineSpec(
      row.spec as PipelineSpec,
      deps.pluginRegistry,
      datasetIndex
    );
    return ok({
      pipelineId: pipeline.id,
      pipelineSlug: pipeline.slug,
      version: row.version,
      versionId: row.id,
      ...validation
    });
  });

  // ---- pipeline versions --------------------------------------------------
  api.route("GET", "/api/pipelines/:id/versions", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const pipeline = await resolvePipelineRef(deps.pipelines, ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const rows = await deps.pipelineVersions.listByPipeline(pipeline.id);
    const latestId = pipeline.latestVersionId ?? null;
    const versions = rows.map((row) => ({
      ...row,
      parentVersionId: row.parentVersionId ?? null,
      isLatest: row.id === latestId
    }));
    return ok({ versions, latestVersionId: latestId });
  });

  api.route("POST", "/api/pipelines/:id/versions", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const pipeline = await resolvePipelineRef(deps.pipelines, ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const pipelineId = pipeline.id;
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.version !== "string") {
      return error(422, "validation_failed", {
        issues: [{ path: "version", message: "version is required" }]
      });
    }
    const spec = parseSpec(body.spec);
    if (!spec) {
      return error(422, "validation_failed", {
        issues: [{ path: "spec", message: "spec is missing or invalid" }]
      });
    }
    const validation = validatePipelineSpec(spec, deps.pluginRegistry);
    if (!validation.valid) {
      return error(422, "validation_failed", { issues: validation.errors });
    }
    const laidOut = autoLayoutSpec(spec);
    const publish = body.publish === true;
    const existingRows = await deps.pipelineVersions.listByPipeline(pipelineId);
    const existingRecords: PipelineVersionRecord[] = existingRows.map((row) => ({
      pipelineId: row.pipelineId,
      version: row.version,
      status: row.status,
      spec: row.spec as PipelineSpec,
      checksum: row.checksum,
      createdAt: row.createdAt,
      publishedAt: row.publishedAt ?? undefined
    }));

    if (publish) {
      let record: PipelineVersionRecord;
      try {
        record = publishVersion(existingRecords, laidOut, body.version, {
          pipelineId
        });
      } catch (e) {
        if (e instanceof ImmutableVersionError) {
          return error(409, "immutable_version", { message: e.message });
        }
        throw e;
      }
      const priorRow = existingRows.find(
        (row) => row.version === body.version && row.status === "published"
      );
      if (priorRow) {
        return ok({ version: priorRow }, 200);
      }
      const versionRow: PipelineVersionRow = {
        id: randomUUID(),
        pipelineId,
        version: record.version,
        status: "published",
        spec: record.spec,
        checksum: record.checksum,
        createdBy: ctx.principal.id,
        createdAt: record.createdAt,
        publishedAt: record.publishedAt ?? nowIso()
      };
      const created = await deps.pipelineVersions.create(versionRow);
      await audit(ctx, "pipeline_version.publish", "pipeline_version", created.id, undefined, {
        version: created.version,
        checksum: created.checksum
      });
      return ok({ version: created }, 201);
    }

    const existingDraft = existingRows.find(
      (row) => row.version === body.version && row.status === "draft"
    );
    if (existingDraft) {
      const updated = await deps.pipelineVersions.update(existingDraft.id, {
        spec: laidOut,
        checksum: specChecksum(laidOut)
      });
      await audit(ctx, "pipeline_version.save_draft", "pipeline_version", updated.id, existingDraft, {
        version: updated.version
      });
      return ok({ version: updated }, 200);
    }
    const blockingPublished = existingRows.find(
      (row) => row.version === body.version && row.status === "published"
    );
    if (blockingPublished) {
      return error(409, "immutable_version", {
        message: `version ${body.version} is already published`
      });
    }
    const draftRow: PipelineVersionRow = {
      id: randomUUID(),
      pipelineId,
      version: body.version,
      status: "draft",
      spec: laidOut,
      checksum: specChecksum(laidOut),
      createdBy: ctx.principal.id,
      createdAt: nowIso(),
      publishedAt: null
    };
    const created = await deps.pipelineVersions.create(draftRow);
    await audit(ctx, "pipeline_version.save_draft", "pipeline_version", created.id, undefined, {
      version: created.version
    });
    return ok({ version: created }, 201);
  });

  api.route("POST", "/api/pipelines/:id/save", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const pipeline = await resolvePipelineRef(deps.pipelines, ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const pipelineId = pipeline.id;
    const body = ctx.request.body;
    if (!isObject(body)) {
      return error(422, "validation_failed", { issues: [{ message: "body required" }] });
    }
    const spec = parseSpec(body.spec);
    if (!spec) {
      return error(422, "validation_failed", {
        issues: [{ path: "spec", message: "spec is missing or invalid" }]
      });
    }
    const validation = validatePipelineSpec(spec, deps.pluginRegistry);
    if (!validation.valid) {
      return error(422, "validation_failed", { issues: validation.errors });
    }
    const laidOutSave = autoLayoutSpec(spec);
    const level =
      body.level === "minor" || body.level === "major" || body.level === "patch"
        ? (body.level as "patch" | "minor" | "major")
        : "patch";

    const rows = await deps.pipelineVersions.listByPipeline(pipelineId);
    const toRecord = (row: PipelineVersionRow): PipelineVersionRecord => ({
      id: row.id,
      pipelineId: row.pipelineId,
      version: row.version,
      status: row.status,
      spec: row.spec as PipelineSpec,
      checksum: row.checksum,
      parentVersionId: row.parentVersionId ?? null,
      createdAt: row.createdAt,
      publishedAt: row.publishedAt ?? undefined
    });
    const existingVersions = rows.map(toRecord);
    const latestRow = pipeline.latestVersionId
      ? rows.find((row) => row.id === pipeline.latestVersionId)
      : undefined;

    const result = nextVersionOnSave({
      existingVersions,
      latest: latestRow ? toRecord(latestRow) : undefined,
      spec: laidOutSave,
      level,
      pipelineId
    });

    if (result.kind === "idempotent") {
      const unchanged = rows.find((row) => row.id === result.version.id);
      return ok({ version: unchanged, created: false });
    }

    const versionRow: PipelineVersionRow = {
      id: randomUUID(),
      pipelineId,
      version: result.record.version,
      status: "published",
      spec: result.record.spec,
      checksum: result.record.checksum,
      parentVersionId: result.record.parentVersionId ?? null,
      createdBy: ctx.principal.id,
      createdAt: result.record.createdAt,
      publishedAt: result.record.publishedAt ?? nowIso()
    };
    const created = await deps.pipelineVersions.create(versionRow);
    const updatedPipeline = await deps.pipelines.setLatestVersion(
      pipelineId,
      created.id
    );
    await audit(ctx, "pipeline_version.save", "pipeline_version", created.id, undefined, {
      version: created.version,
      checksum: created.checksum,
      parentVersionId: created.parentVersionId,
      latestVersionId: updatedPipeline.latestVersionId
    });
    return ok({ version: created, created: true }, 201);
  });

  api.route("POST", "/api/pipelines/:id/rollback", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const pipeline = await resolvePipelineRef(deps.pipelines, ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const pipelineId = pipeline.id;
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.versionId !== "string") {
      return error(422, "validation_failed", {
        issues: [{ path: "versionId", message: "versionId is required" }]
      });
    }
    const rows = await deps.pipelineVersions.listByPipeline(pipelineId);
    let targetId: string;
    try {
      targetId = rollbackPointer(
        rows.map((row) => ({
          id: row.id,
          pipelineId: row.pipelineId,
          version: row.version,
          status: row.status,
          spec: row.spec as PipelineSpec,
          checksum: row.checksum,
          createdAt: row.createdAt
        })),
        body.versionId
      );
    } catch (e) {
      if (e instanceof VersionNotFoundError) {
        return error(404, "not_found", { message: e.message });
      }
      throw e;
    }
    const updated = await deps.pipelines.setLatestVersion(pipelineId, targetId);
    await audit(ctx, "pipeline_version.rollback", "pipeline", pipelineId, pipeline, {
      latestVersionId: updated.latestVersionId
    });
    return ok({ pipeline: updated, latestVersionId: updated.latestVersionId });
  });

  api.route("POST", "/api/pipelines/:id/versions/:version/archive", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const pipeline = await resolvePipelineRef(deps.pipelines, ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const found = await deps.pipelineVersions.findByVersion(pipeline.id, ctx.params.version);
    if (!found) return error(404, "not_found");
    const archived = archiveVersion({
      pipelineId: found.pipelineId,
      version: found.version,
      status: found.status,
      spec: found.spec as PipelineSpec,
      checksum: found.checksum,
      createdAt: found.createdAt,
      publishedAt: found.publishedAt ?? undefined
    });
    const updated = await deps.pipelineVersions.update(found.id, { status: archived.status });
    await audit(ctx, "pipeline_version.archive", "pipeline_version", updated.id, found, updated);
    return ok({ version: updated });
  });

  api.route("GET", "/api/pipelines/:id/versions/:version/export", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const pipeline = await resolvePipelineRef(deps.pipelines, ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const found = await deps.pipelineVersions.findByVersion(pipeline.id, ctx.params.version);
    if (!found) return error(404, "not_found");
    const format = ctx.request.query.format === "yaml" ? "yaml" : "json";
    const text = exportSpec(found.spec as PipelineSpec, format);
    return {
      status: 200,
      body: text,
      headers: { "content-type": format === "yaml" ? "application/yaml" : "application/json" }
    };
  });

  // ---- deployments --------------------------------------------------------
  api.route("GET", "/api/pipelines/:id/deployments", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const pipeline = await resolvePipelineRef(deps.pipelines, ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    return ok({ deployments: await deps.deployments.listByPipeline(pipeline.id) });
  });

  api.route("POST", "/api/pipelines/:id/deployments", async (ctx) => {
    enforce(ctx.principal, "pipeline:deploy");
    const pipeline = await resolvePipelineRef(deps.pipelines, ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const pipelineId = pipeline.id;
    const body = ctx.request.body;
    if (
      !isObject(body) ||
      typeof body.version !== "string" ||
      typeof body.environment !== "string"
    ) {
      return error(422, "validation_failed", {
        issues: [{ message: "version and environment are required" }]
      });
    }
    const version = await deps.pipelineVersions.findByVersion(pipelineId, body.version);
    if (!version) return error(404, "not_found", { message: "pipeline version not found" });
    if (version.status !== "published") {
      return error(422, "validation_failed", {
        issues: [{ message: "only published versions can be deployed" }]
      });
    }
    const deploymentRow: PipelineDeploymentRow = {
      id: randomUUID(),
      pipelineId,
      pipelineVersionId: version.id,
      environment: body.environment,
      tenantId: typeof body.tenantId === "string" ? body.tenantId : null,
      status: "active",
      deployedBy: ctx.principal.id,
      deployedAt: nowIso()
    };
    const saved = await deps.deployments.upsertActive(deploymentRow);
    await audit(ctx, "pipeline.deploy", "pipeline_deployment", saved.id, undefined, saved);
    return ok({ deployment: saved }, 201);
  });
}
