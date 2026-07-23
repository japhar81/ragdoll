/**
 * Pipelines-as-modules — a pipeline invoking another as a step (`pipeline_call`).
 *
 * Exercises the three capabilities that turn "call a pipeline" into a real
 * module system, end-to-end through /invoke:
 *   - VERSION PINNING: `pipelineVersion` pins a reproducible dependency;
 *     an unknown pin fails loudly; no pin follows the active deployment.
 *   - MODULE SIGNATURE: a callee's declared `signature.input` is validated at
 *     the call site — a bad payload fails BEFORE the callee runs.
 *   - LINEAGE: the nested run records the caller as its `parentExecutionId`.
 *   - The existing cycle + depth guards still hold.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness, echoSpec, type Harness } from "./helpers.ts";
import { pipelineCallPlugin } from "../../../plugins/builtin-rag/src/retrieval-v2.ts";
import type { PipelineSpec } from "../../../packages/core/src/index.ts";

const ADMIN = { "x-actor-id": "admin", "x-roles": "platform_admin", "x-tenant-id": "tenant-a" };

/** A caller pipeline: input → pipeline_call(target) → output. */
function callerSpec(target: string, extraConfig: Record<string, unknown> = {}): PipelineSpec {
  return {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: `call-${target}`, executionKind: "synchronous" },
    spec: {
      nodes: [
        { id: "in", type: "input" },
        {
          id: "call",
          plugin: { category: "tool", id: "pipeline_call", version: "1.0.0" },
          config: { pipelineSlug: target, ...extraConfig }
        },
        { id: "out", type: "output" }
      ],
      edges: [
        { from: "in", to: "call" },
        { from: "call", to: "out" }
      ]
    }
  };
}

async function seed(
  h: Harness,
  slug: string,
  spec: PipelineSpec,
  version = "1.0.0",
  opts: { deploy?: boolean } = {}
): Promise<string> {
  const created = await h.request({ method: "POST", path: "/api/pipelines", headers: ADMIN, body: { slug, name: slug } });
  const id = created.body.pipeline.id as string;
  await h.request({
    method: "POST",
    path: `/api/pipelines/${id}/versions`,
    headers: ADMIN,
    body: { version, publish: true, spec }
  });
  if (opts.deploy !== false) {
    await h.request({
      method: "POST",
      path: `/api/pipelines/${id}/deployments`,
      headers: ADMIN,
      body: { version, environment: "dev" }
    });
  }
  return id;
}

function harness(): Harness {
  return buildHarness({ extraPlugins: [pipelineCallPlugin] });
}

async function invoke(h: Harness, id: string, input: unknown) {
  return h.request({
    method: "POST",
    path: `/api/pipelines/${id}/invoke`,
    headers: ADMIN,
    body: { input }
  });
}

test("a pipeline invokes another as a step and returns its output", async () => {
  const h = harness();
  await seed(h, "child", echoSpec("child"));
  const callerId = await seed(h, "caller", callerSpec("child"));
  const res = await invoke(h, callerId, { question: "hi" });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "succeeded");
  assert.ok(res.body.output, "caller returns the child's output");
});

test("version pinning: a bad pin fails loudly, a good pin resolves", async () => {
  const h = harness();
  await seed(h, "child", echoSpec("child"), "1.0.0");

  // Unknown pin → clear error (surfaced as a 500 execution_failed).
  const badId = await seed(h, "caller-bad", callerSpec("child", { pipelineVersion: "9.9.9" }));
  const bad = await invoke(h, badId, { q: 1 });
  assert.equal(bad.status, 500);
  assert.match(bad.body.message, /no version "9\.9\.9"/);

  // Existing pin → resolves and runs.
  const goodId = await seed(h, "caller-good", callerSpec("child", { pipelineVersion: "1.0.0" }));
  const good = await invoke(h, goodId, { q: 1 });
  assert.equal(good.body.status, "succeeded");
});

test("module signature: input is validated against the callee's declared contract", async () => {
  const h = harness();
  // Child declares it requires a string `question`.
  const childSpec = echoSpec("child");
  childSpec.spec.signature = {
    input: { type: "object", required: ["question"], properties: { question: { type: "string" } } }
  };
  await seed(h, "child", childSpec);
  const callerId = await seed(h, "caller", callerSpec("child"));

  // Missing the required field → rejected at the call site, callee never runs.
  const bad = await invoke(h, callerId, { notQuestion: 1 });
  assert.equal(bad.status, 500);
  assert.match(bad.body.message, /signature/);
  assert.match(bad.body.message, /required property 'question'/);

  // Satisfying the contract → runs.
  const ok = await invoke(h, callerId, { question: "hello" });
  assert.equal(ok.body.status, "succeeded");
});

test("lineage: the nested run records the caller as its parent execution", async () => {
  const h = harness();
  await seed(h, "child", echoSpec("child"));
  const callerId = await seed(h, "caller", callerSpec("child"));
  const res = await invoke(h, callerId, { question: "hi" });
  assert.equal(res.body.status, "succeeded");

  const parentId = res.body.executionId as string;
  // Find the nested execution whose parentExecutionId points at the caller.
  const all = h.deps.executionStore as unknown as { executions: Array<Record<string, unknown>> };
  const children = all.executions.filter((e) => e.parentExecutionId === parentId);
  assert.equal(children.length, 1, "exactly one child execution linked to the caller");
  assert.notEqual(children[0].executionId, parentId);
  // The top-level run has no parent.
  const parent = all.executions.find((e) => e.executionId === parentId);
  assert.equal(parent?.parentExecutionId ?? null, null);
});

test("cycle + depth guards still hold across pipeline_call", async () => {
  const h = harness();
  // A calls B, B calls A → cycle.
  await seed(h, "a", callerSpec("b"));
  // Re-point: b calls a. Seed b first without deploy conflict.
  await seed(h, "b", callerSpec("a"));
  const aPipe = await h.request({ method: "GET", path: "/api/pipelines", headers: ADMIN });
  const a = aPipe.body.pipelines.find((p: { slug: string }) => p.slug === "a");
  const res = await invoke(h, a.id, { question: "loop" });
  assert.equal(res.status, 500);
  assert.match(res.body.message, /cycle detected/);
});
