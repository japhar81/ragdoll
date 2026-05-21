/**
 * Pure tests for the observability package. Covers:
 *
 *   - ConsoleJsonLogger emits a line per call AND, when a sink is wired,
 *     forwards the same record to that sink.
 *   - setSharedLogSink swaps the shared logger's sink.
 *   - wireOtelLogs returns a no-op shutdown when disabled / dependencies
 *     missing — never throws, regardless of environment.
 *   - wireOtelMetrics returns a no-op shutdown when disabled.
 *   - NoopMeter's counter/histogram are safe to call.
 *
 * No DOM, no OTel SDK side-effects — runs install-free under `node --test`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ConsoleJsonLogger,
  NoopMeter,
  NoopTracer,
  getLogger,
  getMeter,
  setSharedLogSink,
  wireOtelLogs,
  wireOtelMetrics,
  wireOtelTraces
} from "../src/index.ts";

// ---- ConsoleJsonLogger ----------------------------------------------------

test("ConsoleJsonLogger emits a JSON line per call to stdout/stderr", () => {
  const captured: string[] = [];
  const origLog = console.log;
  console.log = (line) => captured.push(String(line));
  try {
    new ConsoleJsonLogger().info("hello", { foo: "bar" });
  } finally {
    console.log = origLog;
  }
  assert.equal(captured.length, 1);
  const parsed = JSON.parse(captured[0]);
  assert.equal(parsed.level, "info");
  assert.equal(parsed.message, "hello");
  assert.equal(parsed.foo, "bar");
  assert.ok(typeof parsed.timestamp === "string");
});

test("ConsoleJsonLogger forwards to the optional sink (for OTLP log export)", () => {
  const sinkCalls: Array<{ level: string; message: string; fields: Record<string, unknown> }> = [];
  const log = new ConsoleJsonLogger((level, message, fields) =>
    sinkCalls.push({ level, message, fields })
  );
  const origLog = console.log;
  const origWarn = console.warn;
  const origErr = console.error;
  console.log = console.warn = console.error = () => {};
  try {
    log.info("started", { port: 3001 });
    log.warn("retrying", { attempt: 2 });
    log.error("failed", { code: "E_DB" });
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origErr;
  }
  assert.deepEqual(
    sinkCalls.map((c) => c.level),
    ["info", "warn", "error"]
  );
  assert.deepEqual(sinkCalls[0].fields, { port: 3001 });
  assert.equal(sinkCalls[2].message, "failed");
});

test("setSharedLogSink swaps the sink on the shared logger (in place)", () => {
  const a: string[] = [];
  setSharedLogSink((level, message) => a.push(`a:${level}:${message}`));
  const origLog = console.log;
  console.log = () => {};
  try {
    getLogger().info("one");
  } finally {
    console.log = origLog;
  }
  // Latest setSharedLogSink wins; passing undefined removes it for the
  // *next* sharedLogger ask, but the function itself is sync and idempotent.
  setSharedLogSink(undefined);
  assert.deepEqual(a, ["a:info:one"]);
});

// ---- wireOtelLogs ---------------------------------------------------------

test("wireOtelLogs(enabled:false) returns a no-op shutdown", async () => {
  const stop = await wireOtelLogs({ enabled: false });
  assert.equal(typeof stop, "function");
  // Must not throw even when called twice.
  await stop();
  await stop();
});

test("wireOtelLogs respects OTEL_LOGS_ENABLED=false env override", async () => {
  const prev = process.env.OTEL_LOGS_ENABLED;
  process.env.OTEL_LOGS_ENABLED = "false";
  try {
    const stop = await wireOtelLogs({});
    assert.equal(typeof stop, "function");
    await stop();
  } finally {
    if (prev === undefined) delete process.env.OTEL_LOGS_ENABLED;
    else process.env.OTEL_LOGS_ENABLED = prev;
  }
});

// ---- wireOtelMetrics ------------------------------------------------------

test("wireOtelMetrics(enabled:false) returns a no-op shutdown without wiring a meter", async () => {
  const stop = await wireOtelMetrics({ enabled: false });
  assert.equal(typeof stop, "function");
  // getMeter() should still be a no-op meter (safe to call counter/histogram).
  const meter = getMeter();
  const c = meter.counter("test_total");
  const h = meter.histogram("test_ms");
  c.add(1, { route: "/x" });
  h.record(42, { route: "/x" });
  await stop();
});

test("wireOtelMetrics respects OTEL_METRICS_ENABLED=false env override", async () => {
  const prev = process.env.OTEL_METRICS_ENABLED;
  process.env.OTEL_METRICS_ENABLED = "false";
  try {
    const stop = await wireOtelMetrics({});
    assert.equal(typeof stop, "function");
    await stop();
  } finally {
    if (prev === undefined) delete process.env.OTEL_METRICS_ENABLED;
    else process.env.OTEL_METRICS_ENABLED = prev;
  }
});

// ---- wireOtelTraces -------------------------------------------------------

test("wireOtelTraces(enabled:false) returns a no-op shutdown", async () => {
  const stop = await wireOtelTraces({ enabled: false });
  assert.equal(typeof stop, "function");
  await stop();
});

test("wireOtelTraces respects OTEL_TRACES_ENABLED=false env override", async () => {
  const prev = process.env.OTEL_TRACES_ENABLED;
  process.env.OTEL_TRACES_ENABLED = "false";
  try {
    const stop = await wireOtelTraces({});
    assert.equal(typeof stop, "function");
    await stop();
  } finally {
    if (prev === undefined) delete process.env.OTEL_TRACES_ENABLED;
    else process.env.OTEL_TRACES_ENABLED = prev;
  }
});

// ---- Noop primitives ------------------------------------------------------

test("NoopMeter / NoopTracer never throw and produce inert handles", () => {
  const m = new NoopMeter();
  m.counter("x").add(1);
  m.histogram("y").record(2.5, { z: "ok" });
  const t = new NoopTracer();
  const span = t.startSpan("ignored");
  span.setAttribute("k", "v");
  span.recordException(new Error("noop"));
  span.end();
});
