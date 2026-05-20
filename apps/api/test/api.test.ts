import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness, echoSpec } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

test("healthz and readyz are public", async () => {
  const { request } = buildHarness();
  const health = await request({ method: "GET", path: "/healthz" });
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  const ready = await request({ method: "GET", path: "/readyz" });
  assert.equal(ready.status, 200);
});

// ---------------------------------------------------------------------------
// Auth precedence + RBAC
// ---------------------------------------------------------------------------

test("invalid bearer token -> 401", async () => {
  const { request } = buildHarness();
  const res = await request({
    method: "GET",
    path: "/api/pipelines",
    headers: { authorization: "Bearer not-a-real-token" }
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "unauthorized");
});

test("API key header takes precedence over dev fallback and is verified", async () => {
  const { request } = buildHarness();
  // A malformed API key must be rejected even though a dev provider exists:
  // the resolver short-circuits on x-api-key.
  const res = await request({
    method: "GET",
    path: "/api/pipelines",
    headers: { "x-api-key": "rgd_bad_key" }
  });
  assert.equal(res.status, 401);
});

test("RBAC denial: viewer cannot create a pipeline (403)", async () => {
  const { request } = buildHarness();
  const res = await request({
    method: "POST",
    path: "/api/pipelines",
    headers: { "x-actor-id": "u1", "x-roles": "viewer" },
    body: { slug: "p1", name: "P1" }
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "forbidden");
});

test("dev fallback rejected in production", async () => {
  const { request } = buildHarness({ env: "production" });
  const res = await request({ method: "GET", path: "/api/pipelines" });
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// Pipeline lifecycle: create -> draft -> publish (immutability) -> deploy ->
// resolved config -> run (enqueued) -> execution + trace
// ---------------------------------------------------------------------------

test("full pipeline lifecycle with immutability + enqueued run", async () => {
  const { request, queue, deps } = buildHarness();
  const admin = { "x-actor-id": "admin", "x-roles": "platform_admin" };

  // Create pipeline.
  const created = await request({
    method: "POST",
    path: "/api/pipelines",
    headers: admin,
    body: { slug: "echo", name: "Echo" }
  });
  assert.equal(created.status, 201);
  const pipelineId = created.body.pipeline.id;

  // Publish v1.
  const publish = await request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/versions`,
    headers: admin,
    body: { version: "1.0.0", publish: true, spec: echoSpec() }
  });
  assert.equal(publish.status, 201);
  assert.equal(publish.body.version.status, "published");
  const checksum = publish.body.version.checksum;

  // Republish identical content -> idempotent 200, same checksum.
  const republish = await request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/versions`,
    headers: admin,
    body: { version: "1.0.0", publish: true, spec: echoSpec() }
  });
  assert.equal(republish.status, 200);
  assert.equal(republish.body.version.checksum, checksum);

  // Republish DIFFERENT content under the same version -> immutable 409.
  const mutated = echoSpec();
  mutated.metadata.labels = { changed: "yes" };
  const immutable = await request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/versions`,
    headers: admin,
    body: { version: "1.0.0", publish: true, spec: mutated }
  });
  assert.equal(immutable.status, 409);
  assert.equal(immutable.body.error, "immutable_version");

  // List versions.
  const versions = await request({
    method: "GET",
    path: `/api/pipelines/${pipelineId}/versions`,
    headers: admin
  });
  assert.equal(versions.status, 200);
  assert.equal(versions.body.versions.length, 1);

  // Deploy v1 to dev.
  const deploy = await request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/deployments`,
    headers: admin,
    body: { version: "1.0.0", environment: "dev" }
  });
  assert.equal(deploy.status, 201);
  assert.equal(deploy.body.deployment.status, "active");

  // Seed a config definition + value, then resolve.
  await request({
    method: "PUT",
    path: "/api/config/definitions/retrieval.top_k",
    headers: admin,
    body: {
      type: "integer",
      defaultValue: 5,
      allowedScopes: ["global", "pipeline"]
    }
  });
  await request({
    method: "POST",
    path: "/api/config/values",
    headers: admin,
    body: { key: "retrieval.top_k", value: 9, scope: "pipeline", scopeId: pipelineId }
  });
  const resolved = await request({
    method: "GET",
    path: "/api/config/resolved",
    headers: admin,
    query: { pipeline_id: pipelineId, tenant_id: "tenant-a", environment: "dev" }
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.values["retrieval.top_k"].value, 9);

  // Run -> 202, enqueued, execution seeded.
  const run = await request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/run`,
    headers: { ...admin, "x-tenant-id": "tenant-a" },
    body: { input: { question: "hi" }, environment: "dev" }
  });
  assert.equal(run.status, 202);
  assert.equal(run.body.status, "accepted");
  const executionId = run.body.executionId;
  assert.equal(await queue.status(run.body.jobId), "queued");

  // Execution + trace are visible.
  const execution = await request({
    method: "GET",
    path: `/api/executions/${executionId}`,
    headers: admin
  });
  assert.equal(execution.status, 200);
  assert.equal(execution.body.execution.executionId, executionId);

  const trace = await request({
    method: "GET",
    path: `/api/executions/${executionId}/trace`,
    headers: admin
  });
  assert.equal(trace.status, 200);
  assert.equal(trace.body.executionId, executionId);

  // Audit log was written for create/publish/deploy/run.
  const audit = await request({ method: "GET", path: "/api/audit", headers: admin });
  assert.equal(audit.status, 200);
  const actions = audit.body.logs.map((l: any) => l.action);
  assert.ok(actions.includes("pipeline.create"));
  assert.ok(actions.includes("pipeline_version.publish"));
  assert.ok(actions.includes("pipeline.deploy"));
  assert.ok(actions.includes("pipeline.run"));

  // The InMemory audit repo also recorded these directly.
  const logs = await deps.auditLogs.list({});
  assert.ok(logs.some((l) => l.action === "pipeline.run"));
});

test("run with no active deployment -> 409", async () => {
  const { request } = buildHarness();
  const admin = { "x-actor-id": "admin", "x-roles": "platform_admin" };
  const created = await request({
    method: "POST",
    path: "/api/pipelines",
    headers: admin,
    body: { slug: "nodeploy", name: "NoDeploy" }
  });
  const run = await request({
    method: "POST",
    path: `/api/pipelines/${created.body.pipeline.id}/run`,
    headers: { ...admin, "x-tenant-id": "tenant-a" },
    body: { input: {} }
  });
  assert.equal(run.status, 409);
  assert.equal(run.body.error, "no_active_deployment");
});

// Regression: deploying a new version to a pipeline that already has an
// active deployment for the same (pipeline, environment, tenant) triple
// used to 409 with a unique-constraint duplicate-key error. The handler
// now upserts: redeploy swaps the active version in place.
test("redeploying to the same env/tenant swaps the active version in place", async () => {
  const { request, deps } = buildHarness();
  const admin = { "x-actor-id": "admin", "x-roles": "platform_admin" };

  // Create the pipeline.
  const created = await request({
    method: "POST",
    path: "/api/pipelines",
    headers: admin,
    body: { slug: "redeploy", name: "Redeploy" }
  });
  assert.equal(created.status, 201);
  const pipelineId = created.body.pipeline.id;

  // Publish v1 and v2.
  for (const version of ["1.0.0", "2.0.0"]) {
    const res = await request({
      method: "POST",
      path: `/api/pipelines/${pipelineId}/versions`,
      headers: admin,
      body: { version, publish: true, spec: echoSpec() }
    });
    assert.equal(res.status, 201, `publish ${version}`);
  }

  // Deploy v1 — first deploy, creates the row.
  const deployV1 = await request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/deployments`,
    headers: admin,
    body: { version: "1.0.0", environment: "dev" }
  });
  assert.equal(deployV1.status, 201);
  const v1Id = deployV1.body.deployment.id;
  assert.equal(deployV1.body.deployment.status, "active");

  // Deploy v2 to the SAME env/tenant — must NOT 409, must update in place.
  const deployV2 = await request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/deployments`,
    headers: admin,
    body: { version: "2.0.0", environment: "dev" }
  });
  assert.equal(deployV2.status, 201);

  // Same row id (upsert in place), pointing at the new version.
  assert.equal(deployV2.body.deployment.id, v1Id);
  assert.notEqual(
    deployV2.body.deployment.pipelineVersionId,
    deployV1.body.deployment.pipelineVersionId
  );

  // Only one deployment row exists for this (pipeline, env, tenant).
  const all = await deps.deployments.listByPipeline(pipelineId);
  assert.equal(all.length, 1);
  assert.equal(all[0].pipelineVersionId, deployV2.body.deployment.pipelineVersionId);

  // Both deploys produced audit entries.
  const audit = await request({ method: "GET", path: "/api/audit", headers: admin });
  const deployActions = audit.body.logs.filter(
    (l: { action: string }) => l.action === "pipeline.deploy"
  );
  assert.equal(deployActions.length, 2);
});

test("draft save is mutable; publishing then drafting same version is blocked", async () => {
  const { request } = buildHarness();
  const admin = { "x-actor-id": "admin", "x-roles": "platform_admin" };
  const created = await request({
    method: "POST",
    path: "/api/pipelines",
    headers: admin,
    body: { slug: "drafts", name: "Drafts" }
  });
  const pid = created.body.pipeline.id;

  const draft1 = await request({
    method: "POST",
    path: `/api/pipelines/${pid}/versions`,
    headers: admin,
    body: { version: "2.0.0", spec: echoSpec() }
  });
  assert.equal(draft1.status, 201);
  assert.equal(draft1.body.version.status, "draft");

  // Re-save draft (mutable) -> 200.
  const draft2 = await request({
    method: "POST",
    path: `/api/pipelines/${pid}/versions`,
    headers: admin,
    body: { version: "2.0.0", spec: echoSpec("echo-pipeline-2") }
  });
  assert.equal(draft2.status, 200);

  // Publish 3.0.0 then try to draft over it -> 409.
  await request({
    method: "POST",
    path: `/api/pipelines/${pid}/versions`,
    headers: admin,
    body: { version: "3.0.0", publish: true, spec: echoSpec() }
  });
  const blocked = await request({
    method: "POST",
    path: `/api/pipelines/${pid}/versions`,
    headers: admin,
    body: { version: "3.0.0", spec: echoSpec() }
  });
  assert.equal(blocked.status, 409);
});

// ---------------------------------------------------------------------------
// Secrets: create/list redaction, never plaintext
// ---------------------------------------------------------------------------

test("secret create + list never returns plaintext", async () => {
  const { request } = buildHarness();
  const admin = { "x-actor-id": "admin", "x-roles": "platform_admin", "x-tenant-id": "tenant-a" };

  const create = await request({
    method: "POST",
    path: "/api/secrets",
    headers: admin,
    body: { key: "openai.api_key", scope: "tenant", value: "sk-supersecret-plaintext" }
  });
  assert.equal(create.status, 201);
  assert.equal(create.body.secret.value, "REDACTED");
  assert.equal(
    JSON.stringify(create.body).includes("sk-supersecret-plaintext"),
    false
  );

  const list = await request({ method: "GET", path: "/api/secrets", headers: admin });
  assert.equal(list.status, 200);
  assert.ok(list.body.secrets.length >= 1);
  for (const s of list.body.secrets) assert.equal(s.value, "REDACTED");
  assert.equal(JSON.stringify(list.body).includes("supersecret"), false);

  // Rotate.
  const rotate = await request({
    method: "PUT",
    path: `/api/secrets/${create.body.secret.id}`,
    headers: admin,
    body: { key: "openai.api_key", scope: "tenant", value: "sk-rotated" }
  });
  assert.equal(rotate.status, 200);
  assert.equal(rotate.body.secret.value, "REDACTED");
  assert.notEqual(rotate.body.secret.version, create.body.secret.version);
});

test("secret management requires permission", async () => {
  const { request } = buildHarness();
  const res = await request({
    method: "POST",
    path: "/api/secrets",
    headers: { "x-actor-id": "v", "x-roles": "viewer", "x-tenant-id": "tenant-a" },
    body: { key: "k", scope: "tenant", value: "v" }
  });
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

test("tenant isolation: tenant_admin of A cannot read resolved config for B", async () => {
  const { request } = buildHarness();
  const aAdmin = {
    "x-actor-id": "a-admin",
    "x-roles": "tenant_admin",
    "x-tenant-id": "tenant-a"
  };
  const res = await request({
    method: "GET",
    path: "/api/config/resolved",
    headers: aAdmin,
    query: { pipeline_id: "p", tenant_id: "tenant-b", environment: "dev" }
  });
  assert.equal(res.status, 403);
});

test("tenant isolation: execution scoped to another tenant is forbidden", async () => {
  const { request, deps } = buildHarness();
  await deps.executionStore.start({
    executionId: "exec-b",
    tenantId: "tenant-b",
    pipelineId: "p",
    pipelineVersionId: "v",
    status: "succeeded",
    startedAt: new Date().toISOString()
  });
  const aOperator = {
    "x-actor-id": "a-op",
    "x-roles": "tenant_operator",
    "x-tenant-id": "tenant-a"
  };
  const res = await request({
    method: "GET",
    path: "/api/executions/exec-b",
    headers: aOperator
  });
  assert.equal(res.status, 403);
});

test("tenant isolation: audit list scoped to caller tenant", async () => {
  const { request } = buildHarness();
  // tenant-a admin creates a secret (audited under tenant-a).
  await request({
    method: "POST",
    path: "/api/secrets",
    headers: {
      "x-actor-id": "a",
      "x-roles": "tenant_admin",
      "x-tenant-id": "tenant-a"
    },
    body: { key: "k", scope: "tenant", value: "v" }
  });
  // tenant-b admin lists audit -> must not see tenant-a entries.
  const res = await request({
    method: "GET",
    path: "/api/audit",
    headers: {
      "x-actor-id": "b",
      "x-roles": "auditor",
      "x-tenant-id": "tenant-b"
    }
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.logs.length, 0);
});

// ---------------------------------------------------------------------------
// 404 / plugins / providers
// ---------------------------------------------------------------------------

test("unknown route -> 404 not_found", async () => {
  const { request } = buildHarness();
  const res = await request({
    method: "GET",
    path: "/api/does-not-exist",
    headers: { "x-actor-id": "a", "x-roles": "platform_admin" }
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "not_found");
});

test("plugins + providers come from the loaded registries", async () => {
  const { request } = buildHarness();
  const admin = { "x-actor-id": "a", "x-roles": "platform_admin" };
  const plugins = await request({ method: "GET", path: "/api/plugins", headers: admin });
  assert.equal(plugins.status, 200);
  assert.ok(plugins.body.plugins.some((p: any) => p.id === "fake_echo"));

  const providers = await request({ method: "GET", path: "/api/providers", headers: admin });
  assert.equal(providers.status, 200);
  assert.ok(providers.body.providers.some((p: any) => p.id === "fake"));

  const models = await request({
    method: "GET",
    path: "/api/providers/fake/models",
    headers: admin
  });
  assert.equal(models.status, 200);
  assert.equal(models.body.models[0].id, "fake-1");

  const missing = await request({
    method: "GET",
    path: "/api/providers/nope/models",
    headers: admin
  });
  assert.equal(missing.status, 404);
});

test("GET /api/plugins exposes configSchema + ui; per-plugin route returns a manifest", async () => {
  const { request } = buildHarness();
  const admin = { "x-actor-id": "a", "x-roles": "platform_admin" };

  const list = await request({ method: "GET", path: "/api/plugins", headers: admin });
  assert.equal(list.status, 200);
  const echo = list.body.plugins.find((p: any) => p.id === "fake_echo");
  assert.ok(echo, "fake_echo present in list");
  assert.equal(echo.configSchema?.type, "object");
  assert.ok(echo.configSchema?.properties?.label, "configSchema projected");
  assert.equal(echo.ui?.icon, "repeat");
  assert.ok(echo.ui?.formHints?.label, "ui.formHints projected");
  assert.deepEqual(echo.capabilities, ["query"]);

  const one = await request({
    method: "GET",
    path: "/api/plugins/transformer/fake_echo/1.0.0",
    headers: admin
  });
  assert.equal(one.status, 200);
  assert.equal(one.body.plugin.id, "fake_echo");
  assert.equal(one.body.plugin.configSchema?.properties?.label?.default, "echo");
  assert.equal(one.body.plugin.ui?.paletteGroup, "Test");

  const unknown = await request({
    method: "GET",
    path: "/api/plugins/transformer/does_not_exist/9.9.9",
    headers: admin
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, "not_found");
});

test("ingest enqueues a job and stream reports not_enabled honestly", async () => {
  const { request, queue } = buildHarness();
  const admin = { "x-actor-id": "a", "x-roles": "platform_admin", "x-tenant-id": "tenant-a" };
  const created = await request({
    method: "POST",
    path: "/api/pipelines",
    headers: admin,
    body: { slug: "ingest-p", name: "Ingest" }
  });
  const pid = created.body.pipeline.id;
  await request({
    method: "POST",
    path: `/api/pipelines/${pid}/versions`,
    headers: admin,
    body: { version: "1.0.0", publish: true, spec: echoSpec() }
  });
  await request({
    method: "POST",
    path: `/api/pipelines/${pid}/deployments`,
    headers: admin,
    body: { version: "1.0.0", environment: "dev" }
  });

  const ingest = await request({
    method: "POST",
    path: `/api/pipelines/${pid}/ingest`,
    headers: admin,
    body: { datasource: { type: "manual", documents: ["a"] } }
  });
  assert.equal(ingest.status, 202);
  assert.equal(await queue.status(ingest.body.jobId), "queued");

  const stream = await request({
    method: "POST",
    path: `/api/pipelines/${pid}/stream`,
    headers: admin,
    body: {}
  });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers["content-type"], "text/event-stream");
  assert.ok(String(stream.body).includes("not_enabled"));
});

test("usage summary aggregates records for the tenant", async () => {
  const { request, deps } = buildHarness();
  await deps.usageRecords.append({
    tenantId: "tenant-a",
    pipelineId: "p",
    executionId: "e1",
    inputTokens: 10,
    outputTokens: 20,
    embeddingTokens: 0,
    estimatedCostUsd: 0.5,
    success: true
  });
  const res = await request({
    method: "GET",
    path: "/api/usage",
    headers: { "x-actor-id": "a", "x-roles": "tenant_operator", "x-tenant-id": "tenant-a" }
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.summary.inputTokens, 10);
  assert.equal(res.body.summary.outputTokens, 20);
  assert.equal(res.body.summary.count, 1);
});
