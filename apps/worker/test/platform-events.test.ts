/**
 * The execution-lifecycle → platform-event wiring: PublishingExecutionStore
 * emits `execution.start` on start() and `execution.finish` + the
 * outcome-specialized event on complete(), and those flow through the
 * in-process dispatcher to a subscribed plugin's on().
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PublishingExecutionStore } from "../src/handlers/execution-store-decorators.ts";
import {
  PlatformEventDispatcher,
  PlatformPluginRegistry,
  inProcessEmitter,
  type ExecutionEvent,
  type PlatformEvent
} from "../../../packages/platform-plugins/src/index.ts";
import type {
  ExecutionRecord,
  ExecutionStore
} from "../../../packages/runtime/src/index.ts";
import type { ChangeBus } from "../../../packages/events/src/index.ts";

const noopInner: ExecutionStore = {
  start: async () => undefined,
  complete: async () => undefined,
  startNode: async () => undefined,
  completeNode: async () => undefined,
  recordUsage: async () => undefined
};
const noopBus: ChangeBus = {
  publish: async () => undefined,
  subscribe: () => () => undefined,
  close: async () => undefined
};

function record(status: ExecutionRecord["status"]): ExecutionRecord {
  return {
    executionId: "exec-42",
    tenantId: "t1",
    pipelineId: "p1",
    pipelineVersionId: "v1",
    status,
    actorId: "u1",
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:00:05Z"
  } as ExecutionRecord;
}

test("decorator emits execution.start on start(), finish + success on complete(succeeded)", async () => {
  const captured: PlatformEvent[] = [];
  const store = new PublishingExecutionStore(noopInner, noopBus, undefined, (e) =>
    captured.push(e)
  );
  await store.start(record("running"));
  await store.complete(record("succeeded"));

  assert.deepEqual(
    captured.map((e) => e.event),
    ["execution.start", "execution.finish", "execution.success"]
  );
  for (const e of captured) {
    assert.equal(e.category, "execution");
    assert.equal(e.phase, "post");
    assert.equal(e.correlationId, "exec-42"); // brackets pre/post of the run
    assert.equal((e as ExecutionEvent).executionId, "exec-42");
    assert.equal((e as ExecutionEvent).pipelineId, "p1");
    assert.equal(e.actor.id, "u1");
  }
});

test("complete(failed) emits execution.finish + execution.failure", async () => {
  const captured: PlatformEvent[] = [];
  const store = new PublishingExecutionStore(noopInner, noopBus, undefined, (e) =>
    captured.push(e)
  );
  await store.complete(record("failed"));
  assert.deepEqual(
    captured.map((e) => e.event),
    ["execution.finish", "execution.failure"]
  );
});

test("end-to-end: a plugin subscribed to execution.failure is invoked via the in-process dispatcher", async () => {
  const seen: string[] = [];
  const registry = new PlatformPluginRegistry();
  registry.register({
    name: "alert-on-failure",
    subscriptions: [{ events: ["execution.failure"], phases: ["post"] }],
    on: (e) => {
      seen.push(`${e.event}:${(e as ExecutionEvent).executionId}`);
    }
  });
  const dispatcher = new PlatformEventDispatcher(registry);
  const store = new PublishingExecutionStore(
    noopInner,
    noopBus,
    undefined,
    inProcessEmitter(dispatcher)
  );

  await store.complete(record("failed"));
  // emit is fire-and-forget; let the delivery microtasks drain.
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(seen, ["execution.failure:exec-42"]);
});
