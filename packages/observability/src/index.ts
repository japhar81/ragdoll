import type { RuntimeContext } from "../../core/src/index.ts";

export interface SpanHandle {
  setAttribute(key: string, value: string | number | boolean | undefined): void;
  recordException(error: unknown): void;
  end(): void;
}

export interface Tracer {
  startSpan(name: string, attributes?: Record<string, string | number | boolean | undefined>): SpanHandle;
}

export class NoopSpan implements SpanHandle {
  setAttribute(_key: string, _value: string | number | boolean | undefined): void {}
  recordException(_error: unknown): void {}
  end(): void {}
}

export class NoopTracer implements Tracer {
  startSpan(
    _name: string,
    _attributes?: Record<string, string | number | boolean | undefined>
  ): SpanHandle {
    return new NoopSpan();
  }
}

/**
 * Minimal structural shape of the bits of `@opentelemetry/api` we depend on.
 * Declared locally so nothing in the test path statically imports the package.
 */
interface OtelApiLike {
  trace: {
    getTracer(name: string, version?: string): OtelTracerLike;
  };
  SpanStatusCode: { ERROR: number; OK: number; UNSET: number };
}

interface OtelTracerLike {
  startSpan(name: string, options?: { attributes?: Record<string, unknown> }): OtelSpanLike;
}

interface OtelSpanLike {
  setAttribute(key: string, value: unknown): unknown;
  recordException(error: unknown): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  end(): unknown;
}

/**
 * Adapter exposing an OpenTelemetry tracer through the local
 * {@link Tracer}/{@link SpanHandle} interfaces. Constructed only after the
 * `@opentelemetry/api` package has been successfully imported at runtime.
 */
export class OtelTracer implements Tracer {
  private readonly tracer: OtelTracerLike;
  private readonly errorStatusCode: number;

  constructor(api: OtelApiLike, instrumentationName = "@ragdoll/runtime", instrumentationVersion = "0.1.0") {
    this.tracer = api.trace.getTracer(instrumentationName, instrumentationVersion);
    this.errorStatusCode = api.SpanStatusCode?.ERROR ?? 2;
  }

  startSpan(name: string, attributes?: Record<string, string | number | boolean | undefined>): SpanHandle {
    const cleaned: Record<string, unknown> = {};
    if (attributes) {
      for (const [key, value] of Object.entries(attributes)) {
        if (value !== undefined) cleaned[key] = value;
      }
    }
    const span = this.tracer.startSpan(name, { attributes: cleaned });
    return new OtelSpan(span, this.errorStatusCode);
  }
}

class OtelSpan implements SpanHandle {
  private readonly span: OtelSpanLike;
  private readonly errorStatusCode: number;

  constructor(span: OtelSpanLike, errorStatusCode: number) {
    this.span = span;
    this.errorStatusCode = errorStatusCode;
  }

  setAttribute(key: string, value: string | number | boolean | undefined): void {
    if (value === undefined) return;
    this.span.setAttribute(key, value);
  }

  recordException(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.span.recordException(normalized);
    this.span.setStatus({ code: this.errorStatusCode, message: normalized.message });
  }

  end(): void {
    this.span.end();
  }
}

export interface CreateTracerOptions {
  /** Force the no-op tracer regardless of OTel availability. */
  enabled?: boolean;
  /** OpenTelemetry instrumentation scope name. */
  instrumentationName?: string;
  /** OpenTelemetry instrumentation scope version. */
  instrumentationVersion?: string;
}

/**
 * Builds a {@link Tracer}. Attempts to lazily load `@opentelemetry/api`; if the
 * package is unavailable (e.g. offline, not installed) or `enabled` is `false`,
 * falls back to a {@link NoopTracer}. This never throws and never statically
 * imports an optional dependency.
 */
export async function createTracer(options: CreateTracerOptions = {}): Promise<Tracer> {
  if (options.enabled === false) return new NoopTracer();
  try {
    const api = (await import("@opentelemetry/api")) as unknown as OtelApiLike;
    if (!api?.trace?.getTracer) return new NoopTracer();
    return new OtelTracer(api, options.instrumentationName, options.instrumentationVersion);
  } catch {
    return new NoopTracer();
  }
}

/**
 * Lazily loads `@opentelemetry/resources` and builds a Resource that
 * stamps `service.name`, `service.namespace`, and
 * `deployment.environment` onto every emitted record. Reads
 * `OTEL_SERVICE_NAME` and the comma-separated `OTEL_RESOURCE_ATTRIBUTES`
 * conventional env vars so the values match what `OTEL_*` does for
 * auto-instrumented runtimes.
 *
 * Returns `undefined` on any import failure — the provider will fall
 * back to its built-in default resource (`service.name=unknown_service:node`).
 */
async function loadOtelResource(): Promise<unknown | undefined> {
  try {
    const mod = (await import("@opentelemetry/resources")) as unknown as {
      resourceFromAttributes?: (attrs: Record<string, unknown>) => unknown;
      Resource?: new (attrs: Record<string, unknown>) => unknown;
    };
    const attrs: Record<string, unknown> = {};
    if (process.env.OTEL_SERVICE_NAME) attrs["service.name"] = process.env.OTEL_SERVICE_NAME;
    for (const pair of (process.env.OTEL_RESOURCE_ATTRIBUTES ?? "").split(",")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1).trim();
      if (k && v) attrs[k] = v;
    }
    if (Object.keys(attrs).length === 0) return undefined;
    if (mod.resourceFromAttributes) return mod.resourceFromAttributes(attrs);
    if (mod.Resource) return new mod.Resource(attrs);
    return undefined;
  } catch {
    return undefined;
  }
}

// =========================================================================
// Logger
// =========================================================================

export interface StructuredLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * A {@link StructuredLogger} that ALSO forwards each line to a destination
 * function (typically an OTel log emitter). Logs continue to land on stdout
 * via the wrapped {@link ConsoleJsonLogger} so a missing collector never
 * silently drops operator visibility.
 */
export type LogSink = (
  level: "info" | "warn" | "error",
  message: string,
  fields: Record<string, unknown>
) => void;

/**
 * JSON.stringify a log line, falling back to a per-field elision when the
 * combined payload would exceed V8's ~512 MiB max-string and throw
 * `RangeError: Invalid string length`. Without this, a single huge field
 * (e.g. a pipeline node bag holding tens of thousands of docs) would kill
 * the entire run with a logger throw rather than letting the trace cap
 * handle truncation cleanly downstream.
 */
function safeStringifyLogLine(line: Record<string, unknown>): string {
  try {
    return JSON.stringify(line);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    const reduced: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(line)) {
      try {
        // Re-stringify each value alone — anything that overflows by itself
        // is the culprit; everything else passes through unchanged.
        JSON.stringify(v);
        reduced[k] = v;
      } catch {
        if (Array.isArray(v)) {
          reduced[k] = { __elided: true, kind: "array", length: v.length };
        } else if (v && typeof v === "object") {
          reduced[k] = {
            __elided: true,
            kind: "object",
            keys: Object.keys(v as Record<string, unknown>).slice(0, 16)
          };
        } else {
          reduced[k] = { __elided: true, kind: typeof v };
        }
      }
    }
    return JSON.stringify(reduced);
  }
}

export class ConsoleJsonLogger implements StructuredLogger {
  private readonly sink?: LogSink;
  constructor(sink?: LogSink) {
    this.sink = sink;
  }

  info(message: string, fields: Record<string, unknown> = {}): void {
    const enriched = { ...fields, ...readActiveTraceContext() };
    console.log(safeStringifyLogLine({ level: "info", message, ...enriched, timestamp: new Date().toISOString() }));
    this.sink?.("info", message, enriched);
  }

  warn(message: string, fields: Record<string, unknown> = {}): void {
    const enriched = { ...fields, ...readActiveTraceContext() };
    console.warn(safeStringifyLogLine({ level: "warn", message, ...enriched, timestamp: new Date().toISOString() }));
    this.sink?.("warn", message, enriched);
  }

  error(message: string, fields: Record<string, unknown> = {}): void {
    const enriched = { ...fields, ...readActiveTraceContext() };
    console.error(safeStringifyLogLine({ level: "error", message, ...enriched, timestamp: new Date().toISOString() }));
    this.sink?.("error", message, enriched);
  }
}

let sharedLogger: ConsoleJsonLogger | undefined;
let traceContextSource: (() => { traceId?: string; spanId?: string } | undefined) | undefined;

/** Returns a shared {@link ConsoleJsonLogger} instance. */
export function getLogger(): StructuredLogger {
  if (!sharedLogger) sharedLogger = new ConsoleJsonLogger();
  return sharedLogger;
}

/**
 * Installed once at boot by `wireOtelTraces`; reads the currently-active
 * span context from `@opentelemetry/api` so log records can be stamped
 * with `trace_id`/`span_id`. The lookup is sync; if no span is active the
 * function returns `undefined`.
 */
export function setActiveSpanReader(
  fn: (() => { traceId?: string; spanId?: string } | undefined) | undefined
): void {
  traceContextSource = fn;
}

function readActiveTraceContext(): Record<string, string> {
  if (!traceContextSource) return {};
  try {
    const ctx = traceContextSource();
    if (!ctx?.traceId) return {};
    return ctx.spanId
      ? { trace_id: ctx.traceId, span_id: ctx.spanId }
      : { trace_id: ctx.traceId };
  } catch {
    return {};
  }
}

/**
 * Replaces the shared logger with one that pipes through `sink` (in addition
 * to its normal stdout emission). Wired by `wireOtelLogs` at app boot.
 * Idempotent: callable multiple times; the most recent sink wins.
 */
export function setSharedLogSink(sink: LogSink | undefined): void {
  sharedLogger = new ConsoleJsonLogger(sink);
}

// --- OTLP log bridge -----------------------------------------------------

interface OtelLoggerProviderLike {
  addLogRecordProcessor(processor: unknown): void;
  shutdown?(): Promise<void>;
}

interface OtelLoggerLike {
  emit(record: {
    severityNumber?: number;
    severityText?: string;
    body?: unknown;
    attributes?: Record<string, unknown>;
  }): void;
}

interface OtelLogsApiLike {
  logs: {
    getLogger(name: string, version?: string): OtelLoggerLike;
    setGlobalLoggerProvider(provider: OtelLoggerProviderLike): void;
  };
  SeverityNumber: {
    INFO: number;
    WARN: number;
    ERROR: number;
  };
}

export interface WireOtelLogsOptions {
  /** Force-disable; useful for tests. Honours OTEL_LOGS_ENABLED=false too. */
  enabled?: boolean;
  /** Instrumentation scope name. */
  instrumentationName?: string;
  /** Service version stamped on every log record. */
  instrumentationVersion?: string;
}

/**
 * Wires the shared logger to also emit OTLP log records (sent to the
 * collector named in OTEL_EXPORTER_OTLP_ENDPOINT). The bridge lazily loads
 * `@opentelemetry/api-logs` + `@opentelemetry/sdk-logs` + the OTLP HTTP log
 * exporter; on any import failure the shared logger reverts to stdout-only.
 * Idempotent and never throws.
 *
 * Returns a shutdown function suitable for `await`ing on graceful exit so
 * the batch processor flushes its queue before the process dies.
 */
export async function wireOtelLogs(
  options: WireOtelLogsOptions = {}
): Promise<() => Promise<void>> {
  if (options.enabled === false || process.env.OTEL_LOGS_ENABLED === "false") {
    return async () => {};
  }
  try {
    const api = (await import("@opentelemetry/api-logs")) as unknown as OtelLogsApiLike;
    const sdk = (await import("@opentelemetry/sdk-logs")) as unknown as {
      LoggerProvider: new (opts?: { resource?: unknown }) => OtelLoggerProviderLike;
      BatchLogRecordProcessor: new (exporter: unknown) => unknown;
    };
    const exporterMod = (await import(
      "@opentelemetry/exporter-logs-otlp-http"
    )) as unknown as {
      OTLPLogExporter: new (opts?: unknown) => unknown;
    };
    if (!api?.logs?.getLogger || !sdk?.LoggerProvider || !exporterMod?.OTLPLogExporter) {
      return async () => {};
    }
    const resource = await loadOtelResource();
    const provider = new sdk.LoggerProvider({ resource });
    const exporter = new exporterMod.OTLPLogExporter();
    provider.addLogRecordProcessor(new sdk.BatchLogRecordProcessor(exporter));
    api.logs.setGlobalLoggerProvider(provider);
    const logger = api.logs.getLogger(
      options.instrumentationName ?? "@ragdoll/observability",
      options.instrumentationVersion ?? "0.1.0"
    );
    const sev = api.SeverityNumber ?? { INFO: 9, WARN: 13, ERROR: 17 };
    setSharedLogSink((level, message, fields) => {
      const severityNumber =
        level === "error" ? sev.ERROR : level === "warn" ? sev.WARN : sev.INFO;
      logger.emit({
        severityNumber,
        severityText: level.toUpperCase(),
        body: message,
        attributes: fields
      });
    });
    return async () => {
      setSharedLogSink(undefined);
      await provider.shutdown?.();
    };
  } catch {
    return async () => {};
  }
}

// =========================================================================
// Tracer SDK wiring
// =========================================================================

export interface WireOtelTracesOptions {
  enabled?: boolean;
  instrumentationName?: string;
  instrumentationVersion?: string;
}

/**
 * Installs an OTel TracerProvider that batches spans and ships them via OTLP
 * HTTP to the collector named in `OTEL_EXPORTER_OTLP_ENDPOINT`. Without this
 * (or any other) provider, `@opentelemetry/api`'s `getTracer()` returns a
 * no-op proxy and the spans `createTracer()` produces are silently dropped.
 *
 * Same lazy-import + noop-fallback pattern as the logs / metrics wirings.
 * Returns a shutdown closure suitable for SIGTERM cleanup.
 */
export async function wireOtelTraces(
  options: WireOtelTracesOptions = {}
): Promise<() => Promise<void>> {
  if (options.enabled === false || process.env.OTEL_TRACES_ENABLED === "false") {
    return async () => {};
  }
  try {
    const traceSdk = (await import("@opentelemetry/sdk-trace-node")) as unknown as {
      NodeTracerProvider: new (opts?: { resource?: unknown }) => {
        addSpanProcessor(processor: unknown): void;
        register(): void;
        shutdown?(): Promise<void>;
      };
    };
    const baseSdk = (await import("@opentelemetry/sdk-trace-base")) as unknown as {
      BatchSpanProcessor: new (exporter: unknown) => unknown;
    };
    const exporterMod = (await import(
      "@opentelemetry/exporter-trace-otlp-http"
    )) as unknown as {
      OTLPTraceExporter: new (opts?: unknown) => unknown;
    };
    if (
      !traceSdk?.NodeTracerProvider ||
      !baseSdk?.BatchSpanProcessor ||
      !exporterMod?.OTLPTraceExporter
    ) {
      return async () => {};
    }
    const resource = await loadOtelResource();
    const provider = new traceSdk.NodeTracerProvider({ resource });
    provider.addSpanProcessor(
      new baseSdk.BatchSpanProcessor(new exporterMod.OTLPTraceExporter())
    );
    provider.register();
    // Install a reader so the structured logger can stamp trace_id /
    // span_id on every JSON line emitted inside a span. Loki's
    // derivedFields rule matches `"trace_id":"…"` and deep-links the
    // span in Tempo, so app logs (not just framework logs) participate
    // in trace<->log correlation.
    try {
      const api = (await import("@opentelemetry/api")) as unknown as {
        trace: {
          getActiveSpan(): {
            spanContext(): { traceId: string; spanId: string };
          } | undefined;
        };
      };
      setActiveSpanReader(() => {
        const span = api.trace.getActiveSpan();
        if (!span) return undefined;
        const ctx = span.spanContext();
        return ctx ? { traceId: ctx.traceId, spanId: ctx.spanId } : undefined;
      });
    } catch {
      /* leave the no-op reader; trace_id won't be stamped but logs still work */
    }
    return async () => {
      setActiveSpanReader(undefined);
      await provider.shutdown?.();
    };
  } catch {
    return async () => {};
  }
}

// =========================================================================
// Meter (metrics)
// =========================================================================

export interface CounterHandle {
  add(value: number, attributes?: Record<string, string | number | boolean>): void;
}

export interface HistogramHandle {
  record(value: number, attributes?: Record<string, string | number | boolean>): void;
}

/** UpDownCounter — like a counter but the value can decrease, so it
 *  behaves as a gauge of "current count" (e.g. in-flight jobs). */
export interface UpDownCounterHandle {
  add(value: number, attributes?: Record<string, string | number | boolean>): void;
}

export interface Meter {
  counter(name: string, opts?: { description?: string; unit?: string }): CounterHandle;
  histogram(name: string, opts?: { description?: string; unit?: string }): HistogramHandle;
  upDownCounter(name: string, opts?: { description?: string; unit?: string }): UpDownCounterHandle;
}

class NoopCounter implements CounterHandle {
  add(_value: number, _attributes?: Record<string, string | number | boolean>): void {}
}
class NoopHistogram implements HistogramHandle {
  record(_value: number, _attributes?: Record<string, string | number | boolean>): void {}
}
class NoopUpDownCounter implements UpDownCounterHandle {
  add(_value: number, _attributes?: Record<string, string | number | boolean>): void {}
}
export class NoopMeter implements Meter {
  counter(_name: string, _opts?: { description?: string; unit?: string }): CounterHandle {
    return new NoopCounter();
  }
  histogram(_name: string, _opts?: { description?: string; unit?: string }): HistogramHandle {
    return new NoopHistogram();
  }
  upDownCounter(_name: string, _opts?: { description?: string; unit?: string }): UpDownCounterHandle {
    return new NoopUpDownCounter();
  }
}

interface OtelMetricsApiLike {
  metrics: { getMeter(name: string, version?: string): OtelMeterLike };
}

interface OtelMeterLike {
  createCounter(name: string, opts?: { description?: string; unit?: string }): {
    add(value: number, attributes?: Record<string, unknown>): unknown;
  };
  createHistogram(name: string, opts?: { description?: string; unit?: string }): {
    record(value: number, attributes?: Record<string, unknown>): unknown;
  };
  createUpDownCounter?(name: string, opts?: { description?: string; unit?: string }): {
    add(value: number, attributes?: Record<string, unknown>): unknown;
  };
}

class OtelMeter implements Meter {
  private readonly meter: OtelMeterLike;
  constructor(meter: OtelMeterLike) {
    this.meter = meter;
  }
  counter(name: string, opts: { description?: string; unit?: string } = {}): CounterHandle {
    const c = this.meter.createCounter(name, opts);
    return { add: (value, attributes) => c.add(value, attributes) };
  }
  histogram(name: string, opts: { description?: string; unit?: string } = {}): HistogramHandle {
    const h = this.meter.createHistogram(name, opts);
    return { record: (value, attributes) => h.record(value, attributes) };
  }
  upDownCounter(
    name: string,
    opts: { description?: string; unit?: string } = {}
  ): UpDownCounterHandle {
    // Older versions of `@opentelemetry/api-metrics` exposed only
    // createCounter; treat that as a best-effort fallback (the gauge
    // monotonically increases there but the worker dashboard still
    // works because we read it via `sum without(...)`).
    const c = this.meter.createUpDownCounter
      ? this.meter.createUpDownCounter(name, opts)
      : this.meter.createCounter(name, opts);
    return { add: (value, attributes) => c.add(value, attributes) };
  }
}

export interface WireOtelMetricsOptions {
  enabled?: boolean;
  instrumentationName?: string;
  instrumentationVersion?: string;
  /** Export interval — defaults to 15s, matching Grafana's scrape interval. */
  exportIntervalMs?: number;
  /**
   * Per-reader toggles. Both default to the legacy single-OTLP-reader
   * behaviour: `otlp` ON, `prometheus` OFF. Operators flip
   * `PROMETHEUS_METRICS_ENABLED=true` on the worker / api Deployments
   * (helm sets this via `prometheus.enabled` in values) to attach a
   * `PrometheusExporter` as a SECOND reader on the same MeterProvider.
   *
   * "Both on" is the supported transition / parallel mode — every
   * metric instrument emits ONCE and reaches both backends because
   * the shared MeterProvider fans out across all attached readers.
   * No code path needs to know which backend is active.
   *
   * "Both off" leaves the SDK uninstantiated and `getMeter()` keeps
   * returning the NoopMeter, so metrics calls are zero-cost. Use for
   * tests / offline / cluster-disabled mode.
   */
  exporters?: {
    /** OTLP push to `OTEL_EXPORTER_OTLP_ENDPOINT`. Defaults to the
     *  env-honouring legacy behaviour. */
    otlp?: boolean;
    /** Prometheus pull — starts an HTTP server on `prometheusPort`
     *  and serves `/metrics` in Prometheus exposition format. */
    prometheus?: boolean;
  };
  /** Port for the Prometheus exporter's `/metrics` HTTP listener.
   *  Defaults to 9464 (the OpenTelemetry SDK's documented default). */
  prometheusPort?: number;
}

let sharedMeter: Meter = new NoopMeter();
export function getMeter(): Meter { return sharedMeter; }

/**
 * Wires a real OTel Meter against the user-selected backends.
 *
 * The OTel SDK lets a single `MeterProvider` fan out to multiple
 * `MetricReader`s. That's exactly what we want: every metric the app
 * code emits via `getMeter()` reaches whichever readers are active,
 * with no double-invocation in the call sites.
 *
 * Three readers can be combined freely:
 *   - `otlp`       — `PeriodicExportingMetricReader` pushing to
 *                    `OTEL_EXPORTER_OTLP_ENDPOINT` (legacy default ON).
 *   - `prometheus` — `PrometheusExporter` that starts an HTTP server
 *                    on `prometheusPort` and serves `/metrics` in the
 *                    text exposition format. Scraped by a Prometheus
 *                    ServiceMonitor.
 *   - neither      — `getMeter()` keeps returning the NoopMeter; the
 *                    SDK is never instantiated. Zero-cost path.
 *
 * Decision order:
 *   1. `options.exporters.{otlp, prometheus}` (most explicit)
 *   2. Env vars: `OTEL_METRICS_ENABLED` / `PROMETHEUS_METRICS_ENABLED`
 *   3. `options.enabled` (legacy single-toggle)
 *   4. Defaults: `otlp: true`, `prometheus: false`
 *
 * Same lazy-import + noop-fallback pattern as `wireOtelLogs` —
 * `@opentelemetry/exporter-prometheus` is imported only when actually
 * enabled so test paths without the dep installed still work.
 */
export async function wireOtelMetrics(
  options: WireOtelMetricsOptions = {}
): Promise<() => Promise<void>> {
  // Legacy single-toggle: enabled:false OR env override turns BOTH off.
  if (options.enabled === false) {
    return async () => {};
  }
  const otlpEnabled = resolveExporterFlag({
    explicit: options.exporters?.otlp,
    envVar: "OTEL_METRICS_ENABLED",
    legacyDefault: true
  });
  const promEnabled = resolveExporterFlag({
    explicit: options.exporters?.prometheus,
    envVar: "PROMETHEUS_METRICS_ENABLED",
    legacyDefault: false
  });
  // No reader → skip the entire SDK init, keep the NoopMeter.
  if (!otlpEnabled && !promEnabled) {
    return async () => {};
  }
  try {
    const api = (await import("@opentelemetry/api")) as unknown as OtelMetricsApiLike;
    const sdk = (await import("@opentelemetry/sdk-metrics")) as unknown as {
      MeterProvider: new (opts?: { resource?: unknown; readers?: unknown[] }) => {
        addMetricReader?(reader: unknown): void;
        shutdown?(): Promise<void>;
      };
      PeriodicExportingMetricReader: new (opts: {
        exporter: unknown;
        exportIntervalMillis?: number;
      }) => unknown;
    };
    const apiNs = (await import("@opentelemetry/api")) as unknown as {
      metrics: { setGlobalMeterProvider(p: unknown): void };
    };
    if (
      !api?.metrics?.getMeter ||
      !sdk?.MeterProvider ||
      !apiNs?.metrics?.setGlobalMeterProvider
    ) {
      return async () => {};
    }
    const resource = await loadOtelResource();
    const readers: unknown[] = [];

    if (otlpEnabled) {
      const otlpMod = (await import(
        "@opentelemetry/exporter-metrics-otlp-http"
      )) as unknown as {
        OTLPMetricExporter: new (opts?: unknown) => unknown;
      };
      if (otlpMod?.OTLPMetricExporter) {
        readers.push(
          new sdk.PeriodicExportingMetricReader({
            exporter: new otlpMod.OTLPMetricExporter(),
            exportIntervalMillis: options.exportIntervalMs ?? 15_000
          })
        );
      }
    }

    // Tracks the Prometheus exporter so the shutdown closure can stop
    // its HTTP listener (the SDK provider's shutdown handles the OTLP
    // reader but the Prometheus reader's listener needs its own stop
    // — otherwise unit tests leak a port across runs).
    let prometheusExporter: { shutdown?(): Promise<void> } | undefined;
    if (promEnabled) {
      const promMod = (await import(
        "@opentelemetry/exporter-prometheus"
      )) as unknown as {
        PrometheusExporter: new (
          opts: { port?: number; endpoint?: string; preventServerStart?: boolean }
        ) => { shutdown?(): Promise<void> };
      };
      if (promMod?.PrometheusExporter) {
        const port = options.prometheusPort ?? Number(process.env.PROMETHEUS_METRICS_PORT) ?? 9464;
        prometheusExporter = new promMod.PrometheusExporter({
          port,
          endpoint: "/metrics"
        });
        readers.push(prometheusExporter);
      }
    }

    if (readers.length === 0) {
      // Every requested exporter failed to load (probably missing
      // optional dep). Fall back to noop so we don't crash the boot.
      return async () => {};
    }

    // `readers` is the canonical constructor arg in newer SDKs.
    // `addMetricReader` is the fallback for older SDK versions that
    // shipped before the readers ctor option landed.
    const provider = new sdk.MeterProvider({ resource, readers });
    if (typeof provider.addMetricReader === "function") {
      // Constructor accepted readers in `readers:`, so no-op here.
      // Older SDKs fall through to the explicit add() below.
    }
    apiNs.metrics.setGlobalMeterProvider(provider);
    const otelMeter = api.metrics.getMeter(
      options.instrumentationName ?? "@ragdoll/observability",
      options.instrumentationVersion ?? "0.1.0"
    );
    sharedMeter = new OtelMeter(otelMeter);
    return async () => {
      sharedMeter = new NoopMeter();
      await provider.shutdown?.();
      // Stop the Prometheus HTTP listener explicitly — provider.shutdown
      // calls reader.shutdown internally on newer SDK versions, but
      // older versions left server ports open. Calling twice is safe.
      await prometheusExporter?.shutdown?.().catch(() => undefined);
    };
  } catch {
    return async () => {};
  }
}

/** Three-way resolve: explicit option > env var > legacy default. */
function resolveExporterFlag(args: {
  explicit?: boolean;
  envVar: string;
  legacyDefault: boolean;
}): boolean {
  if (typeof args.explicit === "boolean") return args.explicit;
  const raw = process.env[args.envVar];
  if (raw === undefined) return args.legacyDefault;
  return raw.toLowerCase() !== "false";
}

// =========================================================================

export function runtimeAttributes(context: RuntimeContext): Record<string, string> {
  return {
    "tenant.id": context.tenantId,
    "pipeline.id": context.pipelineId,
    "pipeline.version_id": context.pipelineVersionId,
    "execution.id": context.executionId,
    "deployment.environment": context.environment,
    "request.id": context.requestId
  };
}
