/**
 * Phase 4 acceptance — Dataset CRUD + RBAC + scope resolution.
 *
 * Lives under tests/security/ because the interesting checks are
 * authorization-shaped: who can create / read / archive a dataset at
 * which scope. The repository-level invariants (slug uniqueness within
 * scope, env > tenant > global resolution) are covered too because they
 * back the RBAC promises — a tenant_admin@T can read a global dataset's
 * resolved record but cannot create a global one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildHarness } from "../../apps/api/test/helpers.ts";

async function seedUser(
  h: ReturnType<typeof buildHarness>,
  opts: {
    email: string;
    grants?: Array<{ role: string; scope: string }>;
  }
): Promise<{ id: string; bearer: Record<string, string> }> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await h.deps.users!.create({
    id,
    email: opts.email,
    displayName: opts.email,
    passwordHash: null,
    status: "active",
    createdAt: now,
    updatedAt: now
  });
  for (const g of opts.grants ?? []) {
    await h.deps.rbacPolicies!.addGrant({
      id: randomUUID(),
      userId: id,
      role: g.role,
      scope: g.scope,
      createdAt: now
    });
  }
  const token = h.sessions.sign({ id, type: "user", roles: [] }, 3600);
  return { id, bearer: { authorization: `Bearer ${token}` } };
}

async function seedTenant(
  h: ReturnType<typeof buildHarness>,
  slug: string
): Promise<string> {
  const tenantId = randomUUID();
  const now = new Date().toISOString();
  await h.deps.tenants.create({
    id: tenantId,
    slug,
    name: slug,
    status: "active",
    metadata: {},
    createdAt: now,
    updatedAt: now
  });
  await h.deps.environments!.create({
    id: randomUUID(),
    tenantId,
    name: "prod",
    description: "Production",
    isProduction: true,
    createdAt: now
  });
  await h.deps.environments!.create({
    id: randomUUID(),
    tenantId,
    name: "dev",
    description: "Development",
    isProduction: false,
    createdAt: now
  });
  return tenantId;
}

// --- shape -----------------------------------------------------------------

test("create / get / list a tenant-scoped dataset", async () => {
  const h = buildHarness({ withAuth: true });
  const tenantId = await seedTenant(h, "acme");
  const { bearer } = await seedUser(h, {
    email: "admin@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });

  const created = await h.request({
    method: "POST",
    path: "/api/datasets",
    headers: bearer,
    body: {
      scope: "tenant",
      tenantId,
      slug: "support-kb",
      displayName: "Support KB"
    }
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.dataset.scope, "tenant");
  assert.equal(created.body.dataset.slug, "support-kb");
  assert.equal(created.body.dataset.tenantId, tenantId);
  assert.equal(created.body.dataset.environmentId, null);
  // ADR-0023: datasets no longer carry a modalities array; bindings
  // are the storage shape. A new dataset starts with empty bindings.
  assert.deepEqual(created.body.dataset.bindings, {});

  const got = await h.request({
    method: "GET",
    path: `/api/datasets/${created.body.dataset.id}`,
    headers: bearer
  });
  assert.equal(got.status, 200);
  assert.equal(got.body.dataset.id, created.body.dataset.id);

  const listed = await h.request({
    method: "GET",
    path: "/api/datasets",
    headers: { ...bearer, "x-tenant-id": tenantId }
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.datasets.length, 1);
});

test("env-scoped dataset requires both tenantId and environmentId", async () => {
  const h = buildHarness({ withAuth: true });
  const tenantId = await seedTenant(h, "acme");
  const { bearer } = await seedUser(h, {
    email: "admin@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const res = await h.request({
    method: "POST",
    path: "/api/datasets",
    headers: bearer,
    body: { scope: "environment", tenantId, slug: "x", displayName: "X" }
  });
  assert.equal(res.status, 422);
});

test("global dataset can be created and read across tenants", async () => {
  const h = buildHarness({ withAuth: true });
  const tenantA = await seedTenant(h, "a");
  await seedTenant(h, "b");
  const admin = await seedUser(h, {
    email: "admin@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const created = await h.request({
    method: "POST",
    path: "/api/datasets",
    headers: admin.bearer,
    body: { scope: "global", slug: "world", displayName: "World" }
  });
  assert.equal(created.status, 201);
  // Listing in either tenant surfaces the global dataset.
  const fromA = await h.request({
    method: "GET",
    path: "/api/datasets",
    headers: { ...admin.bearer, "x-tenant-id": tenantA }
  });
  assert.equal(fromA.body.datasets.length, 1);
  assert.equal(fromA.body.datasets[0].scope, "global");
});

// --- RBAC ------------------------------------------------------------------

test("a viewer cannot create a dataset but can read one", async () => {
  const h = buildHarness({ withAuth: true });
  const tenantId = await seedTenant(h, "acme");
  const admin = await seedUser(h, {
    email: "admin@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const viewer = await seedUser(h, {
    email: "v@x.io",
    grants: [{ role: "viewer", scope: `t/${tenantId}` }]
  });
  // Admin creates.
  const created = await h.request({
    method: "POST",
    path: "/api/datasets",
    headers: admin.bearer,
    body: {
      scope: "tenant",
      tenantId,
      slug: "kb",
      displayName: "KB"
    }
  });
  assert.equal(created.status, 201);
  const id: string = created.body.dataset.id;
  // Viewer attempts to create — denied.
  const v1 = await h.request({
    method: "POST",
    path: "/api/datasets",
    headers: viewer.bearer,
    body: {
      scope: "tenant",
      tenantId,
      slug: "kb2",
      displayName: "KB2"
    }
  });
  assert.equal(v1.status, 403);
  // Viewer can read.
  const v2 = await h.request({
    method: "GET",
    path: `/api/datasets/${id}`,
    headers: viewer.bearer
  });
  assert.equal(v2.status, 200);
});

test("a tenant_admin cannot create a global dataset", async () => {
  const h = buildHarness({ withAuth: true });
  const tenantId = await seedTenant(h, "acme");
  const t = await seedUser(h, {
    email: "t@x.io",
    grants: [{ role: "tenant_admin", scope: `t/${tenantId}` }]
  });
  const res = await h.request({
    method: "POST",
    path: "/api/datasets",
    headers: t.bearer,
    body: { scope: "global", slug: "world", displayName: "World" }
  });
  assert.equal(res.status, 403);
});

// --- versions + aliases ----------------------------------------------------

test("creating a first version auto-sets currentVersionId + stable alias", async () => {
  const h = buildHarness({ withAuth: true });
  const tenantId = await seedTenant(h, "acme");
  const { bearer } = await seedUser(h, {
    email: "admin@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const ds = (
    await h.request({
      method: "POST",
      path: "/api/datasets",
      headers: bearer,
      body: { scope: "tenant", tenantId, slug: "kb", displayName: "KB" }
    })
  ).body.dataset;
  assert.equal(ds.currentVersionId, null);
  const ver = await h.request({
    method: "POST",
    path: `/api/datasets/${ds.id}/versions`,
    headers: bearer,
    body: {
      backendCollections: { vector: "rag_acme_kb_v1" },
      status: "ready"
    }
  });
  assert.equal(ver.status, 201);
  assert.equal(ver.body.version.versionLabel, "v1");
  // Dataset now has currentVersionId pointing at the new version + a
  // stable alias.
  const refetched = (
    await h.request({
      method: "GET",
      path: `/api/datasets/${ds.id}`,
      headers: bearer
    })
  ).body.dataset;
  assert.equal(refetched.currentVersionId, ver.body.version.id);
  const versions = (
    await h.request({
      method: "GET",
      path: `/api/datasets/${ds.id}/versions`,
      headers: bearer
    })
  ).body;
  assert.equal(versions.aliases.length, 1);
  assert.equal(versions.aliases[0].alias, "stable");
  assert.equal(versions.aliases[0].versionId, ver.body.version.id);
});

test("alias swap retargets to a different version atomically", async () => {
  const h = buildHarness({ withAuth: true });
  const tenantId = await seedTenant(h, "acme");
  const { bearer } = await seedUser(h, {
    email: "admin@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const ds = (
    await h.request({
      method: "POST",
      path: "/api/datasets",
      headers: bearer,
      body: { scope: "tenant", tenantId, slug: "kb", displayName: "KB" }
    })
  ).body.dataset;
  const v1 = (
    await h.request({
      method: "POST",
      path: `/api/datasets/${ds.id}/versions`,
      headers: bearer,
      body: { backendCollections: {}, status: "ready" }
    })
  ).body.version;
  const v2 = (
    await h.request({
      method: "POST",
      path: `/api/datasets/${ds.id}/versions`,
      headers: bearer,
      body: { backendCollections: {}, status: "ready" }
    })
  ).body.version;
  // Initially stable -> v1.
  let versions = (
    await h.request({
      method: "GET",
      path: `/api/datasets/${ds.id}/versions`,
      headers: bearer
    })
  ).body;
  const stable = versions.aliases.find((a: { alias: string }) => a.alias === "stable");
  assert.equal(stable.versionId, v1.id);
  // Swap stable -> v2.
  const swap = await h.request({
    method: "PATCH",
    path: `/api/datasets/${ds.id}/aliases/stable`,
    headers: bearer,
    body: { versionId: v2.id }
  });
  assert.equal(swap.status, 200);
  versions = (
    await h.request({
      method: "GET",
      path: `/api/datasets/${ds.id}/versions`,
      headers: bearer
    })
  ).body;
  const swapped = versions.aliases.find((a: { alias: string }) => a.alias === "stable");
  assert.equal(swapped.versionId, v2.id);
});

// --- repo invariants --------------------------------------------------------

test("dataset slug must be unique within its scope", async () => {
  const h = buildHarness({ withAuth: true });
  const tenantId = await seedTenant(h, "acme");
  const { bearer } = await seedUser(h, {
    email: "admin@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const first = await h.request({
    method: "POST",
    path: "/api/datasets",
    headers: bearer,
    body: { scope: "tenant", tenantId, slug: "kb", displayName: "KB" }
  });
  assert.equal(first.status, 201);
  const dup = await h.request({
    method: "POST",
    path: "/api/datasets",
    headers: bearer,
    body: { scope: "tenant", tenantId, slug: "kb", displayName: "KB v2" }
  });
  // Same slug at the same scope -> 409.
  assert.equal(dup.status, 409);
});

test("env-scoped slug can coexist with same slug at tenant scope", async () => {
  const h = buildHarness({ withAuth: true });
  const tenantId = await seedTenant(h, "acme");
  const { bearer } = await seedUser(h, {
    email: "admin@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const tenantScoped = await h.request({
    method: "POST",
    path: "/api/datasets",
    headers: bearer,
    body: { scope: "tenant", tenantId, slug: "kb", displayName: "KB tenant" }
  });
  assert.equal(tenantScoped.status, 201);
  const envScoped = await h.request({
    method: "POST",
    path: "/api/datasets",
    headers: bearer,
    body: {
      scope: "environment",
      tenantId,
      environmentId: "prod",
      slug: "kb",
      displayName: "KB prod"
    }
  });
  // Different scopes -> allowed even with the same slug.
  assert.equal(envScoped.status, 201);
});
