/**
 * RAGdoll cross-component end-to-end suite.
 *
 * Exercises a real API -> queue -> worker -> runtime -> stores flow with a
 * single set of shared in-memory dependencies (see ./harness.ts). Fully
 * offline / install-free: `node:test` + `node:assert/strict` +
 * `--experimental-strip-types`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildE2EHarness, llmSpec } from "./harness.ts";

const ADMIN = { "x-actor-id": "admin", "x-roles": "platform_admin" };

/* ========================================================================== */
/* 1. Query pipeline lifecycle: create -> draft -> publish (immutable) ->      */
/*    deploy -> resolved config (secret redacted) -> secret -> run -> worker   */
/*    drains -> execution succeeded + trace + usage.                          */
/* ========================================================================== */

test("e2e: pipeline lifecycle runs through the worker and records a succeeded execution", async () => {
  const h = buildE2EHarness();
  const tenantId = "tenant-a";

  // -- create tenant ------------------------------------------------------
  const tenant = await h.request({
    method: "POST",
    path: "/api/tenants",
    headers: ADMIN,
    body: { slug: tenantId, name: "Tenant A" }
  });
  assert.equal(tenant.status, 201);

  // -- create pipeline ----------------------------------------------------
  const created = await h.request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "e2e-llm", name: "E2E LLM" }
  });
  assert.equal(created.status, 201);
  const pipelineId = created.body.pipeline.id as string;

  // -- save a draft version (mutable; kept distinct from the published one
  //    so findByVersion resolves the published row at deploy time) --------
  const draft = await h.request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/versions`,
    headers: ADMIN,
    body: { version: "0.1.0", spec: llmSpec("e2e-llm-draft", tenantId) }
  });
  assert.equal(draft.status, 201);
  assert.equal(draft.body.version.status, "draft");

  // Re-saving the same draft version is mutable => 200.
  const draftAgain = await h.request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/versions`,
    headers: ADMIN,
    body: { version: "0.1.0", spec: llmSpec("e2e-llm-draft-2", tenantId) }
  });
  assert.equal(draftAgain.status, 200);

  // -- publish v1 ---------------------------------------------------------
  const publish = await h.request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/versions`,
    headers: ADMIN,
    body: { version: "1.0.0", publish: true, spec: llmSpec("e2e-llm", tenantId) }
  });
  assert.equal(publish.status, 201);
  assert.equal(publish.body.version.status, "published");
  const checksum = publish.body.version.checksum as string;

  // -- immutability: re-publishing a CHANGED spec under same version => 409
  const mutated = llmSpec("e2e-llm", tenantId);
  mutated.metadata.labels = { changed: "yes" };
  const immutable = await h.request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/versions`,
    headers: ADMIN,
    body: { version: "1.0.0", publish: true, spec: mutated }
  });
  assert.equal(immutable.status, 409);
  assert.equal(immutable.body.error, "immutable_version");

  // Identical re-publish is idempotent (same checksum), confirming the
  // 409 above was driven by content, not by version reuse.
  const republish = await h.request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/versions`,
    headers: ADMIN,
    body: { version: "1.0.0", publish: true, spec: llmSpec("e2e-llm", tenantId) }
  });
  assert.equal(republish.status, 200);
  assert.equal(republish.body.version.checksum, checksum);

  // -- deploy v1 to dev (pin version to env) ------------------------------
  const deploy = await h.request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/deployments`,
    headers: ADMIN,
    body: { version: "1.0.0", environment: "dev" }
  });
  assert.equal(deploy.status, 201);
  assert.equal(deploy.body.deployment.status, "active");

  // -- a SECRET config definition + value, then GET resolved => REDACTED ---
  await h.request({
    method: "PUT",
    path: "/api/config/definitions/llm.api_key",
    headers: ADMIN,
    body: {
      type: "string",
      secret: true,
      defaultValue: "unset",
      allowedScopes: ["global", "pipeline"]
    }
  });
  await h.request({
    method: "POST",
    path: "/api/config/values",
    headers: ADMIN,
    body: {
      key: "llm.api_key",
      value: "sk-not-to-be-leaked",
      scope: "pipeline",
      scopeId: pipelineId
    }
  });
  const resolved = await h.request({
    method: "GET",
    path: "/api/config/resolved",
    headers: ADMIN,
    query: { pipeline_id: pipelineId, tenant_id: tenantId, environment: "dev" }
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.values["llm.api_key"].value, "REDACTED");
  assert.equal(resolved.body.values["llm.api_key"].redacted, true);
  assert.equal(
    JSON.stringify(resolved.body).includes("sk-not-to-be-leaked"),
    false,
    "secret plaintext must never appear in resolved config"
  );

  // -- create the node secret the pipeline's llm node references ----------
  const secret = await h.request({
    method: "POST",
    path: "/api/secrets",
    headers: { ...ADMIN, "x-tenant-id": tenantId },
    body: { key: "fake.api_key", scope: "tenant", value: "sk-runtime-secret" }
  });
  assert.equal(secret.status, 201);
  assert.equal(secret.body.secret.value, "REDACTED");

  // -- POST /run => 202 accepted, job queued, execution seeded running ----
  const run = await h.request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/run`,
    headers: { ...ADMIN, "x-tenant-id": tenantId },
    body: { input: { question: "hello e2e" }, environment: "dev" }
  });
  assert.equal(run.status, 202);
  assert.equal(run.body.status, "accepted");
  const executionId = run.body.executionId as string;
  const jobId = run.body.jobId as string;
  assert.equal(await h.queue.status(jobId), "queued");

  // Before draining the execution is still "running".
  const pending = await h.request({
    method: "GET",
    path: `/api/executions/${executionId}`,
    headers: ADMIN
  });
  assert.equal(pending.body.execution.status, "running");

  // -- drain the SHARED queue => worker executes through DagExecutor ------
  const results = await h.drain();
  assert.equal(results.get(jobId)?.status, "completed");
  assert.equal(await h.queue.status(jobId), "completed");

  // -- assert via the API: execution recorded succeeded -------------------
  const execution = await h.request({
    method: "GET",
    path: `/api/executions/${executionId}`,
    headers: ADMIN
  });
  assert.equal(execution.status, 200);
  assert.equal(execution.body.execution.executionId, executionId);
  assert.equal(execution.body.execution.status, "succeeded");
  assert.equal(execution.body.execution.tenantId, tenantId);
  assert.equal(execution.body.execution.pipelineId, pipelineId);

  // -- the trace has node records ----------------------------------------
  const trace = await h.request({
    method: "GET",
    path: `/api/executions/${executionId}/trace`,
    headers: ADMIN
  });
  assert.equal(trace.status, 200);
  assert.equal(trace.body.executionId, executionId);
  assert.ok(trace.body.nodes.length >= 3, "input + llm + output node records");
  const llmNode = trace.body.nodes.find((n: any) => n.nodeId === "llm");
  assert.ok(llmNode, "llm node recorded in trace");
  assert.equal(llmNode.status, "succeeded");
  const outputNode = trace.body.nodes.find((n: any) => n.nodeId === "out");
  assert.equal(outputNode.status, "succeeded");

  // -- usage recorded by the runtime into the SHARED execution store ------
  //    (the DagExecutor writes usage via ExecutionStore.recordUsage; this is
  //    the store the API was wired with, so the assertion proves the run
  //    crossed API -> queue -> worker -> runtime -> store).
  const store = h.deps.executionStore as unknown as {
    nodes: Array<any>;
    usage: Array<any>;
  };
  const execUsage = store.usage.filter((u) => u.executionId === executionId);
  assert.equal(execUsage.length, 1, "exactly one usage row recorded");
  assert.equal(execUsage[0].tenantId, tenantId);
  assert.equal(execUsage[0].pipelineId, pipelineId);
  assert.equal(execUsage[0].provider, "fake");
  assert.equal(execUsage[0].model, "fake-1");
  assert.equal(execUsage[0].inputTokens, 7);
  assert.equal(execUsage[0].outputTokens, 11);
  assert.equal(execUsage[0].success, true);

  // The control-plane usage endpoint stays reachable (separate repository,
  // not populated by the offline runtime path) and returns a clean summary.
  const usage = await h.request({
    method: "GET",
    path: "/api/usage",
    headers: ADMIN,
    query: { tenant_id: tenantId, execution_id: executionId }
  });
  assert.equal(usage.status, 200);
  assert.ok(usage.body.summary, "usage summary endpoint responds");

  // -- the runtime resolved the node secret through the shared provider ---
  const llmRecord = store.nodes.find(
    (n) => n.executionId === executionId && n.nodeId === "llm"
  );
  assert.ok(llmRecord, "llm node record present in shared execution store");
  assert.equal(llmRecord.status, "succeeded");
  // The fake LLM only reports keyResolved:true when the tenant-scoped node
  // secret was decrypted via the shared secret provider during execution.
  assert.equal(
    (llmRecord.output as { keyResolved?: boolean }).keyResolved,
    true,
    "node secret resolved end-to-end through the shared secret provider"
  );

  // Audit trail captured the lifecycle across the boundary.
  const audit = await h.request({ method: "GET", path: "/api/audit", headers: ADMIN });
  const actions = audit.body.logs.map((l: any) => l.action);
  assert.ok(actions.includes("pipeline.create"));
  assert.ok(actions.includes("pipeline_version.publish"));
  assert.ok(actions.includes("pipeline.deploy"));
  assert.ok(actions.includes("secret.create"));
  assert.ok(actions.includes("pipeline.run"));
});

/* ========================================================================== */
/* 2. Ingestion flow: enqueue ingest_datasource (precomputed vectors), drain,  */
/*    assert vector store + vector_collections row; delete_tenant_vector_data  */
/*    removes ONLY that tenant's data.                                         */
/* ========================================================================== */

test("e2e: ingestion populates the shared vector store, then tenant-scoped delete purges only that tenant", async () => {
  const h = buildE2EHarness();
  const collection = "e2e_ingest_collection";

  // tenant-a precomputed-vectors ingestion enqueued directly onto the
  // shared queue (the documented offline ingestion path).
  await h.queue.enqueue({
    id: "job-ingest-a",
    type: "ingest_datasource",
    payload: {
      tenantId: "tenant-a",
      pipelineId: "pipe-ingest",
      environment: "dev",
      collection,
      documents: [
        { text: "alpha beta gamma", metadata: { source: "doc-a" } },
        { text: "delta epsilon zeta", metadata: { source: "doc-a" } }
      ],
      vectors: [
        [1, 0, 0],
        [0, 1, 0]
      ],
      embeddingProfile: {
        provider: "fake",
        model: "fake-embed",
        dimensions: 3,
        distanceMetric: "cosine"
      },
      chunkConfig: { chunkSize: 1000, overlap: 0 }
    }
  });

  // tenant-b ingests into the SAME collection (shared-collection isolation).
  await h.queue.enqueue({
    id: "job-ingest-b",
    type: "ingest_datasource",
    payload: {
      tenantId: "tenant-b",
      pipelineId: "pipe-ingest",
      environment: "dev",
      collection,
      documents: [{ text: "tenant b doc", metadata: { source: "doc-b" } }],
      vectors: [[0, 0, 1]],
      embeddingProfile: {
        provider: "fake",
        model: "fake-embed",
        dimensions: 3,
        distanceMetric: "cosine"
      },
      chunkConfig: { chunkSize: 1000, overlap: 0 }
    }
  });

  const results = await h.drain();
  assert.equal(results.get("job-ingest-a")?.status, "completed");
  assert.equal(results.get("job-ingest-b")?.status, "completed");

  // The in-memory vector store has tenant-a's points.
  const aHits = await h.vectorStore.query(collection, {
    vector: [1, 0, 0],
    topK: 10,
    tenantId: "tenant-a"
  });
  assert.equal(aHits.length, 2);
  assert.equal(aHits[0].payload?.text, "alpha beta gamma");

  const bHits = await h.vectorStore.query(collection, {
    vector: [0, 0, 1],
    topK: 10,
    tenantId: "tenant-b"
  });
  assert.equal(bHits.length, 1);

  // vector_collections rows recorded (idempotent on collection name => 1 row).
  const collections = await h.deps.vectorCollections.list();
  const row = collections.find((c) => c.collectionName === collection);
  assert.ok(row, "vector_collections row exists");
  assert.equal(row!.tenantId, "tenant-a");

  // delete_tenant_vector_data removes ONLY tenant-a's data.
  await h.queue.enqueue({
    id: "job-del-a",
    type: "delete_tenant_vector_data",
    payload: { tenantId: "tenant-a" }
  });
  const delResults = await h.drain();
  const del = delResults.get("job-del-a");
  assert.equal(del?.status, "completed");
  assert.deepEqual((del?.result as { collections: string[] }).collections, [
    collection
  ]);

  const aAfter = await h.vectorStore.query(collection, {
    vector: [1, 0, 0],
    topK: 10,
    tenantId: "tenant-a"
  });
  assert.equal(aAfter.length, 0, "tenant-a vectors purged");

  const bAfter = await h.vectorStore.query(collection, {
    vector: [0, 0, 1],
    topK: 10,
    tenantId: "tenant-b"
  });
  assert.equal(bAfter.length, 1, "tenant-b vectors intact");
});

/* ========================================================================== */
/* 3. AuthZ / tenant isolation across the API boundary.                        */
/* ========================================================================== */

test("e2e: tenant A principal is denied tenant-B-scoped actions across the boundary", async () => {
  const h = buildE2EHarness();

  const aAdmin = {
    "x-actor-id": "a-admin",
    "x-roles": "tenant_admin",
    "x-tenant-id": "tenant-a"
  };

  // (a) A tenant_admin of tenant-a cannot write a tenant-B-scoped config
  //     value (config:edit_tenant is tenant-scoped) => 403.
  const crossTenantConfig = await h.request({
    method: "POST",
    path: "/api/config/values",
    headers: aAdmin,
    body: { key: "k", value: "v", scope: "tenant", scopeId: "tenant-b" }
  });
  assert.equal(crossTenantConfig.status, 403);
  assert.equal(crossTenantConfig.body.error, "forbidden");

  // (b) A tenant_admin of tenant-a cannot read tenant-B resolved config.
  const crossTenantResolved = await h.request({
    method: "GET",
    path: "/api/config/resolved",
    headers: aAdmin,
    query: { pipeline_id: "p", tenant_id: "tenant-b", environment: "dev" }
  });
  assert.equal(crossTenantResolved.status, 403);

  // (c) Seed a tenant-B execution; tenant-a operator cannot read it.
  await h.deps.executionStore.start({
    executionId: "exec-b",
    tenantId: "tenant-b",
    pipelineId: "p",
    pipelineVersionId: "v",
    environment: "test",
    status: "succeeded",
    startedAt: new Date().toISOString()
  });
  const aOperator = {
    "x-actor-id": "a-op",
    "x-roles": "tenant_operator",
    "x-tenant-id": "tenant-a"
  };
  const execB = await h.request({
    method: "GET",
    path: "/api/executions/exec-b",
    headers: aOperator
  });
  assert.equal(execB.status, 403);
  assert.equal(execB.body.error, "forbidden");

  const traceB = await h.request({
    method: "GET",
    path: "/api/executions/exec-b/trace",
    headers: aOperator
  });
  assert.equal(traceB.status, 403);

  // (d) tenant-b creates a secret; tenant-a admin cannot read the value, and
  //     the secret list never leaks plaintext across the boundary.
  const bAdmin = {
    "x-actor-id": "b-admin",
    "x-roles": "tenant_admin",
    "x-tenant-id": "tenant-b"
  };
  const bSecret = await h.request({
    method: "POST",
    path: "/api/secrets",
    headers: bAdmin,
    body: { key: "b.secret", scope: "tenant", value: "sk-tenant-b-only" }
  });
  assert.equal(bSecret.status, 201);
  assert.equal(bSecret.body.secret.value, "REDACTED");

  // tenant-a lists secrets scoped to tenant-a: must not see tenant-b's.
  const aList = await h.request({
    method: "GET",
    path: "/api/secrets",
    headers: aAdmin
  });
  assert.equal(aList.status, 200);
  assert.equal(
    aList.body.secrets.some((s: any) => s.ref?.tenantId === "tenant-b"),
    false,
    "tenant-a must not see tenant-b secrets"
  );
  assert.equal(
    JSON.stringify(aList.body).includes("sk-tenant-b-only"),
    false,
    "tenant-b secret plaintext must never cross the boundary"
  );
});

/* ========================================================================== */
/* 4. Negative path: running a pipeline with no active deployment.             */
/* ========================================================================== */

test("e2e: running a pipeline with no active deployment returns 409 no_active_deployment", async () => {
  const h = buildE2EHarness();

  const created = await h.request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "no-deploy", name: "No Deploy" }
  });
  assert.equal(created.status, 201);
  const pipelineId = created.body.pipeline.id as string;

  // Even with a published version, there is no deployment => the run is
  // rejected before anything is enqueued.
  await h.request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/versions`,
    headers: ADMIN,
    body: { version: "1.0.0", publish: true, spec: llmSpec("nd", "tenant-a") }
  });

  const run = await h.request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/run`,
    headers: { ...ADMIN, "x-tenant-id": "tenant-a" },
    body: { input: {}, environment: "dev" }
  });
  assert.equal(run.status, 409);
  assert.equal(run.body.error, "no_active_deployment");
  assert.ok(
    String(run.body.message).includes("no active deployment"),
    "documented error message"
  );

  // Nothing was enqueued and no execution was seeded.
  assert.equal(h.queue.list().length, 0);
  assert.equal(
    (h.deps.executionStore as { executions: unknown[] }).executions.length,
    0
  );
});
