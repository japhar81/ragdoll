/**
 * API surface tests for the namespace-policy field on dataset backends
 * (PR6).
 *
 * Validation matrix is exhaustively unit-tested in
 * `packages/runtime/test/dataset-namespace.test.ts`; these tests prove
 * the API surface ACTUALLY calls the validator and rejects illegal
 * policy/scope combinations at the HTTP boundary, on both POST + PATCH.
 *
 * No happy-path resolve test here — that lives in
 * `dataset-namespace-resolver.test.ts` to keep this file focused on the
 * 422 contract.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildHarness } from "./helpers.ts";

async function seedTenant(h: ReturnType<typeof buildHarness>) {
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
  return tenantId;
}

test("POST /api/datasets accepts namespace=by-tenant on a global dataset", async () => {
  const h = buildHarness();
  const res = await h.request({
    method: "POST",
    path: "/api/datasets",
    body: {
      scope: "global",
      slug: "docs",
      displayName: "Docs",
      modalities: ["text"],
      backends: {
        text: { provider: "opensearch", index: "docs", namespace: "by-tenant" }
      }
    }
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.dataset.backends.text.namespace, "by-tenant");
});

test("POST /api/datasets rejects namespace=by-env on a global dataset (scope mismatch)", async () => {
  const h = buildHarness();
  const res = await h.request({
    method: "POST",
    path: "/api/datasets",
    body: {
      scope: "global",
      slug: "docs",
      displayName: "Docs",
      modalities: ["text"],
      backends: {
        text: { provider: "opensearch", namespace: "by-env" }
      }
    }
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, "validation_failed");
  assert.ok(
    res.body.issues.some(
      (i: { path?: string }) => i.path === "backends.text.namespace"
    )
  );
});

test("POST /api/datasets rejects namespace=by-tenant on a tenant-scope dataset (already implicit)", async () => {
  const h = buildHarness();
  const tenantId = await seedTenant(h);
  const res = await h.request({
    method: "POST",
    path: "/api/datasets",
    body: {
      scope: "tenant",
      tenantId,
      slug: "docs",
      displayName: "Docs",
      modalities: ["text"],
      backends: {
        text: { provider: "opensearch", namespace: "by-tenant" }
      }
    }
  });
  assert.equal(res.status, 422);
  assert.ok(
    res.body.issues.some(
      (i: { path?: string }) => i.path === "backends.text.namespace"
    )
  );
});

test("POST /api/datasets rejects ANY non-shared policy on an environment-scope dataset", async () => {
  const h = buildHarness();
  const tenantId = await seedTenant(h);
  const envId = randomUUID();
  await h.deps.environments!.create({
    id: envId,
    tenantId,
    name: "prod",
    description: null,
    isProduction: true,
    createdAt: new Date().toISOString()
  });
  const res = await h.request({
    method: "POST",
    path: "/api/datasets",
    body: {
      scope: "environment",
      tenantId,
      environmentId: "prod",
      slug: "docs",
      displayName: "Docs",
      modalities: ["text"],
      backends: {
        text: { provider: "opensearch", namespace: "by-tenant-env" }
      }
    }
  });
  assert.equal(res.status, 422);
});

test("POST /api/datasets allows missing namespace (= shared) on any scope", async () => {
  const h = buildHarness();
  const res = await h.request({
    method: "POST",
    path: "/api/datasets",
    body: {
      scope: "global",
      slug: "docs",
      displayName: "Docs",
      modalities: ["text"],
      backends: { text: { provider: "opensearch", index: "docs" } }
    }
  });
  assert.equal(res.status, 201);
});

test("PATCH /api/datasets/:id revalidates namespace against the EXISTING scope", async () => {
  const h = buildHarness();
  // Create a tenant-scope dataset first.
  const tenantId = await seedTenant(h);
  const createRes = await h.request({
    method: "POST",
    path: "/api/datasets",
    body: {
      scope: "tenant",
      tenantId,
      slug: "internal-kb",
      displayName: "Internal KB",
      modalities: ["text"],
      backends: { text: { provider: "opensearch" } }
    }
  });
  assert.equal(createRes.status, 201);
  const id = createRes.body.dataset.id;
  // PATCH that adds `by-tenant` — invalid for tenant scope; must 422.
  const patchRes = await h.request({
    method: "PATCH",
    path: `/api/datasets/${id}`,
    body: {
      backends: {
        text: { provider: "opensearch", namespace: "by-tenant" }
      }
    }
  });
  assert.equal(patchRes.status, 422);
  // The legal policy at tenant scope (`by-env`) is accepted.
  const patchOk = await h.request({
    method: "PATCH",
    path: `/api/datasets/${id}`,
    body: {
      backends: {
        text: { provider: "opensearch", namespace: "by-env" }
      }
    }
  });
  assert.equal(patchOk.status, 200);
  assert.equal(patchOk.body.dataset.backends.text.namespace, "by-env");
});
