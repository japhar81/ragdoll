/**
 * Phase 8 acceptance — synchronous pipeline execution.
 *
 * The /invoke endpoint runs the DAG in-process on the API pod and
 * returns the terminal output in the response. /stream wraps the same
 * execution in an SSE envelope. Both must enforce pipeline:run, validate
 * the spec, and respect Phase 5 dataset references (a node carrying
 * `dataset: { slug }` should resolve through the in-process
 * DatasetResolver exactly like the worker path).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness, echoSpec } from "./helpers.ts";

const ADMIN = {
  "x-actor-id": "admin",
  "x-roles": "platform_admin",
  "x-tenant-id": "tenant-a"
};

async function seedPipeline(
  h: ReturnType<typeof buildHarness>,
  slug: string
): Promise<{ id: string }> {
  const created = await h.request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug, name: slug }
  });
  await h.request({
    method: "POST",
    path: `/api/pipelines/${created.body.pipeline.id}/versions`,
    headers: ADMIN,
    body: { version: "1.0.0", publish: true, spec: echoSpec(slug) }
  });
  await h.request({
    method: "POST",
    path: `/api/pipelines/${created.body.pipeline.id}/deployments`,
    headers: ADMIN,
    body: { version: "1.0.0", environment: "dev" }
  });
  return { id: created.body.pipeline.id };
}

test("POST /invoke runs the pipeline in-process and returns the output", async () => {
  const h = buildHarness();
  const { id } = await seedPipeline(h, "sync-echo");
  const res = await h.request({
    method: "POST",
    path: `/api/pipelines/${id}/invoke`,
    headers: ADMIN,
    body: { input: { question: "hi" } }
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "succeeded");
  assert.equal(res.body.pipelineId, id);
  // Echo plugin returns `{ outputs: { echoed: input.inputs } }`; the DAG's
  // terminal output node forwards that to the executor's return value.
  assert.ok(res.body.output, "output payload returned");
  assert.ok(res.body.executionId, "executionId stamped");
});

test("POST /invoke requires pipeline:run RBAC", async () => {
  // withAuth: true disables the dev provider's "everyone is platform_admin"
  // default and turns on the real default-deny enforcement, so a request
  // with no Bearer / ApiKey is rejected.
  const h = buildHarness({ withAuth: true });
  const res = await h.request({
    method: "POST",
    path: `/api/pipelines/anything/invoke`,
    headers: { "x-tenant-id": "tenant-a" },
    body: { input: {} }
  });
  // No auth = 401. (We don't seed a pipeline here because the request
  // is rejected before pipeline resolution.)
  assert.equal(res.status, 401);
});

test("POST /invoke 409s when no deployment exists for the env", async () => {
  const h = buildHarness();
  const created = await h.request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "sync-undeployed", name: "Undeployed" }
  });
  await h.request({
    method: "POST",
    path: `/api/pipelines/${created.body.pipeline.id}/versions`,
    headers: ADMIN,
    body: { version: "1.0.0", publish: true, spec: echoSpec("undeployed") }
  });
  // No deployment for "dev" — /invoke must refuse cleanly, not crash.
  const res = await h.request({
    method: "POST",
    path: `/api/pipelines/${created.body.pipeline.id}/invoke`,
    headers: ADMIN,
    body: { input: {} }
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "no_active_deployment");
});

test("POST /stream emits execution lifecycle frames + output + done", async () => {
  const h = buildHarness();
  const { id } = await seedPipeline(h, "sync-stream");
  const res = await h.request({
    method: "POST",
    path: `/api/pipelines/${id}/stream`,
    headers: ADMIN,
    body: { input: {} }
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/event-stream");
  const body = String(res.body);
  // execution.* frames are emitted via the changeBus subscription; the
  // executor publishes execution.started + execution.completed at minimum.
  assert.ok(body.includes("event: execution.started"), `expected execution.started in: ${body}`);
  assert.ok(body.includes("event: execution.completed"), `expected execution.completed in: ${body}`);
  assert.ok(body.includes("event: output"), `expected output in: ${body}`);
  assert.ok(body.includes("event: done"), `expected done in: ${body}`);
});
