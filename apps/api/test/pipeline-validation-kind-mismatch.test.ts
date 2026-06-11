/**
 * Regression for bulwark blocker #5: server-side `/validate` must
 * catch a binding-driver mismatch the SAME way the Builder does.
 *
 * Before this fix the route called `validatePipelineSpec(spec, registry)`
 * with no `datasetIndex`, so the rule that compares a plugin's
 * `requires: [{binding, kindOneOf}]` against the dataset's bound
 * connection kind was always skipped. Bulwark would wire a neo4j-
 * needing node to a postgres connection, the API validated clean,
 * then the run failed at execute. The route now builds the index from
 * the caller's tenant-visible datasets + connections so the mismatch
 * surfaces at validate time.
 *
 * This test also locks in the fix for a parallel Builder bug — using
 * the connection SLUG as the kind. Server-side avoids that by
 * resolving slug → kind via the unified registry; verified by the
 * "wrong-kind" case below (mismatch fires) and the "matching-kind
 * with a non-matching SLUG" case (no mismatch when the underlying
 * kind agrees, despite the slug not looking like the kind).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness } from "./helpers.ts";
import type { PipelineSpec } from "../../../packages/core/src/index.ts";

const ADMIN = { "x-actor-id": "admin", "x-roles": "platform_admin" };
const TENANT = "11111111-1111-1111-1111-111111111111";
const TENANT_HEADERS = { ...ADMIN, "x-tenant-id": TENANT };

/**
 * fake_neo4j_consumer: a contract-v2 plugin that REQUIRES its `target`
 * binding to be backed by a connection of kind "neo4j". Registered
 * on the harness's pluginRegistry directly so this test doesn't
 * depend on any builtin neo4j plugin actually existing in the test
 * harness.
 */
function registerFakeNeo4jConsumer(harness: ReturnType<typeof buildHarness>): void {
  // Cast through unknown — PluginManifest.requires is still typed
  // against the legacy `{modality, provider}` shape for back-compat
  // even though the validator already accepts the ADR-0023
  // `{binding, kind|kindOneOf}` form we exercise here.
  const manifest = {
    id: "fake_neo4j_consumer",
    name: "fake_neo4j_consumer",
    version: "1.0.0" as const,
    category: "tool" as const,
    contract: 2 as const,
    description: "test plugin: requires a neo4j binding on `target`",
    requires: [{ binding: "target", kindOneOf: ["neo4j"] }]
  } as unknown as Parameters<
    (typeof harness.deps.pluginRegistry)["register"]
  >[0]["manifest"];
  harness.deps.pluginRegistry.register({
    mode: "in_process",
    manifest,
    implementation: {
      manifest,
      async execute() {
        return { outputs: { ok: true } };
      }
    }
  });
}

function specBindingTarget(datasetSlug: string): PipelineSpec {
  return {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "binding-kind-check" },
    spec: {
      nodes: [
        { id: "in", type: "input" },
        {
          id: "consume",
          plugin: { category: "tool", id: "fake_neo4j_consumer", version: "1.0.0" },
          dataset: { slug: datasetSlug }
        },
        { id: "out", type: "output" }
      ],
      edges: [
        { from: "in", to: "consume" },
        { from: "consume", to: "out" }
      ]
    }
  };
}

async function setupTenantWithConnections(
  harness: ReturnType<typeof buildHarness>,
  conns: Array<{ slug: string; kind: string }>,
  datasets: Array<{ slug: string; binding: string; connectionSlug: string }>
): Promise<void> {
  await harness.request({
    method: "POST",
    path: "/api/tenants",
    headers: ADMIN,
    body: { id: TENANT, slug: "kind-check", name: "Kind Check" }
  });
  for (const c of conns) {
    const out = await harness.request({
      method: "POST",
      path: "/api/connections",
      headers: TENANT_HEADERS,
      body: {
        scope: "tenant",
        tenantId: TENANT,
        slug: c.slug,
        displayName: c.slug,
        kind: c.kind,
        config: { host: "stub" }
      }
    });
    assert.equal(out.status, 201, `connection POST: ${JSON.stringify(out.body)}`);
  }
  for (const d of datasets) {
    const out = await harness.request({
      method: "POST",
      path: "/api/datasets",
      headers: TENANT_HEADERS,
      body: {
        scope: "tenant",
        tenantId: TENANT,
        slug: d.slug,
        displayName: d.slug,
        embeddingProfile: {},
        chunkSchema: {},
        bindings: { [d.binding]: { connection: d.connectionSlug } }
      }
    });
    assert.equal(out.status, 201, `dataset POST: ${JSON.stringify(out.body)}`);
  }
}

// ---------------------------------------------------------------------------
// Mismatch: dataset binds a non-neo4j connection — must fire the error
// ---------------------------------------------------------------------------

test("POST /api/pipelines/validate flags dataset_binding_kind_mismatch when the bound connection's kind doesn't match the node's requires.kindOneOf", async () => {
  const harness = buildHarness();
  registerFakeNeo4jConsumer(harness);
  await setupTenantWithConnections(
    harness,
    [{ slug: "bulwark-pg", kind: "postgres" }],
    [{ slug: "bulwark-pg-aws", binding: "target", connectionSlug: "bulwark-pg" }]
  );
  const res = await harness.request({
    method: "POST",
    path: "/api/pipelines/validate",
    headers: TENANT_HEADERS,
    body: specBindingTarget("bulwark-pg-aws")
  });
  assert.equal(res.status, 200);
  const mismatch = (res.body.errors as Array<{ code: string; message: string }>).find(
    (e) => e.code === "dataset_binding_kind_mismatch"
  );
  assert.ok(
    mismatch,
    `expected dataset_binding_kind_mismatch, got errors: ${JSON.stringify(res.body.errors)}`
  );
  assert.match(mismatch!.message, /neo4j/);
  assert.match(mismatch!.message, /postgres/);
});

// ---------------------------------------------------------------------------
// No-mismatch: dataset binds a neo4j connection whose SLUG does NOT
// look like the kind (e.g. "bulwark-wg"). The Builder used to flag
// this incorrectly (slug-as-kind heuristic); server-side must resolve
// slug → kind and pass.
// ---------------------------------------------------------------------------

test("POST /api/pipelines/validate does NOT flag a mismatch when the underlying kind matches even if the connection slug isn't the kind string", async () => {
  const harness = buildHarness();
  registerFakeNeo4jConsumer(harness);
  await setupTenantWithConnections(
    harness,
    [{ slug: "bulwark-wg", kind: "neo4j" }],
    [{ slug: "bulwark-wg-aws-prod", binding: "target", connectionSlug: "bulwark-wg" }]
  );
  const res = await harness.request({
    method: "POST",
    path: "/api/pipelines/validate",
    headers: TENANT_HEADERS,
    body: specBindingTarget("bulwark-wg-aws-prod")
  });
  assert.equal(res.status, 200);
  const mismatch = (res.body.errors as Array<{ code: string }>).find(
    (e) => e.code === "dataset_binding_kind_mismatch"
  );
  assert.equal(
    mismatch,
    undefined,
    "slug 'bulwark-wg' resolves to kind 'neo4j' which satisfies kindOneOf=[neo4j] — no mismatch"
  );
});

// ---------------------------------------------------------------------------
// GET /api/pipelines/:id/validation flows through the same index path
// ---------------------------------------------------------------------------

test("GET /api/pipelines/:id/validation also surfaces dataset_binding_kind_mismatch (provisioning-script poll loop)", async () => {
  const harness = buildHarness();
  registerFakeNeo4jConsumer(harness);
  await setupTenantWithConnections(
    harness,
    [{ slug: "bulwark-pg", kind: "postgres" }],
    [{ slug: "bulwark-pg-aws", binding: "target", connectionSlug: "bulwark-pg" }]
  );
  const pipeRes = await harness.request({
    method: "POST",
    path: "/api/pipelines",
    headers: TENANT_HEADERS,
    body: { slug: "p1", name: "p1" }
  });
  assert.equal(pipeRes.status, 201);
  const pId = pipeRes.body.pipeline.id;
  const verRes = await harness.request({
    method: "POST",
    path: `/api/pipelines/${pId}/versions`,
    headers: TENANT_HEADERS,
    body: {
      version: "1.0.0",
      publish: true,
      spec: specBindingTarget("bulwark-pg-aws")
    }
  });
  assert.equal(verRes.status, 201);
  const val = await harness.request({
    method: "GET",
    path: `/api/pipelines/${pId}/validation`,
    headers: TENANT_HEADERS
  });
  assert.equal(val.status, 200);
  const mismatch = (val.body.errors as Array<{ code: string }>).find(
    (e) => e.code === "dataset_binding_kind_mismatch"
  );
  assert.ok(mismatch, `expected error, got: ${JSON.stringify(val.body.errors)}`);
});
