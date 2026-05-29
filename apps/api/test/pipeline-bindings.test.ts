/**
 * Integration tests for per-(pipeline, tenant, env) dataset binding
 * overrides (PR3).
 *
 * Two layers under test:
 *   - HTTP CRUD: create / list / patch / delete binding rows.
 *   - DatasetResolver wiring: the resolver consults bindings first
 *     and bypasses the default slug cascade when one matches the
 *     calling (pipeline, tenant, env).
 *
 * The binding cascade itself is unit-tested in
 * packages/db/test/connections.test.ts-adjacent territory; here we
 * exercise the seam where bindings meet the API + resolver.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildHarness } from "./helpers.ts";
import { buildApiDatasetResolver } from "../src/app/pipeline-execution.ts";

async function seed(h: ReturnType<typeof buildHarness>) {
  const now = new Date().toISOString();
  const tenantId = randomUUID();
  await h.deps.tenants.create({
    id: tenantId,
    slug: "acme",
    name: "Acme",
    status: "active",
    metadata: {},
    storageMode: "db",
    createdAt: now,
    updatedAt: now
  });
  for (const name of ["dev", "prod"]) {
    await h.deps.environments!.create({
      id: randomUUID(),
      tenantId,
      name,
      description: null,
      isProduction: name === "prod",
      createdAt: now
    });
  }
  const pipelineId = randomUUID();
  await h.deps.pipelines.create({
    id: pipelineId,
    slug: "support-rag",
    name: "Support RAG",
    description: null,
    folderId: null,
    latestVersionId: null,
    labels: {},
    createdAt: now,
    updatedAt: now
  });
  // Two datasets under the same slug-space: a default (global scope)
  // and an override (the one a binding will pin for tenant + prod).
  // Each needs at least one dataset_version + alias so the resolver
  // can build a ResolvedDataset (it bails on a versionless dataset).
  async function makeDataset(args: {
    scope: "global" | "tenant";
    slug: string;
    displayName: string;
  }) {
    const id = randomUUID();
    const versionId = randomUUID();
    await h.deps.datasetVersions!.create({
      id: versionId,
      datasetId: id,
      versionLabel: "v1",
      schemaSpec: {},
      backendCollections: { vector: `${args.slug}_v1` },
      status: "ready",
      docCount: 0,
      sizeBytes: 0,
      createdAt: now,
      readyAt: now
    });
    await h.deps.datasets!.create({
      id,
      scope: args.scope,
      tenantId: args.scope === "tenant" ? tenantId : null,
      environmentId: null,
      slug: args.slug,
      displayName: args.displayName,
      description: null,
      embeddingProfile: {},
      chunkSchema: {},
      modalities: ["vector"],
      backends: { vector: { provider: "qdrant" } },
      currentVersionId: versionId,
      archivedAt: null,
      createdAt: now,
      createdBy: null,
      updatedAt: now
    });
    return id;
  }
  const defaultDsId = await makeDataset({
    scope: "global",
    slug: "docs",
    displayName: "Docs (default)"
  });
  const overrideDsId = await makeDataset({
    scope: "tenant",
    slug: "docs-tenant-prod",
    displayName: "Docs (tenant-prod override)"
  });
  return { tenantId, pipelineId, defaultDsId, overrideDsId };
}

test("POST /api/pipelines/:id/dataset-bindings creates a binding", async () => {
  const h = buildHarness();
  const ids = await seed(h);
  const res = await h.request({
    method: "POST",
    path: `/api/pipelines/${ids.pipelineId}/dataset-bindings`,
    headers: { "x-tenant-id": ids.tenantId },
    body: {
      tenantId: ids.tenantId,
      environmentId: "prod",
      sourceSlug: "docs",
      targetDatasetId: ids.overrideDsId
    }
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.binding.sourceSlug, "docs");
  assert.equal(res.body.binding.targetDatasetId, ids.overrideDsId);
  assert.equal(res.body.binding.environmentId, "prod");
});

test("POST rejects unknown environment", async () => {
  const h = buildHarness();
  const ids = await seed(h);
  const res = await h.request({
    method: "POST",
    path: `/api/pipelines/${ids.pipelineId}/dataset-bindings`,
    headers: { "x-tenant-id": ids.tenantId },
    body: {
      tenantId: ids.tenantId,
      environmentId: "moon",
      sourceSlug: "docs",
      targetDatasetId: ids.overrideDsId
    }
  });
  assert.equal(res.status, 422);
});

test("POST rejects unknown target dataset", async () => {
  const h = buildHarness();
  const ids = await seed(h);
  const res = await h.request({
    method: "POST",
    path: `/api/pipelines/${ids.pipelineId}/dataset-bindings`,
    headers: { "x-tenant-id": ids.tenantId },
    body: {
      tenantId: ids.tenantId,
      sourceSlug: "docs",
      targetDatasetId: randomUUID()
    }
  });
  assert.equal(res.status, 422);
});

test("GET lists bindings for the pipeline", async () => {
  const h = buildHarness();
  const ids = await seed(h);
  await h.request({
    method: "POST",
    path: `/api/pipelines/${ids.pipelineId}/dataset-bindings`,
    headers: { "x-tenant-id": ids.tenantId },
    body: {
      tenantId: ids.tenantId,
      environmentId: "prod",
      sourceSlug: "docs",
      targetDatasetId: ids.overrideDsId
    }
  });
  const res = await h.request({
    method: "GET",
    path: `/api/pipelines/${ids.pipelineId}/dataset-bindings`,
    headers: { "x-tenant-id": ids.tenantId }
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.bindings.length, 1);
  assert.equal(res.body.bindings[0].environmentId, "prod");
});

test("PATCH and DELETE round-trip", async () => {
  const h = buildHarness();
  const ids = await seed(h);
  // A second dataset to retarget at.
  const nowIso = new Date().toISOString();
  const secondId = randomUUID();
  await h.deps.datasets!.create({
    id: secondId,
    scope: "tenant",
    tenantId: ids.tenantId,
    environmentId: null,
    slug: "docs-2",
    displayName: "Docs (alt)",
    description: null,
    embeddingProfile: {},
    chunkSchema: {},
    modalities: ["vector"],
    backends: { vector: { provider: "qdrant" } },
    currentVersionId: null,
    archivedAt: null,
    createdAt: nowIso,
    createdBy: null,
    updatedAt: nowIso
  });
  const create = await h.request({
    method: "POST",
    path: `/api/pipelines/${ids.pipelineId}/dataset-bindings`,
    headers: { "x-tenant-id": ids.tenantId },
    body: {
      tenantId: ids.tenantId,
      sourceSlug: "docs",
      targetDatasetId: ids.overrideDsId
    }
  });
  const id = create.body.binding.id;
  const patch = await h.request({
    method: "PATCH",
    path: `/api/dataset-bindings/${id}`,
    headers: { "x-tenant-id": ids.tenantId },
    body: { targetDatasetId: secondId }
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.binding.targetDatasetId, secondId);
  const del = await h.request({
    method: "DELETE",
    path: `/api/dataset-bindings/${id}`,
    headers: { "x-tenant-id": ids.tenantId }
  });
  assert.equal(del.status, 204);
});

// ---- Resolver wiring ------------------------------------------------------

test("DatasetResolver: binding override beats default slug cascade", async () => {
  const h = buildHarness();
  const ids = await seed(h);
  // Pin: (pipeline, tenant=Acme, env=prod, slug="docs") → override DS.
  await h.deps.pipelineDatasetBindings!.create({
    id: randomUUID(),
    pipelineId: ids.pipelineId,
    tenantId: ids.tenantId,
    environmentId: "prod",
    sourceSlug: "docs",
    targetDatasetId: ids.overrideDsId,
    createdAt: new Date().toISOString(),
    createdBy: null,
    updatedAt: new Date().toISOString()
  });
  const resolver = buildApiDatasetResolver(h.deps)!;
  const prod = await resolver.resolve({
    ref: { slug: "docs" },
    tenantId: ids.tenantId,
    environmentId: "prod",
    pipelineId: ids.pipelineId
  });
  // The override dataset has a different slug ("docs-tenant-prod"),
  // proving the resolver bypassed the default `datasets.resolveSlug`
  // and used the binding target row directly.
  assert.equal(prod?.slug, "docs-tenant-prod");
});

test("DatasetResolver: dev (no binding) falls back to default cascade", async () => {
  const h = buildHarness();
  const ids = await seed(h);
  // Binding only for prod — dev should fall through to default.
  await h.deps.pipelineDatasetBindings!.create({
    id: randomUUID(),
    pipelineId: ids.pipelineId,
    tenantId: ids.tenantId,
    environmentId: "prod",
    sourceSlug: "docs",
    targetDatasetId: ids.overrideDsId,
    createdAt: new Date().toISOString(),
    createdBy: null,
    updatedAt: new Date().toISOString()
  });
  const resolver = buildApiDatasetResolver(h.deps)!;
  const dev = await resolver.resolve({
    ref: { slug: "docs" },
    tenantId: ids.tenantId,
    environmentId: "dev",
    pipelineId: ids.pipelineId
  });
  // dev sees the default (global) docs dataset, not the override.
  assert.equal(dev?.slug, "docs");
});

test("DatasetResolver: tenant-wide binding (env=null) applies to every env", async () => {
  const h = buildHarness();
  const ids = await seed(h);
  // env=null → applies to every env in this (pipeline, tenant).
  await h.deps.pipelineDatasetBindings!.create({
    id: randomUUID(),
    pipelineId: ids.pipelineId,
    tenantId: ids.tenantId,
    environmentId: null,
    sourceSlug: "docs",
    targetDatasetId: ids.overrideDsId,
    createdAt: new Date().toISOString(),
    createdBy: null,
    updatedAt: new Date().toISOString()
  });
  const resolver = buildApiDatasetResolver(h.deps)!;
  for (const env of ["dev", "prod"]) {
    const r = await resolver.resolve({
      ref: { slug: "docs" },
      tenantId: ids.tenantId,
      environmentId: env,
      pipelineId: ids.pipelineId
    });
    assert.equal(r?.slug, "docs-tenant-prod", `env=${env} should use binding`);
  }
});

test("DatasetResolver: no pipelineId → bindings ignored, default cascade used", async () => {
  const h = buildHarness();
  const ids = await seed(h);
  await h.deps.pipelineDatasetBindings!.create({
    id: randomUUID(),
    pipelineId: ids.pipelineId,
    tenantId: ids.tenantId,
    environmentId: null,
    sourceSlug: "docs",
    targetDatasetId: ids.overrideDsId,
    createdAt: new Date().toISOString(),
    createdBy: null,
    updatedAt: new Date().toISOString()
  });
  const resolver = buildApiDatasetResolver(h.deps)!;
  const r = await resolver.resolve({
    ref: { slug: "docs" },
    tenantId: ids.tenantId,
    environmentId: "prod"
    // intentionally no pipelineId — bindings shouldn't apply.
  });
  assert.equal(r?.slug, "docs", "caller without pipeline context sees the default");
});
