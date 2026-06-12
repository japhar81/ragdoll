/**
 * Regression tests for the bulwark-reported save/deploy lifecycle gaps:
 *
 *  (a) POST /api/pipelines/:id/save now surfaces the new semver at the
 *      top of the response as `versionLabel`, so callers don't have to
 *      reach into the nested row (response.version.version) — the
 *      awkward double-`version` field tripped a class of "deploy what
 *      I just published" provisioning scripts.
 *
 *      POST /api/pipelines/:id/save-and-deploy is the atomic shortcut:
 *      one round-trip that saves a published version AND activates it
 *      for the given (environment, tenantId). Eliminates the
 *      no_active_deployment 409 a clean instance could land in when
 *      provisioning forgot the second hop.
 *
 *  (b) DELETE /api/pipelines/:id/deployments/:envOrId removes a
 *      deployment by environment name or by row UUID. Same DELETE on a
 *      removed environment row cascades through and drops every
 *      deployment that pointed at it (was orphan-ed before).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness, echoSpec } from "./helpers.ts";

const ADMIN = { "x-actor-id": "admin", "x-roles": "platform_admin" };

// ---------------------------------------------------------------------------
// (a) save returns versionLabel
// ---------------------------------------------------------------------------

test("POST /api/pipelines/:id/save returns `versionLabel` at the top of the response (no more response.version.version)", async () => {
  const harness = buildHarness();
  const created = await harness.request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "save-lifecycle", name: "save-lifecycle" }
  });
  assert.equal(created.status, 201);
  const id = created.body.pipeline.id;

  const save = await harness.request({
    method: "POST",
    path: `/api/pipelines/${id}/save`,
    headers: ADMIN,
    body: { spec: echoSpec() }
  });
  assert.equal(save.status, 201);
  assert.equal(typeof save.body.versionLabel, "string");
  assert.equal(save.body.versionLabel, save.body.version.version);
  assert.equal(save.body.created, true);

  // Idempotent save (same spec) — still surfaces versionLabel.
  const again = await harness.request({
    method: "POST",
    path: `/api/pipelines/${id}/save`,
    headers: ADMIN,
    body: { spec: echoSpec() }
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.versionLabel, save.body.versionLabel);
  assert.equal(again.body.created, false);
});

// ---------------------------------------------------------------------------
// (a) save-and-deploy one-shot
// ---------------------------------------------------------------------------

test("POST /api/pipelines/:id/save-and-deploy saves AND activates in a single call", async () => {
  const harness = buildHarness();
  const pipe = await harness.request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "snd-pipe", name: "snd-pipe" }
  });
  assert.equal(pipe.status, 201);
  const id = pipe.body.pipeline.id;

  const out = await harness.request({
    method: "POST",
    path: `/api/pipelines/${id}/save-and-deploy`,
    headers: ADMIN,
    body: { spec: echoSpec(), environment: "dev" }
  });
  assert.equal(out.status, 201);
  assert.equal(typeof out.body.versionLabel, "string");
  assert.ok(out.body.deployment, "expected a deployment row in the envelope");
  assert.equal(out.body.deployment.environment, "dev");
  assert.equal(out.body.deployment.pipelineVersionId, out.body.version.id);
  assert.equal(out.body.deployment.status, "active");
});

test("POST /api/pipelines/:id/save-and-deploy refuses without environment", async () => {
  const harness = buildHarness();
  const pipe = await harness.request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "snd-no-env", name: "snd-no-env" }
  });
  const out = await harness.request({
    method: "POST",
    path: `/api/pipelines/${pipe.body.pipeline.id}/save-and-deploy`,
    headers: ADMIN,
    body: { spec: echoSpec() }
  });
  assert.equal(out.status, 422);
  assert.match(JSON.stringify(out.body), /environment/);
});

// ---------------------------------------------------------------------------
// (b) DELETE deployment by env / by id
// ---------------------------------------------------------------------------

async function deployedPipeline(
  harness: ReturnType<typeof buildHarness>,
  slug: string,
  environment = "dev",
  tenantId?: string
): Promise<{ id: string; deploymentId: string }> {
  const pipe = await harness.request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug, name: slug }
  });
  const out = await harness.request({
    method: "POST",
    path: `/api/pipelines/${pipe.body.pipeline.id}/save-and-deploy`,
    headers: ADMIN,
    body: { spec: echoSpec(), environment, tenantId }
  });
  return { id: pipe.body.pipeline.id, deploymentId: out.body.deployment.id };
}

test("DELETE /api/pipelines/:id/deployments/<env> drops every matching deployment", async () => {
  const harness = buildHarness();
  const { id } = await deployedPipeline(harness, "del-by-env");
  const del = await harness.request({
    method: "DELETE",
    path: `/api/pipelines/${id}/deployments/dev`,
    headers: ADMIN
  });
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, 1);
  const after = await harness.request({
    method: "GET",
    path: `/api/pipelines/${id}/deployments`,
    headers: ADMIN
  });
  assert.equal((after.body.deployments as unknown[]).length, 0);
});

test("DELETE /api/pipelines/:id/deployments/<uuid> drops that single row", async () => {
  const harness = buildHarness();
  const { id, deploymentId } = await deployedPipeline(harness, "del-by-id");
  const del = await harness.request({
    method: "DELETE",
    path: `/api/pipelines/${id}/deployments/${deploymentId}`,
    headers: ADMIN
  });
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, 1);
  assert.equal(del.body.deployment?.id, deploymentId);
});

test("DELETE /api/pipelines/:id/deployments/<env> on no-match returns 404 (typo-safe)", async () => {
  const harness = buildHarness();
  const { id } = await deployedPipeline(harness, "del-typo");
  const del = await harness.request({
    method: "DELETE",
    path: `/api/pipelines/${id}/deployments/staging`,
    headers: ADMIN
  });
  assert.equal(del.status, 404);
});

// ---------------------------------------------------------------------------
// (b) environment delete cascades pipeline_deployments
// ---------------------------------------------------------------------------

test("DELETE /api/tenants/:id/environments/:envId also drops every deployment referencing that env (no orphan rows)", async () => {
  const harness = buildHarness();
  const TENANT = "11111111-1111-1111-1111-111111111111";
  await harness.request({
    method: "POST",
    path: "/api/tenants",
    headers: ADMIN,
    body: { id: TENANT, slug: "env-cascade", name: "Env Cascade" }
  });
  // Per-tenant env "edge" — the env-cascade target.
  const envRes = await harness.request({
    method: "POST",
    path: `/api/tenants/${TENANT}/environments`,
    headers: ADMIN,
    body: { name: "edge" }
  });
  assert.equal(envRes.status, 201);
  const envId = envRes.body.environment.id;
  // Two pipelines deployed into "edge" (per-tenant deployments).
  const a = await deployedPipeline(harness, "ec-a", "edge", TENANT);
  const b = await deployedPipeline(harness, "ec-b", "edge", TENANT);

  const del = await harness.request({
    method: "DELETE",
    path: `/api/tenants/${TENANT}/environments/${envId}`,
    headers: ADMIN
  });
  assert.equal(del.status, 204);

  // Both pipeline deployment lists should be empty for "edge".
  for (const p of [a, b]) {
    const after = await harness.request({
      method: "GET",
      path: `/api/pipelines/${p.id}/deployments`,
      headers: ADMIN
    });
    const inEdge = (after.body.deployments as Array<{ environment: string }>).filter(
      (d) => d.environment === "edge"
    );
    assert.equal(
      inEdge.length,
      0,
      `pipeline ${p.id} still has edge deployments after env was deleted`
    );
  }
});
