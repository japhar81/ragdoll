/**
 * Dataset CRUD + dataset versions + dataset aliases.
 *
 * Datasets are the first-class corpus a pipeline reads from / writes
 * into; they decouple ingestion from retrieval (multiple pipelines can
 * share one dataset) and the platform owns the physical collection
 * naming. Scopes: global / tenant / environment — each row's scope
 * controls which authorize check (tenantId / environmentId pair) the
 * RBAC layer evaluates.
 */
import { randomUUID } from "node:crypto";
import { enforce } from "../../../../../packages/auth/src/index.ts";
import type {
  DatasetRow,
  DatasetVersionRow,
  DatasetAliasRow,
  DatasetRepository,
  DatasetVersionRepository,
  DatasetAliasRepository,
  EnvironmentRepository
} from "../../../../../packages/db/src/index.ts";
import { ok, error, isObject, nowIso, headerValue } from "../http-utils.ts";
import type { AppDeps } from "../types.ts";
import type { RouteContext, RouteRegistry, AuditWriter } from "./types.ts";
import { validateNamespacePolicyForScope } from "../../../../../packages/runtime/src/index.ts";

/**
 * Walk a `backends` JSONB object and validate any `namespace` policy
 * field against the dataset scope. Mirrors the matrix in
 * `validateNamespacePolicyForScope` — returns a list of 422 issues, or
 * an empty list when every modality's policy is legal (or absent).
 */
function validateBackendsNamespaceForScope(
  scope: DatasetRow["scope"],
  backends: Record<string, unknown>
): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  for (const [modality, raw] of Object.entries(backends)) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    if (!("namespace" in block)) continue;
    const result = validateNamespacePolicyForScope(scope, block.namespace);
    if (!result.ok) {
      issues.push({
        path: `backends.${modality}.namespace`,
        message: result.message ?? "invalid namespace policy"
      });
    }
  }
  return issues;
}

interface DatasetsServices {
  deps: AppDeps;
  audit: AuditWriter;
  datasets: DatasetRepository;
  datasetVersions: DatasetVersionRepository;
  datasetAliases: DatasetAliasRepository;
  environments: EnvironmentRepository;
  tenantScope: (ctx: RouteContext) => string | undefined;
}

function datasetScopeResource(row: {
  scope: DatasetRow["scope"];
  tenantId?: string | null;
  environmentId?: string | null;
}): { tenantId?: string; environment?: string } {
  if (row.scope === "tenant") return { tenantId: row.tenantId ?? undefined };
  if (row.scope === "environment") {
    return {
      tenantId: row.tenantId ?? undefined,
      environment: row.environmentId ?? undefined
    };
  }
  return {};
}

function publicDataset(row: DatasetRow): Record<string, unknown> {
  return {
    id: row.id,
    scope: row.scope,
    tenantId: row.tenantId ?? null,
    environmentId: row.environmentId ?? null,
    slug: row.slug,
    displayName: row.displayName,
    description: row.description ?? null,
    embeddingProfile: row.embeddingProfile,
    chunkSchema: row.chunkSchema,
    modalities: row.modalities,
    backends: row.backends,
    currentVersionId: row.currentVersionId ?? null,
    archivedAt: row.archivedAt ?? null,
    createdAt: row.createdAt,
    createdBy: row.createdBy ?? null,
    updatedAt: row.updatedAt
  };
}

function publicDatasetVersion(row: DatasetVersionRow): Record<string, unknown> {
  return {
    id: row.id,
    datasetId: row.datasetId,
    versionLabel: row.versionLabel,
    schemaSpec: row.schemaSpec,
    backendCollections: row.backendCollections,
    status: row.status,
    docCount: row.docCount,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
    readyAt: row.readyAt ?? null
  };
}

function publicDatasetAlias(row: DatasetAliasRow): Record<string, unknown> {
  return {
    id: row.id,
    datasetId: row.datasetId,
    alias: row.alias,
    versionId: row.versionId,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy ?? null
  };
}

export function registerDatasetsRoutes(
  api: RouteRegistry,
  svc: DatasetsServices
): void {
  const {
    deps,
    audit,
    datasets,
    datasetVersions,
    datasetAliases,
    environments,
    tenantScope
  } = svc;

  api.route("GET", "/api/datasets", async (ctx) => {
    enforce(ctx.principal, "dataset:read");
    const headerTenant = tenantScope(ctx);
    const headerEnv = headerValue(ctx.request.headers, "x-environment");
    const rows = await datasets.listVisibleAt({
      tenantId: headerTenant ?? undefined,
      environmentId: headerEnv ?? undefined
    });
    return ok({ datasets: rows.map(publicDataset) });
  });

  api.route("GET", "/api/datasets/:id", async (ctx) => {
    const row = await datasets.get(ctx.params.id);
    if (!row) return error(404, "not_found", { message: "dataset not found" });
    enforce(ctx.principal, "dataset:read", datasetScopeResource(row));
    return ok({ dataset: publicDataset(row) });
  });

  api.route("POST", "/api/datasets", async (ctx) => {
    const body = ctx.request.body;
    if (!isObject(body)) {
      return error(422, "validation_failed", { issues: [{ message: "body required" }] });
    }
    const scope = body.scope as DatasetRow["scope"];
    if (scope !== "global" && scope !== "tenant" && scope !== "environment") {
      return error(422, "validation_failed", {
        issues: [{ path: "scope", message: "scope must be global | tenant | environment" }]
      });
    }
    if (typeof body.slug !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(body.slug)) {
      return error(422, "validation_failed", {
        issues: [{ path: "slug", message: "slug must be lowercase alphanumeric + _- (1..63 chars)" }]
      });
    }
    if (typeof body.displayName !== "string" || !body.displayName.trim()) {
      return error(422, "validation_failed", {
        issues: [{ path: "displayName", message: "displayName required" }]
      });
    }
    const tenantId =
      typeof body.tenantId === "string" && body.tenantId ? body.tenantId : undefined;
    const environmentId =
      typeof body.environmentId === "string" && body.environmentId
        ? body.environmentId
        : undefined;
    if (scope === "global" && (tenantId || environmentId)) {
      return error(422, "validation_failed", {
        issues: [{ message: "global datasets cannot carry a tenantId or environmentId" }]
      });
    }
    if (scope === "tenant" && (!tenantId || environmentId)) {
      return error(422, "validation_failed", {
        issues: [{ message: "tenant datasets require tenantId and no environmentId" }]
      });
    }
    if (scope === "environment" && (!tenantId || !environmentId)) {
      return error(422, "validation_failed", {
        issues: [{ message: "environment datasets require both tenantId and environmentId" }]
      });
    }
    if (tenantId) {
      const t = await deps.tenants.get(tenantId);
      if (!t) {
        return error(422, "validation_failed", {
          issues: [{ path: "tenantId", message: "unknown tenant" }]
        });
      }
    }
    if (environmentId && tenantId) {
      const envs = await environments.listByTenant(tenantId);
      if (!envs.find((e) => e.name === environmentId)) {
        return error(422, "validation_failed", {
          issues: [{ path: "environmentId", message: `unknown environment: ${environmentId}` }]
        });
      }
    }
    enforce(ctx.principal, "dataset:admin", { tenantId, environment: environmentId });

    const backends = isObject(body.backends) ? body.backends : {};
    const nsIssues = validateBackendsNamespaceForScope(scope, backends);
    if (nsIssues.length > 0) {
      return error(422, "validation_failed", { issues: nsIssues });
    }

    const now = nowIso();
    const created = await datasets.create({
      id: randomUUID(),
      scope,
      tenantId,
      environmentId,
      slug: body.slug,
      displayName: body.displayName.trim(),
      description: typeof body.description === "string" ? body.description : null,
      embeddingProfile: isObject(body.embeddingProfile) ? body.embeddingProfile : {},
      chunkSchema: isObject(body.chunkSchema) ? body.chunkSchema : {},
      modalities:
        Array.isArray(body.modalities) && body.modalities.length > 0
          ? (body.modalities.filter((m) => typeof m === "string") as string[])
          : ["vector"],
      backends,
      currentVersionId: null,
      archivedAt: null,
      createdAt: now,
      createdBy: ctx.principal.id,
      updatedAt: now
    });
    await audit(ctx, "dataset.create", "dataset", created.id, undefined, publicDataset(created));
    return ok({ dataset: publicDataset(created) }, 201);
  });

  api.route("PATCH", "/api/datasets/:id", async (ctx) => {
    const before = await datasets.get(ctx.params.id);
    if (!before) return error(404, "not_found", { message: "dataset not found" });
    enforce(ctx.principal, "dataset:admin", datasetScopeResource(before));
    const body = ctx.request.body;
    if (!isObject(body)) {
      return error(422, "validation_failed", { issues: [{ message: "body required" }] });
    }
    const patch: Partial<DatasetRow> = {};
    if (typeof body.displayName === "string") patch.displayName = body.displayName.trim();
    if (typeof body.description === "string" || body.description === null) {
      patch.description = body.description as string | null;
    }
    if (isObject(body.chunkSchema)) patch.chunkSchema = body.chunkSchema;
    if (isObject(body.embeddingProfile)) patch.embeddingProfile = body.embeddingProfile;
    if (isObject(body.backends)) {
      const nsIssues = validateBackendsNamespaceForScope(before.scope, body.backends);
      if (nsIssues.length > 0) {
        return error(422, "validation_failed", { issues: nsIssues });
      }
      patch.backends = body.backends;
    }
    if (Array.isArray(body.modalities) && body.modalities.length > 0) {
      patch.modalities = body.modalities.filter((m) => typeof m === "string") as string[];
    }
    if (body.archived === true) patch.archivedAt = nowIso();
    if (body.archived === false) patch.archivedAt = null;
    patch.updatedAt = nowIso();
    const updated = await datasets.update(before.id, patch);
    await audit(ctx, "dataset.update", "dataset", updated.id, publicDataset(before), publicDataset(updated));
    return ok({ dataset: publicDataset(updated) });
  });

  api.route("DELETE", "/api/datasets/:id", async (ctx) => {
    const before = await datasets.get(ctx.params.id);
    if (!before) return error(404, "not_found", { message: "dataset not found" });
    enforce(ctx.principal, "dataset:admin", datasetScopeResource(before));
    await datasets.delete(before.id);
    await audit(ctx, "dataset.delete", "dataset", before.id, publicDataset(before), undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  api.route("GET", "/api/datasets/:id/versions", async (ctx) => {
    const ds = await datasets.get(ctx.params.id);
    if (!ds) return error(404, "not_found", { message: "dataset not found" });
    enforce(ctx.principal, "dataset:read", datasetScopeResource(ds));
    const versions = await datasetVersions.listByDataset(ds.id);
    const aliases = await datasetAliases.listByDataset(ds.id);
    return ok({
      versions: versions.map(publicDatasetVersion),
      aliases: aliases.map(publicDatasetAlias)
    });
  });

  api.route("POST", "/api/datasets/:id/versions", async (ctx) => {
    const ds = await datasets.get(ctx.params.id);
    if (!ds) return error(404, "not_found", { message: "dataset not found" });
    enforce(ctx.principal, "dataset:admin", datasetScopeResource(ds));
    const body = ctx.request.body;
    if (!isObject(body)) {
      return error(422, "validation_failed", { issues: [{ message: "body required" }] });
    }
    const existing = await datasetVersions.listByDataset(ds.id);
    const nextLabel =
      typeof body.versionLabel === "string" && body.versionLabel
        ? body.versionLabel
        : `v${existing.length + 1}`;
    const created = await datasetVersions.create({
      id: randomUUID(),
      datasetId: ds.id,
      versionLabel: nextLabel,
      schemaSpec: isObject(body.schemaSpec) ? body.schemaSpec : ds.chunkSchema,
      backendCollections: isObject(body.backendCollections)
        ? (body.backendCollections as Record<string, string>)
        : {},
      status: (body.status as DatasetVersionRow["status"]) ?? "building",
      docCount: 0,
      sizeBytes: 0,
      createdAt: nowIso(),
      readyAt: body.status === "ready" ? nowIso() : null
    });
    // If this is the dataset's first version and no `current_version_id`
    // is set yet, pin it and create the `stable` alias.
    if (!ds.currentVersionId) {
      await datasets.update(ds.id, { currentVersionId: created.id, updatedAt: nowIso() });
      await datasetAliases.upsert({
        id: randomUUID(),
        datasetId: ds.id,
        alias: "stable",
        versionId: created.id,
        updatedAt: nowIso(),
        updatedBy: ctx.principal.id
      });
    }
    await audit(ctx, "dataset_version.create", "dataset_version", created.id, undefined, publicDatasetVersion(created));
    return ok({ version: publicDatasetVersion(created) }, 201);
  });

  api.route("PATCH", "/api/datasets/:id/aliases/:alias", async (ctx) => {
    const ds = await datasets.get(ctx.params.id);
    if (!ds) return error(404, "not_found", { message: "dataset not found" });
    enforce(ctx.principal, "dataset:admin", datasetScopeResource(ds));
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.versionId !== "string") {
      return error(422, "validation_failed", {
        issues: [{ path: "versionId", message: "versionId required" }]
      });
    }
    const version = await datasetVersions.get(body.versionId);
    if (!version || version.datasetId !== ds.id) {
      return error(422, "validation_failed", {
        issues: [{ path: "versionId", message: "version does not belong to this dataset" }]
      });
    }
    const before = await datasetAliases.resolve(ds.id, ctx.params.alias);
    const row = await datasetAliases.upsert({
      id: before?.id ?? randomUUID(),
      datasetId: ds.id,
      alias: ctx.params.alias,
      versionId: version.id,
      updatedAt: nowIso(),
      updatedBy: ctx.principal.id
    });
    await audit(
      ctx,
      "dataset_alias.set",
      "dataset_alias",
      row.id,
      before ? publicDatasetAlias(before) : undefined,
      publicDatasetAlias(row)
    );
    return ok({ alias: publicDatasetAlias(row) });
  });
}
