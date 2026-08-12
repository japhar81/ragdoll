/**
 * ADR-0037: PublishingExecutionStore.recordStep persists the full step frame
 * via the wrapped store AND fans a SIZE-CAPPED copy onto the change bus — the
 * full body never rides the bus; large frames travel as a preview + frameId.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PublishingExecutionStore } from "../src/handlers/execution-store-decorators.ts";
import { InMemoryExecutionStore } from "../../../packages/runtime/src/index.ts";
import type { ExecutionStepRecord } from "../../../packages/runtime/src/index.ts";
import { InMemoryChangeBus, type ChangeEvent } from "../../../packages/events/src/index.ts";

function frame(over: Partial<ExecutionStepRecord>): ExecutionStepRecord {
  return {
    frameId: "f1",
    executionId: "exec-1",
    nodeId: "retrieve",
    channel: "primary",
    source: "node_output",
    seq: 1,
    at: new Date().toISOString(),
    data: { doc: "small" },
    ...over
  };
}

async function seedStart(store: PublishingExecutionStore): Promise<void> {
  await store.start({
    executionId: "exec-1",
    tenantId: "tenant-a",
    pipelineId: "p",
    pipelineVersionId: "v",
    environment: "test",
    status: "running",
    startedAt: new Date().toISOString(),
    actorId: "actor-1"
  });
}

test("recordStep persists the full body and publishes a capped execution.step", async () => {
  const inner = new InMemoryExecutionStore();
  const bus = new InMemoryChangeBus();
  const events: ChangeEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const store = new PublishingExecutionStore(inner, bus);
  await seedStart(store);

  await store.recordStep(frame({ frameId: "f1", data: { doc: "hello" } }));

  // Persisted in full.
  assert.equal(inner.steps.length, 1);
  assert.deepEqual(inner.steps[0].data, { doc: "hello" });

  // Published on the bus, scoped + inline for a small body.
  const stepEvents = events.filter((e) => e.action === "execution.step");
  assert.equal(stepEvents.length, 1);
  const ev = stepEvents[0];
  assert.equal(ev.targetType, "execution");
  assert.equal(ev.targetId, "exec-1");
  assert.equal(ev.tenantId, "tenant-a"); // carried from start()'s meta
  assert.equal(ev.actorId, "actor-1");
  const payload = ev.payload as { frameId?: string; data?: unknown; truncated?: boolean };
  assert.equal(payload.frameId, "f1");
  assert.deepEqual(payload.data, { doc: "hello" });
  assert.equal(payload.truncated, undefined);
});

test("a large step body is truncated on the bus but persisted in full", async () => {
  const inner = new InMemoryExecutionStore();
  const bus = new InMemoryChangeBus();
  const events: ChangeEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const store = new PublishingExecutionStore(inner, bus);
  await seedStart(store);

  const big = "x".repeat(20_000);
  await store.recordStep(frame({ frameId: "big", data: { blob: big } }));

  // Full body persisted.
  assert.deepEqual(inner.steps[0].data, { blob: big });
  // Bus copy is truncated (no data), preview + frameId only.
  const payload = events.find((e) => e.action === "execution.step")!.payload as {
    frameId?: string;
    data?: unknown;
    truncated?: boolean;
    bytes?: number;
  };
  assert.equal(payload.truncated, true);
  assert.equal(payload.data, undefined);
  assert.equal(payload.frameId, "big");
  assert.ok((payload.bytes ?? 0) > 16 * 1024);
});
