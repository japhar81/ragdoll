/**
 * Tests for the namespace-policy expansion path in the shared dataset
 * resolver (PR6).
 *
 * Setup pattern mirrors `dataset-resolver-connections.test.ts`: one
 * dataset (scope varies per test), one or more tenants, optionally one
 * environment, then a single `resolver.resolve()` call. The resolver
 * walks the standard slug cascade, injects the resolved connection,
 * THEN applies the namespace policy from `backends.<modality>.namespace`
 * to the `backendCollections.<modality>` base name.
 *
 * What the tests prove end-to-end:
 *   - Shared / missing policy preserves the base collection name
 *     verbatim — back-compat for every legacy dataset.
 *   - `by-tenant` on a global dataset gives DIFFERENT tenants DIFFERENT
 *     collections from the SAME slug.
 *   - `by-tenant-env` extends further per environment.
 *   - `by-env` on a tenant-scope dataset gives DIFFERENT envs DIFFERENT
 *     collections; the tenant suffix is omitted (already implicit).
 *   - Sanitiser runs — slug `Tenant-A` becomes `tenant_a` in the suffix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildHarness } from "./helpers.ts";
import { buildApiDatasetResolver } from "../src/app/pipeline-execution.ts";

async function seedTenant(h: ReturnType<typeof buildHarness>, id: string, slug: string) {
  await h.deps.tenants.create({
    id,
    slug,
    name: slug,
    status: "active",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
}

async function seedEnvironment(
  h: ReturnType<typeof buildHarness>,
  envId: string,
  tenantId: string,
  name: string
) {
  await h.deps.environments!.create({
    id: envId,
    tenantId,
    name,
    description: null,
    isProduction: name === "prod",
    createdAt: new Date().toISOString()
  });
}

async function seedDataset(
  h: ReturnType<typeof buildHarness>,
  opts: {
    scope: "global" | "tenant" | "environment";
    tenantId?: string | null;
    environmentId?: string | null;
    slug: string;
    /** ADR-0023: free-text binding name → connection + optional
     *  collection override + optional namespace policy. */
    bindings: Record<
      string,
      { connection?: string; collection?: string; namespace?: string }
    >;
    backendCollections: Record<string, string>;
  }
) {
  const datasetId = randomUUID();
  const versionId = randomUUID();
  const now = new Date().toISOString();
  await h.deps.datasets!.create({
    id: datasetId,
    scope: opts.scope,
    tenantId: opts.tenantId ?? null,
    environmentId: opts.environmentId ?? null,
    slug: opts.slug,
    displayName: opts.slug,
    description: null,
    embeddingProfile: {},
    chunkSchema: {},
    bindings: opts.bindings,
    currentVersionId: versionId,
    archivedAt: null,
    createdAt: now,
    createdBy: null,
    updatedAt: now
  });
  await h.deps.datasetVersions!.create({
    id: versionId,
    datasetId,
    versionLabel: "v1",
    schemaSpec: {},
    backendCollections: opts.backendCollections,
    status: "ready",
    docCount: 0,
    sizeBytes: 0,
    createdAt: now,
    readyAt: now
  });
  return datasetId;
}

test("namespace=shared (default): tenant A and tenant B see the same collection", async () => {
  const h = buildHarness();
  await seedTenant(h, "tA", "tenant-a");
  await seedTenant(h, "tB", "tenant-b");
  await seedDataset(h, {
    scope: "global",
    slug: "docs",
    bindings: { text: { connection: "opensearch" } },
    backendCollections: { text: "docs_v1" }
  });
  const resolver = buildApiDatasetResolver(h.deps)!;
  const a = await resolver.resolve({ ref: { slug: "docs" }, tenantId: "tA" });
  const b = await resolver.resolve({ ref: { slug: "docs" }, tenantId: "tB" });
  assert.equal(a!.bindings.text.collection, "docs_v1");
  assert.equal(b!.bindings.text.collection, "docs_v1");
});

test("namespace=by-tenant on a global dataset: tenant A and tenant B get DIFFERENT collections from the same slug", async () => {
  const h = buildHarness();
  await seedTenant(h, "tA", "tenant-a");
  await seedTenant(h, "tB", "tenant-b");
  await seedDataset(h, {
    scope: "global",
    slug: "docs",
    bindings: {
      text: { connection: "opensearch", namespace: "by-tenant" }
    },
    backendCollections: { text: "docs_v1" }
  });
  const resolver = buildApiDatasetResolver(h.deps)!;
  const a = await resolver.resolve({ ref: { slug: "docs" }, tenantId: "tA" });
  const b = await resolver.resolve({ ref: { slug: "docs" }, tenantId: "tB" });
  assert.equal(a!.bindings.text.collection, "docs_v1_tenant_a");
  assert.equal(b!.bindings.text.collection, "docs_v1_tenant_b");
  // The binding's `namespace` policy is still carried through so the
  // UI can display it without re-fetching.
  assert.equal(a!.bindings.text.namespace, "by-tenant");
});

test("namespace=by-tenant-env on a global dataset: per-(tenant,env) split", async () => {
  const h = buildHarness();
  await seedTenant(h, "tA", "tenant-a");
  await seedEnvironment(h, "eDev", "tA", "dev");
  await seedEnvironment(h, "eProd", "tA", "prod");
  await seedDataset(h, {
    scope: "global",
    slug: "docs",
    bindings: {
      vector: { connection: "qdrant", namespace: "by-tenant-env" }
    },
    backendCollections: { vector: "docs" }
  });
  const resolver = buildApiDatasetResolver(h.deps)!;
  const dev = await resolver.resolve({
    ref: { slug: "docs" },
    tenantId: "tA",
    environmentId: "eDev"
  });
  const prod = await resolver.resolve({
    ref: { slug: "docs" },
    tenantId: "tA",
    environmentId: "eProd"
  });
  assert.equal(dev!.bindings.vector.collection, "docs_tenant_a_dev");
  assert.equal(prod!.bindings.vector.collection, "docs_tenant_a_prod");
});

test("namespace=by-tenant-env without env context: falls back to base (tenant-admin walking globals)", async () => {
  const h = buildHarness();
  await seedTenant(h, "tA", "tenant-a");
  await seedDataset(h, {
    scope: "global",
    slug: "docs",
    bindings: { vector: { connection: "qdrant", namespace: "by-tenant-env" } },
    backendCollections: { vector: "docs" }
  });
  const resolver = buildApiDatasetResolver(h.deps)!;
  const r = await resolver.resolve({ ref: { slug: "docs" }, tenantId: "tA" });
  // Missing env → degrades to base name. Resolver MUST NOT throw — the
  // dataset can still be used for cluster-admin inspection.
  assert.equal(r!.bindings.vector.collection, "docs");
});

test("namespace=by-env on a tenant-scope dataset: per-env split, NO tenant suffix (tenant is implicit)", async () => {
  const h = buildHarness();
  await seedTenant(h, "tA", "tenant-a");
  await seedEnvironment(h, "eDev", "tA", "dev");
  await seedEnvironment(h, "eStg", "tA", "staging");
  await seedDataset(h, {
    scope: "tenant",
    tenantId: "tA",
    slug: "internal-kb",
    bindings: {
      text: { connection: "opensearch", namespace: "by-env" }
    },
    backendCollections: { text: "kb" }
  });
  const resolver = buildApiDatasetResolver(h.deps)!;
  const dev = await resolver.resolve({
    ref: { slug: "internal-kb" },
    tenantId: "tA",
    environmentId: "eDev"
  });
  const stg = await resolver.resolve({
    ref: { slug: "internal-kb" },
    tenantId: "tA",
    environmentId: "eStg"
  });
  assert.equal(dev!.bindings.text.collection, "kb_dev");
  assert.equal(stg!.bindings.text.collection, "kb_staging");
});

test("namespace expansion runs per-modality independently", async () => {
  const h = buildHarness();
  await seedTenant(h, "tA", "tenant-a");
  await seedEnvironment(h, "eProd", "tA", "prod");
  await seedDataset(h, {
    scope: "global",
    slug: "docs",
    bindings: {
      // One binding fully scoped, the other shared.
      vector: { connection: "qdrant", namespace: "by-tenant-env" },
      text: { connection: "opensearch", namespace: "shared" }
    },
    backendCollections: { vector: "docs_vec", text: "docs_text" }
  });
  const resolver = buildApiDatasetResolver(h.deps)!;
  const r = await resolver.resolve({
    ref: { slug: "docs" },
    tenantId: "tA",
    environmentId: "eProd"
  });
  assert.equal(r!.bindings.vector.collection, "docs_vec_tenant_a_prod");
  assert.equal(r!.bindings.text.collection, "docs_text");
});

test("sanitiser pass-through: special chars in tenant slug get normalised in the suffix", async () => {
  const h = buildHarness();
  // Slug with a non-alphanumeric the column allows (hyphen).
  await seedTenant(h, "tA", "Tenant-A");
  await seedDataset(h, {
    scope: "global",
    slug: "docs",
    bindings: { vector: { connection: "qdrant", namespace: "by-tenant" } },
    backendCollections: { vector: "docs" }
  });
  const resolver = buildApiDatasetResolver(h.deps)!;
  const r = await resolver.resolve({ ref: { slug: "docs" }, tenantId: "tA" });
  // Hyphen collapsed to underscore, lowercased.
  assert.equal(r!.bindings.vector.collection, "docs_tenant_a");
});
