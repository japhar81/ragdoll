/**
 * ADR-0037: GET /api/executions/:id/stream (SSE result stream) and
 * GET /api/executions/:id/steps/:frameId (fetch a large step's full body).
 *
 * These exercise the REPLAY + terminal path: the execution is already
 * finished with persisted step frames, so the stream replays them and closes
 * with `done` (deterministic — no live bus needed). The harness drains the
 * async-iterable SSE body into a string, so we parse frames from that.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness } from "./helpers.ts";
import type { ExecutionStepRecord } from "../../../packages/runtime/src/index.ts";

const ADMIN = { "x-actor-id": "admin", "x-roles": "platform_admin" };

function parseSse(body: string): { event: string; data: unknown }[] {
  const out: { event: string; data: unknown }[] = [];
  for (const block of body.replace(/\r\n/g, "\n").split("\n\n")) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    let data: unknown = dataLines.join("\n");
    try {
      data = JSON.parse(dataLines.join("\n"));
    } catch {
      /* keep raw */
    }
    out.push({ event, data });
  }
  return out;
}

async function seedFinishedExecution(
  harness: ReturnType<typeof buildHarness>,
  executionId: string,
  tenantId: string,
  steps: ExecutionStepRecord[]
): Promise<void> {
  const store = harness.deps.executionStore;
  await store.start({
    executionId,
    tenantId,
    pipelineId: "p",
    pipelineVersionId: "v",
    environment: "test",
    status: "running",
    startedAt: new Date().toISOString()
  });
  for (const s of steps) await store.recordStep!(s);
  await store.complete({
    executionId,
    tenantId,
    pipelineId: "p",
    pipelineVersionId: "v",
    environment: "test",
    status: "succeeded",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  });
}

function stepFrame(over: Partial<ExecutionStepRecord>): ExecutionStepRecord {
  return {
    frameId: "frame-1",
    executionId: "exec-stream",
    nodeId: "retrieve",
    channel: "primary",
    source: "node_output",
    seq: 1,
    at: new Date().toISOString(),
    data: { doc: "small" },
    ...over
  };
}

test("GET /:id/stream replays persisted step frames then closes with done", async () => {
  const harness = buildHarness();
  await seedFinishedExecution(harness, "exec-stream", "tenant-a", [
    stepFrame({ frameId: "f1", seq: 1, channel: "primary", data: { doc: "hello" } }),
    stepFrame({ frameId: "f2", seq: 2, channel: "ancillary", source: "emit", data: { doc: "world" } })
  ]);

  const res = await harness.request({
    method: "GET",
    path: "/api/executions/exec-stream/stream",
    headers: ADMIN
  });
  assert.equal(res.status, 200);
  const frames = parseSse(res.body as string);
  const kinds = frames.map((f) => f.event);
  assert.ok(kinds.includes("hello"));
  assert.ok(kinds.includes("done"));

  const steps = frames.filter((f) => f.event === "step");
  assert.equal(steps.length, 2, "both persisted frames replayed");
  const primary = steps.find((s) => (s.data as { channel?: string }).channel === "primary");
  const ancillary = steps.find((s) => (s.data as { channel?: string }).channel === "ancillary");
  assert.deepEqual((primary!.data as { data?: unknown }).data, { doc: "hello" });
  assert.deepEqual((ancillary!.data as { data?: unknown }).data, { doc: "world" });
  // Replayed frames are flagged so a client can distinguish catch-up from live.
  assert.equal((primary!.data as { replayed?: boolean }).replayed, true);
});

test("large step body arrives truncated on the wire; full body via steps/:frameId", async () => {
  const harness = buildHarness();
  const big = "x".repeat(20_000); // > STEP_INLINE_MAX_BYTES (16 KiB)
  await seedFinishedExecution(harness, "exec-big", "tenant-a", [
    stepFrame({ executionId: "exec-big", frameId: "big-1", seq: 1, data: { blob: big } })
  ]);

  const streamRes = await harness.request({
    method: "GET",
    path: "/api/executions/exec-big/stream",
    headers: ADMIN
  });
  const steps = parseSse(streamRes.body as string).filter((f) => f.event === "step");
  assert.equal(steps.length, 1);
  const wire = steps[0].data as {
    truncated?: boolean;
    data?: unknown;
    bytes?: number;
    frameId?: string;
  };
  assert.equal(wire.truncated, true, "large body must be truncated on the wire");
  assert.equal(wire.data, undefined, "full body must not ride the SSE frame");
  assert.equal(wire.frameId, "big-1");

  // Fetch the full body by ref.
  const full = await harness.request({
    method: "GET",
    path: "/api/executions/exec-big/steps/big-1",
    headers: ADMIN
  });
  assert.equal(full.status, 200);
  assert.deepEqual(full.body.step.data, { blob: big });
});

test("cross-tenant principal cannot stream or fetch another tenant's execution", async () => {
  const harness = buildHarness();
  await seedFinishedExecution(harness, "exec-priv", "tenant-a", [
    stepFrame({ executionId: "exec-priv", frameId: "p1", seq: 1, data: { doc: "secret" } })
  ]);
  const otherTenant = {
    "x-actor-id": "b",
    "x-roles": "tenant_admin",
    "x-tenant-id": "tenant-b"
  };
  const stream = await harness.request({
    method: "GET",
    path: "/api/executions/exec-priv/stream",
    headers: otherTenant
  });
  assert.equal(stream.status, 403);
  const step = await harness.request({
    method: "GET",
    path: "/api/executions/exec-priv/steps/p1",
    headers: otherTenant
  });
  assert.equal(step.status, 403);
});

test("streaming an unknown execution is 404", async () => {
  const harness = buildHarness();
  const res = await harness.request({
    method: "GET",
    path: "/api/executions/nope/stream",
    headers: ADMIN
  });
  assert.equal(res.status, 404);
});
