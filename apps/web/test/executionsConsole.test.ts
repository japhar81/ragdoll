/**
 * Pure-function tests for the Executions console.
 *
 * Coverage of:
 *  - Bug 1 fix: every entry carries the FULL execution UUID in
 *    detail.executionId so the "jump" badge + downstream
 *    /api/executions/:id/trace call never get the 8-char prefix.
 *  - Bug 2 fix: backfillEntries() synthesizes a complete row history
 *    from a trace document so the live tail shows the full story when
 *    a user selects an existing run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  entryForEvent,
  backfillEntries
} from "../src/components/executionsConsoleEntries.ts";
import type { ChangeEvent } from "../../../packages/events/src/index.ts";

const FULL_ID = "440b9835-0178-40cd-a04f-a662d2f0e716";

function makeEvent(action: string, payload: Record<string, unknown> = {}): ChangeEvent {
  return {
    id: "evt-1",
    at: new Date().toISOString(),
    action,
    targetType: "execution",
    targetId: FULL_ID,
    tenantId: "t-1",
    actorId: null,
    payload
  } as ChangeEvent;
}

test("entryForEvent stamps the FULL execution UUID on detail (Bug 1)", () => {
  const cases = [
    "execution.started",
    "execution.node.started",
    "execution.node.completed",
    "execution.completed",
    "execution.failed",
    "execution.denied"
  ];
  for (const action of cases) {
    const entry = entryForEvent(makeEvent(action, { status: "running", nodeId: "n1" }));
    assert.ok(entry, `${action} should produce an entry`);
    const detail = entry!.detail as { executionId?: string };
    assert.equal(
      detail.executionId,
      FULL_ID,
      `${action}: detail.executionId must be the FULL UUID, not the 8-char prefix`
    );
  }
});

test("entryForEvent label uses the 8-char prefix for readability", () => {
  const entry = entryForEvent(makeEvent("execution.started"));
  assert.ok(entry);
  // Label has the prefix, NOT the full UUID — that's intentional, the
  // user-visible label stays short; the full id rides in detail.
  assert.match(entry!.label, /440b9835/);
  assert.doesNotMatch(entry!.label, /a662d2f0e716/);
});

test("entryForEvent: executionId in detail wins over any payload field of the same name", () => {
  // Defense-in-depth — even if a worker accidentally puts a stale
  // executionId in its event payload, the resolved entry uses the
  // ChangeEvent's targetId.
  const entry = entryForEvent(
    makeEvent("execution.completed", { status: "succeeded", executionId: "wrong-id" })
  );
  assert.equal(
    (entry!.detail as { executionId: string }).executionId,
    FULL_ID
  );
});

test("backfillEntries synthesizes a started/per-node/terminal row sequence (Bug 2)", () => {
  const entries = backfillEntries({
    executionId: FULL_ID,
    execution: {
      startedAt: "2026-06-09T02:34:03.000Z",
      completedAt: "2026-06-09T02:34:03.085Z",
      status: "succeeded"
    },
    nodes: [
      {
        nodeId: "input",
        status: "succeeded",
        startedAt: "2026-06-09T02:34:03.001Z",
        completedAt: "2026-06-09T02:34:03.020Z",
        latencyMs: 19
      },
      {
        nodeId: "transform",
        status: "succeeded",
        startedAt: "2026-06-09T02:34:03.021Z",
        completedAt: "2026-06-09T02:34:03.080Z",
        latencyMs: 59
      }
    ]
  });
  // 1 started + (2 nodes × 2 rows) + 1 terminal = 6
  assert.equal(entries.length, 6);
  assert.match(entries[0].label, /started/);
  assert.match(entries[1].label, /input running/);
  assert.match(entries[2].label, /input succeeded \(19ms\)/);
  assert.match(entries[5].label, /succeeded/);
  // Every entry carries the FULL UUID in detail.
  for (const e of entries) {
    assert.equal((e.detail as { executionId: string }).executionId, FULL_ID);
  }
  // Timestamps preserved from history.
  assert.equal(entries[0].ts, Date.parse("2026-06-09T02:34:03.000Z"));
  assert.equal(entries[5].ts, Date.parse("2026-06-09T02:34:03.085Z"));
});

test("backfillEntries: failed terminal includes error excerpt", () => {
  const entries = backfillEntries({
    executionId: FULL_ID,
    execution: {
      startedAt: "2026-06-09T02:34:03.000Z",
      completedAt: "2026-06-09T02:34:03.085Z",
      status: "failed",
      error: "connection refused: localhost:8123"
    },
    nodes: []
  });
  const terminal = entries[entries.length - 1];
  assert.equal(terminal.level, "error");
  assert.match(terminal.label, /failed: connection refused/);
});

test("backfillEntries: non-terminal status (running) omits the bookend", () => {
  const entries = backfillEntries({
    executionId: FULL_ID,
    execution: {
      startedAt: "2026-06-09T02:34:03.000Z",
      completedAt: null,
      status: "running"
    },
    nodes: [
      {
        nodeId: "n1",
        status: "running",
        startedAt: "2026-06-09T02:34:03.001Z",
        completedAt: null
      }
    ]
  });
  // 1 started + (1 node × 2 rows) = 3 — no terminal row because the
  // execution is still going; live events will fill that in.
  assert.equal(entries.length, 3);
  assert.match(entries[0].label, /started/);
  assert.match(entries[1].label, /n1 running/);
  // The second node row reflects the status "running" since the
  // historical state isn't terminal yet.
  assert.match(entries[2].label, /n1 running/);
});
