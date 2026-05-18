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
  setAttribute(): void {}
  recordException(): void {}
  end(): void {}
}

export class NoopTracer implements Tracer {
  startSpan(): SpanHandle {
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

let sharedLogger: ConsoleJsonLogger | undefined;

/** Returns a shared {@link ConsoleJsonLogger} instance. */
export function getLogger(): StructuredLogger {
  if (!sharedLogger) sharedLogger = new ConsoleJsonLogger();
  return sharedLogger;
}

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

export interface StructuredLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export class ConsoleJsonLogger implements StructuredLogger {
  info(message: string, fields: Record<string, unknown> = {}): void {
    console.log(JSON.stringify({ level: "info", message, ...fields, timestamp: new Date().toISOString() }));
  }

  warn(message: string, fields: Record<string, unknown> = {}): void {
    console.warn(JSON.stringify({ level: "warn", message, ...fields, timestamp: new Date().toISOString() }));
  }

  error(message: string, fields: Record<string, unknown> = {}): void {
    console.error(JSON.stringify({ level: "error", message, ...fields, timestamp: new Date().toISOString() }));
  }
}
