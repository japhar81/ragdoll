/**
 * Functional tests for pipeline `:id` path-param resolution. The web builder
 * POSTs `/api/pipelines/<slug>/run` (a NAME/slug, not a UUID). These tests
 * lock in:
 *   - run / save / versions resolve identically by SLUG and by UUID,
 *   - an unknown id-or-slug -> 404 pipeline_not_found (NOT 500),
 *   - a resolvable pipeline with no deployment/activation -> 409 with a
 *     human message (NOT 500),
 *   - a malformed-uuid-ish ref never 500s,
 *   - the global handler maps a Postgres 22P02 / "invalid input syntax for
 *     type uuid" throw to 400 invalid_identifier (not 500).
 * Framework-agnostic, InMemory, offline / install-free.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness, echoSpec } from "./helpers.ts";
import { createApp } from "../src/app.ts";

const ADMIN = { "x-actor-id": "admin", "x-roles": "platform_admin" };
const TENANT = { ...ADMIN, "x-tenant-id": "tenant-a" };

/** Create + publish + deploy a pipeline; returns its uuid and slug. */
async function seedDeployed(
  request: ReturnType<typeof buildHarness>["request"],
  slug: string
): Promise<{ id: string; slug: string }> {
  const created = await request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug, name: slug }
  });
  assert.equal(created.status, 201);
  const id = created.body.pipeline.id;
  const pub = await request({
    method: "POST",
    path: `/api/pipelines/${id}/versions`,
    headers: ADMIN,
    body: { version: "1.0.0", publish: true, spec: echoSpec() }
  });
  assert.equal(pub.status, 201);
  const dep = await request({
    method: "POST",
    path: `/api/pipelines/${id}/deployments`,
    headers: ADMIN,
    body: { version: "1.0.0", environment: "dev" }
  });
  assert.equal(dep.status, 201);
  return { id, slug };
}

test("run: SLUG resolves the same as the UUID (202, same pipelineId)", async () => {
  const { request } = buildHarness();
  const { id } = await seedDeployed(request, "support-rag");

  const byUuid = await request({
    method: "POST",
    path: `/api/pipelines/${id}/run`,
    headers: TENANT,
    body: { input: { q: "hi" }, environment: "dev" }
  });
  assert.equal(byUuid.status, 202);
  assert.equal(byUuid.body.pipelineId, id);

  // The exact bug repro: builder POSTs the slug, not the uuid.
  const bySlug = await request({
    method: "POST",
    path: "/api/pipelines/support-rag/run",
    headers: TENANT,
    body: { input: { q: "hi" }, environment: "dev" }
  });
  assert.equal(bySlug.status, 202);
  assert.equal(bySlug.body.status, "accepted");
  // Downstream lookups use the REAL uuid, never the slug.
  assert.equal(bySlug.body.pipelineId, id);
  assert.equal(bySlug.body.resolvedVia, "deployment");
});

test("save: SLUG resolves the same as the UUID and bumps the same lineage", async () => {
  const { request } = buildHarness();
  const created = await request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "save-by-slug", name: "Save By Slug" }
  });
  const id = created.body.pipeline.id;

  const v1 = await request({
    method: "POST",
    path: "/api/pipelines/save-by-slug/save",
    headers: ADMIN,
    body: { spec: echoSpec(), level: "minor" }
  });
  assert.equal(v1.status, 201);
  assert.equal(v1.body.created, true);

  // A follow-up save by UUID with identical spec is idempotent against the
  // SAME pipeline the slug save targeted.
  const v2 = await request({
    method: "POST",
    path: `/api/pipelines/${id}/save`,
    headers: ADMIN,
    body: { spec: echoSpec(), level: "minor" }
  });
  assert.equal(v2.status, 200);
  assert.equal(v2.body.created, false);
});

test("versions: list by SLUG matches list by UUID", async () => {
  const { request } = buildHarness();
  const { id } = await seedDeployed(request, "versions-by-slug");

  const byUuid = await request({
    method: "GET",
    path: `/api/pipelines/${id}/versions`,
    headers: ADMIN
  });
  const bySlug = await request({
    method: "GET",
    path: "/api/pipelines/versions-by-slug/versions",
    headers: ADMIN
  });
  assert.equal(byUuid.status, 200);
  assert.equal(bySlug.status, 200);
  assert.deepEqual(
    bySlug.body.versions.map((v: any) => v.version),
    byUuid.body.versions.map((v: any) => v.version)
  );
});

test("unknown id OR slug -> 404 pipeline_not_found (never 500)", async () => {
  const { request } = buildHarness();

  const bySlug = await request({
    method: "POST",
    path: "/api/pipelines/does-not-exist/run",
    headers: TENANT,
    body: { input: {} }
  });
  assert.equal(bySlug.status, 404);
  assert.equal(bySlug.body.error, "pipeline_not_found");
  assert.match(bySlug.body.message, /does-not-exist/);

  // A well-formed but unknown UUID also -> 404 pipeline_not_found.
  const byUuid = await request({
    method: "GET",
    path: "/api/pipelines/00000000-0000-0000-0000-000000000000/versions",
    headers: ADMIN
  });
  assert.equal(byUuid.status, 404);
  assert.equal(byUuid.body.error, "pipeline_not_found");

  const get = await request({
    method: "GET",
    path: "/api/pipelines/nope-nope",
    headers: ADMIN
  });
  assert.equal(get.status, 404);
  assert.equal(get.body.error, "pipeline_not_found");
});

test("resolvable pipeline with no deployment/activation -> 409 with message (not 500)", async () => {
  const { request } = buildHarness();
  await request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "no-deploy-slug", name: "NoDeploy" }
  });

  const run = await request({
    method: "POST",
    path: "/api/pipelines/no-deploy-slug/run",
    headers: TENANT,
    body: { input: {} }
  });
  assert.equal(run.status, 409);
  assert.equal(run.body.error, "no_active_deployment");
  assert.equal(typeof run.body.message, "string");
  assert.ok(run.body.message.length > 0);
});

test("malformed-uuid-ish ref never 500s (resolves as slug -> 404)", async () => {
  const { request } = buildHarness();
  for (const ref of [
    "support-rag",
    "12345",
    "not-a-uuid-but-has-dashes",
    "0000-0000",
    "../etc/passwd"
  ]) {
    const res = await request({
      method: "POST",
      path: `/api/pipelines/${encodeURIComponent(ref)}/run`,
      headers: TENANT,
      body: { input: {} }
    });
    assert.notEqual(res.status, 500, `ref ${ref} must not 500`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "pipeline_not_found");
  }
});

test("global handler maps a Postgres uuid-cast throw to 400 invalid_identifier (not 500)", async () => {
  // A repo whose `findBySlug` simulates Postgres SQLSTATE 22P02 (a slug
  // reaching a `uuid` column). Without the backstop this would be a 500.
  const { deps } = buildHarness();
  const pgError: any = new Error(
    'invalid input syntax for type uuid: "support-rag"'
  );
  pgError.code = "22P02";
  const throwingPipelines = {
    ...deps.pipelines,
    get: async () => undefined,
    findBySlug: async () => {
      throw pgError;
    }
  } as typeof deps.pipelines;

  const app = createApp({ ...deps, pipelines: throwingPipelines });
  const res = await app.handle({
    method: "GET",
    path: "/api/pipelines/support-rag",
    query: {},
    headers: ADMIN,
    body: undefined
  });
  const resBody = res.body as { error: string; message: string };
  assert.equal(res.status, 400);
  assert.equal(resBody.error, "invalid_identifier");
  assert.match(resBody.message, /invalid input syntax for type uuid/);
});
