/**
 * API integration tests for /api/connections.
 *
 * Covers the CRUD path + the per-env list filter + the cascade
 * diagnostic endpoint. The cascade *semantics* live in the
 * repository tests (packages/db/test/connections.test.ts); these
 * tests are about the HTTP surface and the env-aware list dedup.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildHarness } from "./helpers.ts";

async function seedTenantAndEnvs(h: ReturnType<typeof buildHarness>) {
  const tenantId = randomUUID();
  const now = new Date().toISOString();
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
  for (const name of ["dev", "prod", "qa"]) {
    await h.deps.environments!.create({
      id: randomUUID(),
      tenantId,
      name,
      description: null,
      isProduction: name === "prod",
      createdAt: now
    });
  }
  return tenantId;
}

test("POST /api/connections creates a tenant-wide connection (no env)", async () => {
  const h = buildHarness();
  const tenantId = await seedTenantAndEnvs(h);
  const res = await h.request({
    method: "POST",
    path: "/api/connections",
    headers: { "x-tenant-id": tenantId },
    body: {
      name: "os-main",
      datasourceType: "opensearch",
      config: { host: "os.acme.example", port: 9200 }
    }
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.connection.name, "os-main");
  assert.equal(res.body.connection.environmentId, null);
  assert.equal(res.body.connection.config.host, "os.acme.example");
});

test("POST /api/connections rejects unknown env", async () => {
  const h = buildHarness();
  const tenantId = await seedTenantAndEnvs(h);
  const res = await h.request({
    method: "POST",
    path: "/api/connections",
    headers: { "x-tenant-id": tenantId },
    body: {
      name: "os-main",
      datasourceType: "opensearch",
      environmentId: "moon",
      config: { host: "x" }
    }
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, "validation_failed");
});

test("POST rejects unknown datasourceType", async () => {
  const h = buildHarness();
  const tenantId = await seedTenantAndEnvs(h);
  const res = await h.request({
    method: "POST",
    path: "/api/connections",
    headers: { "x-tenant-id": tenantId },
    body: { name: "x", datasourceType: "neo4j", config: {} }
  });
  assert.equal(res.status, 422);
});

test("GET /api/connections?environmentId=prod dedupes by name, env-specific wins", async () => {
  const h = buildHarness();
  const tenantId = await seedTenantAndEnvs(h);
  const base = { "x-tenant-id": tenantId };
  // Tenant-wide fallback row…
  await h.request({
    method: "POST",
    path: "/api/connections",
    headers: base,
    body: { name: "os", datasourceType: "opensearch", config: { host: "wide" } }
  });
  // …and a prod-specific override.
  await h.request({
    method: "POST",
    path: "/api/connections",
    headers: base,
    body: {
      name: "os",
      datasourceType: "opensearch",
      environmentId: "prod",
      config: { host: "prod-only" }
    }
  });
  // Filtered list MUST surface the prod row for `os` (not the wide one).
  const res = await h.request({
    method: "GET",
    path: "/api/connections",
    headers: base,
    query: { environmentId: "prod" }
  });
  assert.equal(res.status, 200);
  const matching = res.body.connections.filter((c: any) => c.name === "os");
  assert.equal(matching.length, 1, "dedupes on name");
  assert.equal(matching[0].environmentId, "prod");
  assert.equal(matching[0].config.host, "prod-only");
});

test("GET ?environmentId=dev falls through to tenant-wide row when no override", async () => {
  const h = buildHarness();
  const tenantId = await seedTenantAndEnvs(h);
  const base = { "x-tenant-id": tenantId };
  await h.request({
    method: "POST",
    path: "/api/connections",
    headers: base,
    body: { name: "os", datasourceType: "opensearch", config: { host: "wide" } }
  });
  await h.request({
    method: "POST",
    path: "/api/connections",
    headers: base,
    body: {
      name: "os",
      datasourceType: "opensearch",
      environmentId: "prod",
      config: { host: "prod-only" }
    }
  });
  // dev has no override → returns the tenant-wide row.
  const res = await h.request({
    method: "GET",
    path: "/api/connections",
    headers: base,
    query: { environmentId: "dev" }
  });
  const matching = res.body.connections.filter((c: any) => c.name === "os");
  assert.equal(matching.length, 1);
  assert.equal(matching[0].environmentId, null);
  assert.equal(matching[0].config.host, "wide");
});

test("GET /api/connections/resolve/:name reports cascade reason", async () => {
  const h = buildHarness();
  const tenantId = await seedTenantAndEnvs(h);
  const base = { "x-tenant-id": tenantId };
  await h.request({
    method: "POST",
    path: "/api/connections",
    headers: base,
    body: { name: "os", datasourceType: "opensearch", config: { host: "wide" } }
  });
  await h.request({
    method: "POST",
    path: "/api/connections",
    headers: base,
    body: {
      name: "os",
      datasourceType: "opensearch",
      environmentId: "prod",
      config: { host: "prod-only" }
    }
  });
  // Env-specific hit → `env_specific`.
  const prod = await h.request({
    method: "GET",
    path: "/api/connections/resolve/os",
    headers: base,
    query: { environmentId: "prod" }
  });
  assert.equal(prod.status, 200);
  assert.equal(prod.body.reason, "env_specific");
  assert.equal(prod.body.resolved.config.host, "prod-only");
  // Fall-through → `tenant_fallback`.
  const dev = await h.request({
    method: "GET",
    path: "/api/connections/resolve/os",
    headers: base,
    query: { environmentId: "dev" }
  });
  assert.equal(dev.body.reason, "tenant_fallback");
  assert.equal(dev.body.resolved.config.host, "wide");
  // No match → `no_match`.
  const unknown = await h.request({
    method: "GET",
    path: "/api/connections/resolve/qdrant",
    headers: base,
    query: { environmentId: "prod" }
  });
  assert.equal(unknown.body.reason, "no_match");
  assert.equal(unknown.body.resolved, null);
});

test("PATCH and DELETE round-trip", async () => {
  const h = buildHarness();
  const tenantId = await seedTenantAndEnvs(h);
  const base = { "x-tenant-id": tenantId };
  const create = await h.request({
    method: "POST",
    path: "/api/connections",
    headers: base,
    body: { name: "os", datasourceType: "opensearch", config: { host: "v1" } }
  });
  const id = create.body.connection.id;
  const patch = await h.request({
    method: "PATCH",
    path: `/api/connections/${id}`,
    headers: base,
    body: { config: { host: "v2" } }
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.connection.config.host, "v2");
  const del = await h.request({
    method: "DELETE",
    path: `/api/connections/${id}`,
    headers: base
  });
  assert.equal(del.status, 204);
  const after = await h.request({
    method: "GET",
    path: `/api/connections/${id}`,
    headers: base
  });
  assert.equal(after.status, 404);
});

test("GET /api/connections returns 400 without x-tenant-id", async () => {
  const h = buildHarness();
  const res = await h.request({ method: "GET", path: "/api/connections" });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "tenant_required");
});
