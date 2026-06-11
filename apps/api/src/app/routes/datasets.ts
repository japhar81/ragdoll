/**
 * Dataset CRUD + dataset versions + dataset aliases + binding cross-refs.
 *
 * Datasets are the first-class corpus a pipeline reads from / writes
 * into; they decouple ingestion from retrieval (multiple pipelines can
 * share one dataset) and the platform owns the physical collection
 * naming. Scopes: global / tenant / environment — each row's scope
 * controls which authorize check (tenantId / environmentId pair) the
 * RBAC layer evaluates.
 *
 * ADR-0023: the only storage-binding shape is `bindings: {<name>:
 * {connection, collection?, namespace?}}`. The legacy `backends.<modality>`
 * + `modalities[]` columns were dropped in migration 021.
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
  EnvironmentRepository,
  PipelineRepository,
  PipelineVersionRepository
} from "../../../../../packages/db/src/index.ts";
import { ok, error, isObject, nowIso, headerValue } from "../http-utils.ts";
import { parseForce, hasDependents } from "../cascade-utils.ts";
import type { AppDeps } from "../types.ts";
import type { RouteContext, RouteRegistry, AuditWriter } from "./types.ts";
import { validateNamespacePolicyForScope } from "../../../../../packages/runtime/src/index.ts";

/**
 * Walk a `bindings` object and validate each entry's shape + namespace
 * policy. Returns a list of 422 issues; empty list when every binding
 * is well-formed.
 *
 * Per-binding rules:
 *   - the value MUST be an object.
 *   - `connection`, `collection` (if set) MUST be strings.
 *   - `namespace` (if set) MUST be a legal DatasetNamespacePolicy that
 *     matches the dataset's scope (global datasets can't pin
 *     namespace="shared" + a tenant-specific suffix, etc — same matrix
 *     as the old per-backend validator).
 */
function validateBindings(
  scope: DatasetRow["scope"],
  bindings: Record<string, unknown>
): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  for (const [name, raw] of Object.entries(bindings)) {
    if (!raw || typeof raw !== "object") {
      issues.push({ path: `bindings.${name}`, message: "binding value must be an object" });
      continue;
    }
    const b = raw as Record<string, unknown>;
    if (b.connection !== undefined && typeof b.connection !== "string") {
      issues.push({ path: `bindings.${name}.connection`, message: "connection must be a string slug" });
    }
    if (b.collection !== undefined && typeof b.collection !== "string") {
      issues.push({ path: `bindings.${name}.collection`, message: "collection must be a string" });
    }
    if (b.namespace !== undefined) {
      const result = validateNamespacePolicyForScope(scope, b.namespace);
      if (!result.ok) {
        issues.push({
          path: `bindings.${name}.namespace`,
          message: result.message ?? "invalid namespace policy"
        });
      }
    }
  }
  return issues;
}

/** Normalise a body's bindings field — drops unknown keys per binding. */
function normaliseBindings(
  raw: Record<string, unknown>
): Record<string, { connection?: string; collection?: string; namespace?: string }> {
  const out: Record<string, { connection?: string; collection?: string; namespace?: string }> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    const b = value as Record<string, unknown>;
    const entry: { connection?: string; collection?: string; namespace?: string } = {};
    if (typeof b.connection === "string" && b.connection) entry.connection = b.connection;
    if (typeof b.collection === "string" && b.collection) entry.collection = b.collection;
    if (typeof b.namespace === "string" && b.namespace) entry.namespace = b.namespace;
    out[name] = entry;
  }
  return out;
}

interface DatasetsServices {
  deps: AppDeps;
  audit: AuditWriter;
  datasets: DatasetRepository;
  datasetVersions: DatasetVersionRepository;
  datasetAliases: DatasetAliasRepository;
  environments: EnvironmentRepository;
  pipelines: PipelineRepository;
  pipelineVersions: PipelineVersionRepository;
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
    bindings: row.bindings ?? {},
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
    pipelines,
    pipelineVersions,
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

  /**
   * Server-side "used by" cross-reference. Walks every pipeline's latest
   * version spec and returns the nodes that wire this dataset slug
   * (either via inline `node.dataset.slug` or via a `spec.bindings:`
   * entry whose dataset id matches this row).
   *
   * Shape:
   *   {
   *     pipelines: [{ id, slug, name, nodes: [{id, bindingName?}] }],
   *     bindingSlots: { vectors: { connectionKind: "qdrant", count: 3 }, ... }
   *   }
   *
   * Client-side aggregation across N pipelines was the cheaper path
   * before bindings; once each dataset carries N bindings AND N pipelines
   * carry node-level overrides, the round-trip count grew enough to
   * justify centralising the walk here.
   */
  api.route("GET", "/api/datasets/:id/used-by", async (ctx) => {
    const ds = await datasets.get(ctx.params.id);
    if (!ds) return error(404, "not_found", { message: "dataset not found" });
    enforce(ctx.principal, "dataset:read", datasetScopeResource(ds));
    const allPipelines = await pipelines.list();
    const out: Array<{
      id: string;
      slug: string;
      name: string;
      nodes: Array<{ id: string; bindingName?: string }>;
    }> = [];
    for (const p of allPipelines) {
      const vers = await pipelineVersions.listByPipeline(p.id);
      if (vers.length === 0) continue;
      const latest = vers[vers.length - 1];
      const spec = (latest.spec ?? {}) as {
        spec?: {
          nodes?: Array<{ id: string; dataset?: { slug?: string }; binding?: string }>;
          bindings?: Array<{ id: string; dataset?: string }>;
        };
      };
      const nodes = spec.spec?.nodes ?? [];
      const pipelineBindings = spec.spec?.bindings ?? [];
      const datasetBindingIds = new Set(
        pipelineBindings.filter((b) => b.dataset === ds.slug).map((b) => b.id)
      );
      const matches: Array<{ id: string; bindingName?: string }> = [];
      for (const n of nodes) {
        const matchInline = n.dataset?.slug === ds.slug;
        const matchBinding = n.binding && datasetBindingIds.has(n.binding);
        if (matchInline || matchBinding) {
          matches.push({ id: n.id, bindingName: n.binding });
        }
      }
      if (matches.length > 0) {
        out.push({
          id: p.id,
          slug: p.slug ?? p.id,
          name: p.name,
          nodes: matches
        });
      }
    }
    // Slot summary: for each binding declared on this dataset, surface
    // the connection kind and how many pipeline-nodes actually use it.
    // Cheap heuristic — counts a pipeline as touching every binding
    // since plugins read bindings by name. Future enhancement: cross-
    // reference plugin manifests' `requires` to attribute per-binding.
    const bindingSlots: Record<string, { connectionSlug?: string; count: number }> = {};
    for (const [name, b] of Object.entries(ds.bindings ?? {})) {
      bindingSlots[name] = {
        connectionSlug: b?.connection,
        count: out.length
      };
    }
    return ok({ pipelines: out, bindingSlots });
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

    const rawBindings = isObject(body.bindings) ? body.bindings : {};
    const issues = validateBindings(scope, rawBindings);
    if (issues.length > 0) {
      return error(422, "validation_failed", { issues });
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
      bindings: normaliseBindings(rawBindings),
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
    if (isObject(body.bindings)) {
      const issues = validateBindings(before.scope, body.bindings);
      if (issues.length > 0) {
        return error(422, "validation_failed", { issues });
      }
      patch.bindings = normaliseBindings(body.bindings);
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
    const force = parseForce(ctx.request);
    // Count what would be cascaded / orphaned. Versions + aliases
    // cascade via FK (migration 010 ON DELETE CASCADE). Pipeline
    // dataset_bindings cascade too (migration 016). What does NOT
    // cascade: pipeline specs that embed `node.dataset.slug` inline
    // OR pipeline-level `bindings:` referencing this slug — those
    // are JSON blobs in pipeline_versions.spec and become dangling
    // references after delete (the runtime will fail to resolve the
    // slug at execute time). The default-deny posture surfaces this
    // count so the operator chooses explicitly. Reuses the same
    // walk the GET /:id/used-by endpoint exposes.
    const [versionRows, aliasRows, allPipelines] = await Promise.all([
      datasetVersions.listByDataset(before.id),
      datasetAliases.listByDataset(before.id),
      pipelines.list()
    ]);
    // Binding-override rows reference the dataset by ID and CASCADE
    // via FK (migration 016), so a hard delete cleans them up; we
    // don't surface them in the dep counts. What DOES need surfacing:
    // pipeline specs that embed `node.dataset.slug` (inline) OR
    // pipeline-level `bindings:` pointing at this slug — those are
    // immutable JSON in pipeline_versions.spec and become dangling
    // references after delete (the runtime will fail to resolve at
    // execute time). This is the same walk GET /:id/used-by does.
    let pipelineRefCount = 0;
    for (const p of allPipelines) {
      const vers = await pipelineVersions.listByPipeline(p.id);
      if (vers.length === 0) continue;
      const latest = vers[vers.length - 1];
      const spec = (latest.spec ?? {}) as {
        spec?: {
          nodes?: Array<{ dataset?: { slug?: string }; binding?: string }>;
          bindings?: Array<{ id: string; dataset?: string }>;
        };
      };
      const pipelineBindings = spec.spec?.bindings ?? [];
      const datasetBindingIds = new Set(
        pipelineBindings.filter((b) => b.dataset === before.slug).map((b) => b.id)
      );
      const nodes = spec.spec?.nodes ?? [];
      const refs = nodes.some(
        (n) => n.dataset?.slug === before.slug || (n.binding && datasetBindingIds.has(n.binding))
      );
      if (refs) pipelineRefCount += 1;
    }
    const depCounts = {
      versions: versionRows.length,
      aliases: aliasRows.length,
      pipelineReferences: pipelineRefCount
    };
    const anyDeps = Object.values(depCounts).some((n) => n > 0);
    if (!force && anyDeps) {
      return hasDependents(`dataset "${before.slug}"`, depCounts);
    }
    await datasets.delete(before.id);
    await audit(
      ctx,
      "dataset.delete",
      "dataset",
      before.id,
      { ...publicDataset(before), cascaded: depCounts },
      undefined
    );
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
