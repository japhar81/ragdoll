import test from "node:test";
import assert from "node:assert/strict";
import {
  diffNodeEvents,
  isTerminalStatus,
  sampleForDisplay,
  summarizeExecution,
  type NodeLike
} from "../src/lib/execTrace.ts";

// ---- isTerminalStatus ----------------------------------------------------

test("isTerminalStatus: only succeeded/failed/cancelled are terminal", () => {
  assert.equal(isTerminalStatus("succeeded"), true);
  assert.equal(isTerminalStatus("failed"), true);
  assert.equal(isTerminalStatus("cancelled"), true);
  assert.equal(isTerminalStatus("running"), false);
  assert.equal(isTerminalStatus("skipped"), false);
  assert.equal(isTerminalStatus(undefined), false);
  assert.equal(isTerminalStatus(null), false);
  assert.equal(isTerminalStatus("weird"), false);
});

// ---- sampleForDisplay ----------------------------------------------------

test("sampleForDisplay truncates long strings with a +N chars hint", () => {
  const s = "x".repeat(700);
  const out = sampleForDisplay(s, { maxString: 500 }) as string;
  assert.equal(typeof out, "string");
  assert.match(out, /… \(\+200 chars\)$/);
  assert.equal(out.length, 500 + "… (+200 chars)".length);
  // short strings pass through untouched
  assert.equal(sampleForDisplay("hi"), "hi");
});

test("sampleForDisplay caps arrays to first N + a (+M more) sentinel", () => {
  const arr = Array.from({ length: 12 }, (_, i) => i);
  const out = sampleForDisplay(arr, { maxArray: 5 }) as unknown[];
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 6); // 5 kept + 1 sentinel
  assert.deepEqual(out.slice(0, 5), [0, 1, 2, 3, 4]);
  assert.equal(out[5], "… (+7 more)");
  // small arrays untouched
  assert.deepEqual(sampleForDisplay([1, 2], { maxArray: 5 }), [1, 2]);
});

test("sampleForDisplay caps object nesting depth", () => {
  const deep = { a: { b: { c: { d: { e: 1 } } } } };
  const out = sampleForDisplay(deep, { maxDepth: 3 }) as Record<string, unknown>;
  // a(1) -> b(2) -> c(3) -> at depth 3 the value is collapsed
  const a = out.a as Record<string, unknown>;
  const b = a.b as Record<string, unknown>;
  assert.equal(b.c, "[depth limit]");
});

test("sampleForDisplay caps object key count", () => {
  const big: Record<string, number> = {};
  for (let i = 0; i < 40; i++) big[`k${i}`] = i;
  const out = sampleForDisplay(big, { maxKeys: 10 }) as Record<string, unknown>;
  const keys = Object.keys(out);
  assert.equal(keys.length, 11); // 10 + the "…" overflow marker
  assert.match(String(out["…"]), /\+30 more keys/);
});

test("sampleForDisplay never throws on circular / null / weird values", () => {
  const cyc: Record<string, unknown> = { name: "root" };
  cyc.self = cyc;
  const out = sampleForDisplay(cyc) as Record<string, unknown>;
  assert.equal(out.name, "root");
  assert.equal(out.self, "[Circular]");
  // JSON-stringifiable result (the whole point)
  assert.doesNotThrow(() => JSON.stringify(out));

  assert.equal(sampleForDisplay(null), null);
  assert.equal(sampleForDisplay(undefined), "[undefined]");
  assert.equal(sampleForDisplay(42), 42);
  assert.equal(sampleForDisplay(true), true);
  assert.equal(sampleForDisplay(() => 1), "[Function]");
  const d = new Date("2026-05-18T00:00:00.000Z");
  assert.equal(sampleForDisplay(d), "2026-05-18T00:00:00.000Z");
  assert.equal(
    sampleForDisplay(new Error("boom")),
    "Error: boom"
  );
});

test("sampleForDisplay keeps a realistic node payload usable", () => {
  const payload = {
    text: "answer ".repeat(200),
    model: "claude",
    provider: "anthropic",
    messages: Array.from({ length: 30 }, (_, i) => ({ role: "user", n: i }))
  };
  const out = sampleForDisplay(payload) as Record<string, unknown>;
  assert.match(out.text as string, /\(\+\d+ chars\)$/);
  assert.equal(out.model, "claude");
  const msgs = out.messages as unknown[];
  assert.equal(msgs.length, 6); // 5 + sentinel
  assert.doesNotThrow(() => JSON.stringify(out));
});

// ---- diffNodeEvents ------------------------------------------------------

const n = (
  nodeId: string,
  status: string,
  extra: Partial<NodeLike> = {}
): NodeLike => ({ nodeId, status, ...extra });

test("diffNodeEvents emits only new transitions, in next order", () => {
  const t0: NodeLike[] = [];
  const t1: NodeLike[] = [n("input", "succeeded", { latencyMs: 2 }), n("retrieve", "running")];
  const e1 = diffNodeEvents(t0, t1);
  assert.deepEqual(
    e1.map((e) => e.message),
    ["node input succeeded in 2ms", "node retrieve started"]
  );

  // Next poll: retrieve finished, llm started. input/retrieve-running are
  // already seen so they must NOT re-emit.
  const t2: NodeLike[] = [
    n("input", "succeeded", { latencyMs: 2 }),
    n("retrieve", "succeeded", { latencyMs: 1500 }),
    n("llm", "running")
  ];
  const e2 = diffNodeEvents(t1, t2);
  assert.deepEqual(
    e2.map((e) => e.message),
    ["node retrieve succeeded in 1.50s", "node llm started"]
  );
});

test("diffNodeEvents produces a prominent failure message + error field", () => {
  const prev: NodeLike[] = [n("llm", "running")];
  const next: NodeLike[] = [n("llm", "failed", { error: "rate limited" })];
  const ev = diffNodeEvents(prev, next);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].message, "node llm failed: rate limited");
  assert.equal(ev[0].level, "error");
  assert.equal(ev[0].error, "rate limited");
});

test("diffNodeEvents sub-millisecond latency and level mapping", () => {
  const ev = diffNodeEvents([], [n("a", "succeeded", { latencyMs: 0.5 })]);
  assert.equal(ev[0].message, "node a succeeded in 0.50ms");
  assert.equal(ev[0].level, "success");
  assert.equal(diffNodeEvents([], [n("b", "running")])[0].level, "info");
  assert.equal(diffNodeEvents([], [n("c", "skipped")])[0].level, "warn");
});

test("diffNodeEvents handles undefined / malformed snapshots safely", () => {
  assert.deepEqual(diffNodeEvents(undefined, undefined), []);
  assert.deepEqual(diffNodeEvents(undefined, []), []);
  const ev = diffNodeEvents(undefined, [n("ok", "running")]);
  assert.equal(ev.length, 1);
  // ignores entries missing nodeId/status
  const messy = [
    { status: "running" } as unknown as NodeLike,
    n("ok", "running")
  ];
  assert.equal(diffNodeEvents([], messy).length, 1);
});

test("diffNodeEvents detail samples the node output (or input fallback)", () => {
  const big = "z".repeat(900);
  const ev = diffNodeEvents([], [n("x", "succeeded", { output: { text: big } })]);
  const detail = ev[0].detail as Record<string, unknown>;
  assert.match(detail.text as string, /\(\+\d+ chars\)$/);
  // falls back to input when no output
  const ev2 = diffNodeEvents([], [n("y", "running", { input: { question: "hi" } })]);
  assert.deepEqual(ev2[0].detail, { question: "hi" });
});

// ---- summarizeExecution --------------------------------------------------

test("summarizeExecution: succeeded with duration + output", () => {
  const s = summarizeExecution({
    status: "succeeded",
    startedAt: "2026-05-18T00:00:00.000Z",
    completedAt: "2026-05-18T00:00:01.500Z",
    output: { answer: "ok" }
  });
  assert.equal(s.terminal, true);
  assert.equal(s.durationMs, 1500);
  assert.equal(s.hasOutput, true);
  assert.equal(s.hasError, false);
  assert.equal(s.line, "succeeded · in 1.50s · output present");
});

test("summarizeExecution: failed surfaces the error", () => {
  const s = summarizeExecution({
    status: "failed",
    startedAt: "2026-05-18T00:00:00.000Z",
    completedAt: "2026-05-18T00:00:00.200Z",
    error: "boom"
  });
  assert.equal(s.terminal, true);
  assert.equal(s.hasError, true);
  assert.equal(s.line, "failed · in 200ms · error present");
});

test("summarizeExecution: running (non-terminal, no completedAt)", () => {
  const s = summarizeExecution({
    status: "running",
    startedAt: "2026-05-18T00:00:00.000Z"
  });
  assert.equal(s.terminal, false);
  assert.equal(s.durationMs, undefined);
  assert.equal(s.line, "running · running…");
});

test("summarizeExecution: tolerates null / empty input", () => {
  const s = summarizeExecution(null);
  assert.equal(s.status, "unknown");
  assert.equal(s.terminal, false);
  assert.equal(s.hasOutput, false);
  assert.equal(s.hasError, false);
  // ignores a backwards completedAt rather than emitting a negative duration
  const bad = summarizeExecution({
    status: "succeeded",
    startedAt: "2026-05-18T00:00:02.000Z",
    completedAt: "2026-05-18T00:00:01.000Z"
  });
  assert.equal(bad.durationMs, undefined);
});
