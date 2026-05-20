/**
 * Per-invocation context shared by every command file. Holds the loaded
 * config and an `opts()` callback so commands can read global flags
 * (`--output`, `--tenant`, `--api-url`) that commander only populates after
 * `parseAsync` runs.
 */
import type { CliConfig } from "./config.ts";
import { authHeadersFor } from "./config.ts";
import { request, type HttpOptions, ApiError } from "./http.ts";
import { format, type OutputFormat } from "./format.ts";

export interface Ctx {
  config: CliConfig;
  opts: () => { output: string; apiUrl: string; tenant?: string };
}

/** Build the effective config for THIS invocation (root flags > saved). */
export function effectiveConfig(ctx: Ctx): CliConfig {
  const opts = ctx.opts();
  return {
    ...ctx.config,
    apiUrl: opts.apiUrl ?? ctx.config.apiUrl,
    tenantId: opts.tenant ?? ctx.config.tenantId
  };
}

/** A `fetch`-shaped helper bound to the effective config. */
export async function api<T = unknown>(
  ctx: Ctx,
  method: string,
  path: string,
  options: HttpOptions = {}
): Promise<T> {
  return request<T>(effectiveConfig(ctx), method, path, options);
}

/** Render a result with the requested output format. */
export function emit(ctx: Ctx, value: unknown): void {
  const fmt = (ctx.opts().output ?? "json") as OutputFormat;
  process.stdout.write(format(value, fmt) + "\n");
}

/** Map API errors to a clean stderr line + non-zero exit. */
export function fail(e: unknown, action: string): never {
  if (e instanceof ApiError) {
    process.stderr.write(
      `ragdoll: ${action} failed (HTTP ${e.status}${e.code ? " " + e.code : ""}): ${e.message}\n`
    );
    process.exit(2);
  }
  process.stderr.write(
    `ragdoll: ${action} failed: ${e instanceof Error ? e.message : String(e)}\n`
  );
  process.exit(2);
}

/** Side-effect: dump the auth headers we'd send, for diagnostics. */
export function debugAuthHeaders(ctx: Ctx): Record<string, string> {
  return authHeadersFor(effectiveConfig(ctx));
}
