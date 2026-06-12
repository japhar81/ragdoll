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

// ---------------------------------------------------------------------------
// Connections — soft-archive by default, force=true hard-deletes
// ---------------------------------------------------------------------------

async function createConnection(harness: ReturnType<typeof buildHarness>, slug: string) {
  const out = await harness.request({
    method: "POST",
    path: "/api/connections",
    headers: ADMIN,
    body: {
      scope: "global",
      slug,
      displayName: slug,
      kind: "qdrant",
      config: { host: "stub" }
    }
  });
  assert.equal(out.status, 201, `connection POST: ${JSON.stringify(out.body)}`);
  return out.body.connection as { id: string; slug: string; archivedAt: string | null };
}

test("DELETE /api/connections/:id without ?force soft-archives (legacy behaviour preserved)", async () => {
  const harness = buildHarness();
  const conn = await createConnection(harness, "soft-arch");
  const archive = await harness.request({
    method: "DELETE",
    path: `/api/connections/${conn.id}`,
    headers: ADMIN
  });
  assert.equal(archive.status, 204);
  // Row still exists; archivedAt is set.
  const after = await harness.request({
    method: "GET",
    path: `/api/connections/${conn.id}`,
    headers: ADMIN
  });
  assert.equal(after.status, 200);
  assert.ok(after.body.connection.archivedAt, "archivedAt set");
});

test("DELETE /api/connections/:id?force=true hard-deletes when no datasets / pipelines reference the slug", async () => {
  const harness = buildHarness();
  const conn = await createConnection(harness, "force-clean");
  const del = await harness.request({
    method: "DELETE",
    path: `/api/connections/${conn.id}`,
    headers: ADMIN,
    query: { force: "true" }
  });
  assert.equal(del.status, 204);
  // Row gone — GET → 404.
  const after = await harness.request({
    method: "GET",
    path: `/api/connections/${conn.id}`,
    headers: ADMIN
  });
  assert.equal(after.status, 404);
});

test("DELETE /api/connections/:id?force=true refuses with 409 when a dataset binding references the slug", async () => {
  const harness = buildHarness();
  const conn = await createConnection(harness, "force-ref-dataset");
  // Dataset whose `vectors` binding points at this connection slug.
  const ds = await harness.request({
    method: "POST",
    path: "/api/datasets",
    headers: ADMIN,
    body: {
      scope: "global",
      slug: "ref-ds-via-conn",
      displayName: "Refs The Connection",
      bindings: { vectors: { connection: "force-ref-dataset" } }
    }
  });
  assert.equal(ds.status, 201, `dataset POST: ${JSON.stringify(ds.body)}`);
  const refusal = await harness.request({
    method: "DELETE",
    path: `/api/connections/${conn.id}`,
    headers: ADMIN,
    query: { force: "true" }
  });
  assert.equal(refusal.status, 409);
  assert.equal(refusal.body.error, "has_dependents");
  assert.equal(refusal.body.dependents.datasetBindings, 1);
});

test("DELETE /api/connections/:id?force=true refuses with 409 when a pipeline node references the slug", async () => {
  const harness = buildHarness();
  const conn = await createConnection(harness, "force-ref-pipeline");
  const pipe = await harness.request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "pipe-conn-ref", name: "pipe-conn-ref" }
  });
  const spec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "pipe-conn-ref" },
    spec: {
      nodes: [
        { id: "in", type: "input" },
        {
          id: "echo",
          plugin: { category: "transformer", id: "fake_echo", version: "1.0.0" },
          connection: { slug: "force-ref-pipeline" }
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
    path: `/api/pipelines/${pipe.body.pipeline.id}/versions`,
    headers: ADMIN,
    body: { version: "1.0.0", publish: true, spec }
  });
  assert.equal(ver.status, 201, `version POST: ${JSON.stringify(ver.body)}`);

  const refusal = await harness.request({
    method: "DELETE",
    path: `/api/connections/${conn.id}`,
    headers: ADMIN,
    query: { force: "true" }
  });
  assert.equal(refusal.status, 409);
  assert.equal(refusal.body.error, "has_dependents");
  assert.equal(refusal.body.dependents.pipelineReferences, 1);
});

test("GET /api/connections hides archived rows by default; ?include_archived=true surfaces them", async () => {
  // Regression: the UI "show archived" toggle was a no-op because
  // listVisibleAt (and its global-fallback path listAll) used to
  // hardcode archived_at IS NULL. The route now plumbs an
  // include_archived query param through both paths so the admin
  // screen can find rows it just archived.
  const harness = buildHarness();
  const active = await createConnection(harness, "still-active");
  const willArchive = await createConnection(harness, "soon-archived");
  // Archive one of them via the same soft-delete path the UI calls.
  const arch = await harness.request({
    method: "DELETE",
    path: `/api/connections/${willArchive.id}`,
    headers: ADMIN
  });
  assert.equal(arch.status, 204);

  // Default LIST: only the active row.
  const defaultList = await harness.request({
    method: "GET",
    path: "/api/connections",
    headers: ADMIN
  });
  assert.equal(defaultList.status, 200);
  const defaultSlugs = (defaultList.body.connections as Array<{ slug: string }>).map((c) => c.slug);
  assert.ok(defaultSlugs.includes("still-active"), `default list missing active row: ${defaultSlugs.join(",")}`);
  assert.ok(!defaultSlugs.includes("soon-archived"), `default list leaked archived row: ${defaultSlugs.join(",")}`);

  // Opt-in LIST: both rows come back.
  const archivedList = await harness.request({
    method: "GET",
    path: "/api/connections",
    headers: ADMIN,
    query: { include_archived: "true" }
  });
  assert.equal(archivedList.status, 200);
  const archivedSlugs = (archivedList.body.connections as Array<{ slug: string }>).map((c) => c.slug);
  assert.ok(
    archivedSlugs.includes("still-active") && archivedSlugs.includes("soon-archived"),
    `include_archived list missing one: ${archivedSlugs.join(",")}`
  );
  // Sanity: doesn't return phantom row for the active one.
  assert.equal(active.id, active.id);
});

test("GET /api/datasets hides archived rows by default; ?include_archived=true surfaces them", async () => {
  // Mirror of the connections regression — same shape, same gotcha:
  // listVisibleAt used to hardcode `archived_at IS NULL` deep in the
  // repo, so the Datasets screen's "show archived" toggle filtered an
  // empty set client-side. Plumbed includeArchived through types /
  // postgres / memory / route / api / screen.
  const harness = buildHarness();
  const ADMIN_HEADERS = { ...ADMIN };
  // Two global datasets, archive one.
  const a = await harness.request({
    method: "POST",
    path: "/api/datasets",
    headers: ADMIN_HEADERS,
    body: {
      scope: "global",
      slug: "ds-active",
      displayName: "ds-active",
      embeddingProfile: {},
      chunkSchema: {}
    }
  });
  assert.equal(a.status, 201);
  const b = await harness.request({
    method: "POST",
    path: "/api/datasets",
    headers: ADMIN_HEADERS,
    body: {
      scope: "global",
      slug: "ds-archived",
      displayName: "ds-archived",
      embeddingProfile: {},
      chunkSchema: {}
    }
  });
  assert.equal(b.status, 201);
  // Soft-archive via PATCH (the same path the UI's Archive button hits).
  const arch = await harness.request({
    method: "PATCH",
    path: `/api/datasets/${b.body.dataset.id}`,
    headers: ADMIN_HEADERS,
    body: { archived: true }
  });
  assert.equal(arch.status, 200);
  // Default LIST: only the active row.
  const def = await harness.request({
    method: "GET",
    path: "/api/datasets",
    headers: ADMIN_HEADERS
  });
  assert.equal(def.status, 200);
  const defaultSlugs = (def.body.datasets as Array<{ slug: string }>).map((d) => d.slug);
  assert.ok(defaultSlugs.includes("ds-active"));
  assert.ok(!defaultSlugs.includes("ds-archived"), `default leaked archived row: ${defaultSlugs.join(",")}`);
  // Opt-in LIST: both rows.
  const includeArchivedList = await harness.request({
    method: "GET",
    path: "/api/datasets",
    headers: ADMIN_HEADERS,
    query: { include_archived: "true" }
  });
  assert.equal(includeArchivedList.status, 200);
  const archivedSlugs = (includeArchivedList.body.datasets as Array<{ slug: string }>).map(
    (d) => d.slug
  );
  assert.ok(
    archivedSlugs.includes("ds-active") && archivedSlugs.includes("ds-archived"),
    `include_archived missing one: ${archivedSlugs.join(",")}`
  );
});

test("DELETE /api/connections/:id?force=true also nukes an already-archived row", async () => {
  // The intended UX: operator archives a connection (soft), realises
  // they want it gone for real, opens the archived row's Delete button
  // (force=true) and the row is hard-deleted. Tests this round-trip.
  const harness = buildHarness();
  const conn = await createConnection(harness, "archive-then-delete");
  await harness.request({
    method: "DELETE",
    path: `/api/connections/${conn.id}`,
    headers: ADMIN
  }); // soft-archive
  const force = await harness.request({
    method: "DELETE",
    path: `/api/connections/${conn.id}`,
    headers: ADMIN,
    query: { force: "true" }
  });
  assert.equal(force.status, 204);
  const after = await harness.request({
    method: "GET",
    path: `/api/connections/${conn.id}`,
    headers: ADMIN
  });
  assert.equal(after.status, 404);
});
