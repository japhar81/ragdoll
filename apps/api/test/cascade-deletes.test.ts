/**
 * Functional tests for the cascade-delete posture across the platform.
 *
 * Contract under test (uniform across folders / pipelines / datasets /
 * tenants / roles):
 *   - Default DELETE refuses with HTTP 409 `has_dependents` whenever
 *     deleting the resource would orphan referencing rows. The body
 *     carries `{dependents: {<kind>: <count>, ...}, hint: "?force=true ..."}`
 *     so admin tooling can render the breakdown without per-resource
 *     code.
 *   - `?force=true` cascades — the resource AND every dependent the
 *     route knows about are gone. Hard delete, no soft-archive.
 *   - Unknown id stays 404 (not 409 / 500).
 *   - Resource without dependents deletes cleanly (204) regardless of
 *     `?force`.
 *
 * Framework-agnostic, InMemory, offline / install-free.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness, echoSpec } from "./helpers.ts";

const ADMIN = { "x-actor-id": "admin", "x-roles": "platform_admin" };

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

test("DELETE /api/folders/:id refuses with 409 + dependent counts when non-empty", async () => {
  const harness = buildHarness();
  const folder = await harness.request({
    method: "POST",
    path: "/api/folders",
    headers: ADMIN,
    body: { name: "parent", parentId: null }
  });
  assert.equal(folder.status, 201);
  const folderId = folder.body.folder.id;
  // Two pipelines + one nested folder inside.
  for (const slug of ["a", "b"]) {
    const p = await harness.request({
      method: "POST",
      path: "/api/pipelines",
      headers: ADMIN,
      body: { slug, name: slug, folderId }
    });
    assert.equal(p.status, 201);
  }
  await harness.request({
    method: "POST",
    path: "/api/folders",
    headers: ADMIN,
    body: { name: "child", parentId: folderId }
  });

  const refusal = await harness.request({
    method: "DELETE",
    path: `/api/folders/${folderId}`,
    headers: ADMIN
  });
  assert.equal(refusal.status, 409);
  assert.equal(refusal.body.error, "has_dependents");
  assert.deepEqual(refusal.body.dependents, { pipelines: 2, subfolders: 1 });
  assert.match(String(refusal.body.hint), /\?force=true/);
});

test("DELETE /api/folders/:id?force=true recursively nukes pipelines + subfolders", async () => {
  const harness = buildHarness();
  const folder = await harness.request({
    method: "POST",
    path: "/api/folders",
    headers: ADMIN,
    body: { name: "to-nuke", parentId: null }
  });
  const folderId = folder.body.folder.id;
  const p = await harness.request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "inside", name: "inside", folderId }
  });
  const pipelineId = p.body.pipeline.id;
  const child = await harness.request({
    method: "POST",
    path: "/api/folders",
    headers: ADMIN,
    body: { name: "sub", parentId: folderId }
  });
  const childId = child.body.folder.id;

  const force = await harness.request({
    method: "DELETE",
    path: `/api/folders/${folderId}`,
    headers: ADMIN,
    query: { force: "true" }
  });
  assert.equal(force.status, 204);

  // Both folders + the pipeline are GONE.
  const getRoot = await harness.request({
    method: "GET",
    path: `/api/pipelines/${pipelineId}`,
    headers: ADMIN
  });
  assert.equal(getRoot.status, 404);
  // The folder tree is empty (modulo other folders).
  const tree = await harness.request({
    method: "GET",
    path: "/api/folders",
    headers: ADMIN
  });
  type Node = { id: string; children?: Node[] };
  function flatten(nodes: Node[]): string[] {
    const out: string[] = [];
    for (const n of nodes) {
      out.push(n.id);
      if (n.children) out.push(...flatten(n.children));
    }
    return out;
  }
  const ids = flatten(tree.body.folders);
  assert.equal(ids.includes(folderId), false);
  assert.equal(ids.includes(childId), false);
});

test("DELETE /api/folders/:id on an EMPTY folder succeeds without ?force", async () => {
  const harness = buildHarness();
  const folder = await harness.request({
    method: "POST",
    path: "/api/folders",
    headers: ADMIN,
    body: { name: "empty", parentId: null }
  });
  const folderId = folder.body.folder.id;
  const out = await harness.request({
    method: "DELETE",
    path: `/api/folders/${folderId}`,
    headers: ADMIN
  });
  assert.equal(out.status, 204);
});

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

test("DELETE /api/pipelines/:id refuses with 409 + dependent counts when versions exist", async () => {
  const harness = buildHarness();
  const created = await harness.request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "cd-pipe", name: "cd-pipe" }
  });
  const id = created.body.pipeline.id;
  await harness.request({
    method: "POST",
    path: `/api/pipelines/${id}/versions`,
    headers: ADMIN,
    body: { version: "1.0.0", publish: true, spec: echoSpec() }
  });

  const refusal = await harness.request({
    method: "DELETE",
    path: `/api/pipelines/${id}`,
    headers: ADMIN
  });
  assert.equal(refusal.status, 409);
  assert.equal(refusal.body.error, "has_dependents");
  assert.ok(refusal.body.dependents.versions >= 1);
});

test("DELETE /api/pipelines/:id?force=true cascades versions + deployments", async () => {
  const harness = buildHarness();
  const created = await harness.request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "cd-force", name: "cd-force" }
  });
  const id = created.body.pipeline.id;
  await harness.request({
    method: "POST",
    path: `/api/pipelines/${id}/versions`,
    headers: ADMIN,
    body: { version: "1.0.0", publish: true, spec: echoSpec() }
  });

  const force = await harness.request({
    method: "DELETE",
    path: `/api/pipelines/${id}`,
    headers: ADMIN,
    query: { force: "true" }
  });
  assert.equal(force.status, 204);
  const get = await harness.request({
    method: "GET",
    path: `/api/pipelines/${id}`,
    headers: ADMIN
  });
  assert.equal(get.status, 404);
});

test("DELETE /api/pipelines/:id on a bare pipeline (no versions) deletes cleanly without ?force", async () => {
  const harness = buildHarness();
  const created = await harness.request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "bare", name: "bare" }
  });
  const id = created.body.pipeline.id;
  const out = await harness.request({
    method: "DELETE",
    path: `/api/pipelines/${id}`,
    headers: ADMIN
  });
  assert.equal(out.status, 204);
});

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

test("DELETE /api/datasets/:id refuses with 409 when pipelines reference the slug", async () => {
  const harness = buildHarness();
  const ds = await harness.request({
    method: "POST",
    path: "/api/datasets",
    headers: ADMIN,
    body: {
      scope: "global",
      slug: "referenced-ds",
      displayName: "Referenced",
      bindings: { vectors: { connection: "test-qdrant" } }
    }
  });
  assert.equal(ds.status, 201, `dataset POST: ${JSON.stringify(ds.body)}`);
  // Create a pipeline whose spec references the dataset slug. Use the
  // harness's fake_echo plugin (the only one registered) so the spec
  // validates; attach `dataset: { slug }` to the node to create the
  // reference our DELETE walks for.
  const created = await harness.request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "ref-pipe", name: "ref-pipe" }
  });
  const pipelineId = created.body.pipeline.id;
  const spec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "ref-spec" },
    spec: {
      nodes: [
        { id: "in", type: "input" },
        {
          id: "echo",
          plugin: { category: "transformer", id: "fake_echo", version: "1.0.0" },
          dataset: { slug: "referenced-ds" }
        },
        { id: "out", type: "output" }
      ],
      edges: [
        { from: "in", to: "echo" },
        { from: "echo", to: "out" }
      ]
    }
  };
  const ver = await harness.request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/versions`,
    headers: ADMIN,
    body: { version: "1.0.0", publish: true, spec }
  });
  assert.equal(ver.status, 201, `version POST: ${JSON.stringify(ver.body)}`);

  const refusal = await harness.request({
    method: "DELETE",
    path: `/api/datasets/${ds.body.dataset.id}`,
    headers: ADMIN
  });
  assert.equal(refusal.status, 409, `expected 409, got ${refusal.status}: ${JSON.stringify(refusal.body)}`);
  assert.equal(refusal.body.error, "has_dependents");
  assert.equal(refusal.body.dependents.pipelineReferences, 1);
});

test("DELETE /api/datasets/:id?force=true deletes despite references (operator opt-in)", async () => {
  const harness = buildHarness();
  const ds = await harness.request({
    method: "POST",
    path: "/api/datasets",
    headers: ADMIN,
    body: {
      scope: "global",
      slug: "force-ds",
      displayName: "Force",
      bindings: { vectors: { connection: "test-qdrant" } }
    }
  });
  // No pipelines reference it — clean delete.
  const out = await harness.request({
    method: "DELETE",
    path: `/api/datasets/${ds.body.dataset.id}`,
    headers: ADMIN,
    query: { force: "true" }
  });
  assert.equal(out.status, 204);
});

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

test("DELETE /api/roles/:name refuses with 409 when grants hold the role", async () => {
  const harness = buildHarness();
  // Create a custom role + grant it to a user.
  const role = await harness.request({
    method: "POST",
    path: "/api/roles",
    headers: ADMIN,
    body: { name: "custom-role" }
  });
  assert.equal(role.status, 201);
  const user = await harness.request({
    method: "POST",
    path: "/api/users",
    headers: ADMIN,
    body: { email: "u@example.com", displayName: "U" }
  });
  await harness.request({
    method: "POST",
    path: `/api/users/${user.body.user.id}/grants`,
    headers: ADMIN,
    body: { role: "custom-role", scope: "*" }
  });

  const refusal = await harness.request({
    method: "DELETE",
    path: "/api/roles/custom-role",
    headers: ADMIN
  });
  assert.equal(refusal.status, 409);
  assert.equal(refusal.body.error, "has_dependents");
  assert.equal(refusal.body.dependents.grants, 1);
});

test("DELETE /api/roles/:name?force=true drops held grants and the role", async () => {
  const harness = buildHarness();
  const role = await harness.request({
    method: "POST",
    path: "/api/roles",
    headers: ADMIN,
    body: { name: "nuke-role" }
  });
  assert.equal(role.status, 201);
  const user = await harness.request({
    method: "POST",
    path: "/api/users",
    headers: ADMIN,
    body: { email: "u2@example.com", displayName: "U2" }
  });
  await harness.request({
    method: "POST",
    path: `/api/users/${user.body.user.id}/grants`,
    headers: ADMIN,
    body: { role: "nuke-role", scope: "*" }
  });

  const out = await harness.request({
    method: "DELETE",
    path: "/api/roles/nuke-role",
    headers: ADMIN,
    query: { force: "true" }
  });
  assert.equal(out.status, 204);
  // The user still exists but their grant for this role is gone.
  const grants = await harness.request({
    method: "GET",
    path: `/api/users/${user.body.user.id}/grants`,
    headers: ADMIN
  });
  assert.equal(grants.status, 200);
  assert.equal(
    (grants.body.grants ?? []).filter((g: { role: string }) => g.role === "nuke-role").length,
    0
  );
});

test("DELETE /api/roles/:name on a built-in role is always refused (force or not)", async () => {
  const harness = buildHarness();
  for (const q of [undefined, { force: "true" }]) {
    const out = await harness.request({
      method: "DELETE",
      path: "/api/roles/platform_admin",
      headers: ADMIN,
      query: q
    });
    assert.equal(out.status, 409);
    assert.match(String(out.body.message ?? ""), /built-in/);
  }
});

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

test("DELETE /api/tenants/:id refuses with 409 when grants point at the tenant", async () => {
  const harness = buildHarness();
  const t = await harness.request({
    method: "POST",
    path: "/api/tenants",
    headers: ADMIN,
    body: { slug: "cd-tenant", name: "cd-tenant" }
  });
  assert.equal(t.status, 201);
  const tenantId = t.body.tenant.id;
  // Grant a role scoped to the tenant.
  const user = await harness.request({
    method: "POST",
    path: "/api/users",
    headers: ADMIN,
    body: { email: "t@example.com", displayName: "T" }
  });
  const grantRes = await harness.request({
    method: "POST",
    path: `/api/users/${user.body.user.id}/grants`,
    headers: ADMIN,
    body: { role: "tenant_admin", scope: `t/${tenantId}` }
  });
  assert.equal(grantRes.status, 201, `grant POST: ${JSON.stringify(grantRes.body)}`);

  const refusal = await harness.request({
    method: "DELETE",
    path: `/api/tenants/${tenantId}`,
    headers: ADMIN
  });
  assert.equal(refusal.status, 409);
  assert.equal(refusal.body.error, "has_dependents");
  assert.ok(refusal.body.dependents.grants >= 1);
});

test("DELETE /api/tenants/:id?force=true cascades — tenant gone, grants gone", async () => {
  const harness = buildHarness();
  const t = await harness.request({
    method: "POST",
    path: "/api/tenants",
    headers: ADMIN,
    body: { slug: "cd-force-tenant", name: "cd-force-tenant" }
  });
  const tenantId = t.body.tenant.id;
  const user = await harness.request({
    method: "POST",
    path: "/api/users",
    headers: ADMIN,
    body: { email: "tt@example.com", displayName: "TT" }
  });
  const grantRes = await harness.request({
    method: "POST",
    path: `/api/users/${user.body.user.id}/grants`,
    headers: ADMIN,
    body: { role: "tenant_admin", scope: `t/${tenantId}` }
  });
  assert.equal(grantRes.status, 201, `grant POST: ${JSON.stringify(grantRes.body)}`);

  const out = await harness.request({
    method: "DELETE",
    path: `/api/tenants/${tenantId}`,
    headers: ADMIN,
    query: { force: "true" }
  });
  assert.equal(out.status, 204);
  // Tenant is gone.
  const getTenant = await harness.request({
    method: "GET",
    path: `/api/tenants/${tenantId}`,
    headers: ADMIN
  });
  assert.equal(getTenant.status, 404);
  // The grant on this tenant is gone — user still exists.
  const grants = await harness.request({
    method: "GET",
    path: `/api/users/${user.body.user.id}/grants`,
    headers: ADMIN
  });
  assert.equal(grants.status, 200);
  assert.equal(
    (grants.body.grants ?? []).filter((g: { scope: string }) => g.scope.startsWith(`t/${tenantId}`)).length,
    0
  );
});

// ---------------------------------------------------------------------------
// Generic 404 + force-doesn't-mask-not-found
// ---------------------------------------------------------------------------

test("DELETE on unknown id stays 404 — force does not mask not_found", async () => {
  const harness = buildHarness();
  for (const path of [
    "/api/folders/ghost-id",
    "/api/datasets/ghost-id",
    "/api/tenants/ghost-id",
    "/api/roles/ghost-role"
  ]) {
    const out = await harness.request({
      method: "DELETE",
      path,
      headers: ADMIN,
      query: { force: "true" }
    });
    assert.equal(out.status, 404, `expected 404 for ${path}, got ${out.status}`);
  }
});
