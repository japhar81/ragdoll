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

test("wireOtelMetrics with both exporters off returns no-op (no SDK init)", async () => {
  const stop = await wireOtelMetrics({
    exporters: { otlp: false, prometheus: false }
  });
  assert.equal(typeof stop, "function");
  // Meter stays Noop — counter add is a zero-cost call.
  const meter = getMeter();
  meter.counter("noop_total").add(1, { tag: "x" });
  await stop();
});

test("wireOtelMetrics env precedence: OTEL=false + PROM=false → no-op", async () => {
  const prevOtel = process.env.OTEL_METRICS_ENABLED;
  const prevProm = process.env.PROMETHEUS_METRICS_ENABLED;
  process.env.OTEL_METRICS_ENABLED = "false";
  process.env.PROMETHEUS_METRICS_ENABLED = "false";
  try {
    const stop = await wireOtelMetrics({});
    assert.equal(typeof stop, "function");
    await stop();
  } finally {
    if (prevOtel === undefined) delete process.env.OTEL_METRICS_ENABLED;
    else process.env.OTEL_METRICS_ENABLED = prevOtel;
    if (prevProm === undefined) delete process.env.PROMETHEUS_METRICS_ENABLED;
    else process.env.PROMETHEUS_METRICS_ENABLED = prevProm;
  }
});

test("wireOtelMetrics explicit options beat env vars (explicit prom:true wins)", async () => {
  // Env says BOTH off; explicit option turns prom ON only. Listener
  // should bind and serve /metrics; shutdown stops it.
  const prevOtel = process.env.OTEL_METRICS_ENABLED;
  const prevProm = process.env.PROMETHEUS_METRICS_ENABLED;
  process.env.OTEL_METRICS_ENABLED = "false";
  process.env.PROMETHEUS_METRICS_ENABLED = "false";
  // Per-pid port to avoid collisions when the suite runs in parallel.
  const port = 39000 + (process.pid % 1000);
  try {
    const stop = await wireOtelMetrics({
      exporters: { otlp: false, prometheus: true },
      prometheusPort: port,
      instrumentationName: "test-explicit-prom"
    });
    assert.equal(typeof stop, "function");
    // Emit ONCE through the shared meter. The PrometheusExporter
    // builds the response from the same MeterProvider, so it must
    // appear on /metrics without a second emit call.
    getMeter().counter("ragdoll_test_explicit_total").add(7, { kind: "a" });
    // Tiny delay so the collector picks up the recent record before
    // the scrape — Prometheus exposition aggregates on demand, so 0
    // *should* work but we give 50ms slack for the listener boot.
    await new Promise((r) => setTimeout(r, 50));
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(res.status, 200);
    const body = await res.text();
    // OTel auto-converts dots to underscores; counter name is emitted
    // unchanged here because we already used underscores. The exporter
    // also appends a `_total` suffix for counter type — guard against
    // both conventions to keep the test resilient to SDK quirks.
    assert.match(body, /ragdoll_test_explicit_total(_total)?\b/);
    await stop();
  } finally {
    if (prevOtel === undefined) delete process.env.OTEL_METRICS_ENABLED;
    else process.env.OTEL_METRICS_ENABLED = prevOtel;
    if (prevProm === undefined) delete process.env.PROMETHEUS_METRICS_ENABLED;
    else process.env.PROMETHEUS_METRICS_ENABLED = prevProm;
  }
});

test("wireOtelMetrics shutdown stops the Prometheus listener", async () => {
  // Sole purpose: prove no port leaks across runs. Bind, shut down,
  // then scrape — expect connection refused (i.e. an error, not a 200).
  const port = 40000 + (process.pid % 1000);
  const stop = await wireOtelMetrics({
    exporters: { otlp: false, prometheus: true },
    prometheusPort: port
  });
  await stop();
  let connected = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    // If we somehow get a response, the listener leaked.
    if (res.ok || res.status < 600) connected = true;
  } catch {
    // Expected: ECONNREFUSED / connect failed.
  }
  assert.equal(connected, false, "Prometheus listener leaked past shutdown");
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
