/**
 * Tiny `fetch` wrapper for the CLI: pulls credentials from the loaded config,
 * decodes JSON responses, and turns non-2xx replies into {@link ApiError} so
 * commands can branch on status / error code without inspecting the raw body.
 */
import type { CliConfig } from "./config.ts";
import { authHeadersFor } from "./config.ts";

export class ApiError extends Error {
  status: number;
  body: unknown;
  code?: string;
  constructor(status: number, body: unknown) {
    const b = (body ?? {}) as { error?: string; message?: string };
    super(b.message ?? b.error ?? `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.code = b.error;
  }
}

export interface HttpOptions {
  body?: unknown;
  /** Override / add request headers per call (e.g. for unauthenticated paths). */
  headers?: Record<string, string>;
  /** Skip the configured auth headers (used by `login` itself). */
  noAuth?: boolean;
  /** Request timeout in ms; default 30s. */
  timeoutMs?: number;
}

export async function request<T = unknown>(
  config: CliConfig,
  method: string,
  path: string,
  options: HttpOptions = {}
): Promise<T> {
  const url = new URL(path, config.apiUrl).toString();
  const headers: Record<string, string> = {
    ...(options.noAuth ? {} : authHeadersFor(config)),
    ...(options.headers ?? {})
  };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("request timeout")),
    options.timeoutMs ?? 30_000
  );
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  let parsed: unknown = text;
  if (text && contentType.includes("application/json")) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
  }
  if (!response.ok) throw new ApiError(response.status, parsed);
  return parsed as T;
}
