/**
 * Pure helpers + the request/response/route shapes the framework-
 * agnostic router uses. Lives next to app.ts so the createApp closure
 * can `import {…}` without paying for every other piece in the file.
 */

import type { AppResponse } from "./types.ts";

export const JSON_HEADERS = { "content-type": "application/json" };

export function ok(body: unknown, status = 200): AppResponse {
  return { status, body, headers: { ...JSON_HEADERS } };
}

export function error(
  status: number,
  code: string,
  extra: Record<string, unknown> = {}
): AppResponse {
  return { status, body: { error: code, ...extra }, headers: { ...JSON_HEADERS } };
}

export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Resolve the originating client IP from a request's headers, suitable for
 * a Postgres `inet` column on the audit log.
 *
 * X-Forwarded-For is a *list*: every proxy on the path appends itself, so
 * what arrives at the app is `<client>, <hop1>, <hop2>, ...`. The OpenShift
 * HAProxy router does this verbatim, which is what broke us — Postgres `inet`
 * rejects the comma-list with SQLSTATE 22P02 and the route surfaced a 400
 * `invalid_identifier` AFTER the pipeline had already enqueued. The leftmost
 * entry is the original client (per RFC 7239 / the de-facto XFF convention).
 *
 * Falls back to X-Real-IP (set by some ingress controllers) and finally to
 * undefined. We never want to surface a 400 because we couldn't write the
 * client IP — audit_logs.source_ip is nullable for exactly this reason.
 */
export function clientIp(
  headers: Record<string, string | string[] | undefined>
): string | undefined {
  const xff = headerValue(headers, "x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return headerValue(headers, "x-real-ip")?.trim() || undefined;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * A canonical UUID. Path params that don't match this are treated as a
 * pipeline slug/name (the web builder POSTs `/api/pipelines/<slug>/run`),
 * so they are NEVER passed into a Postgres `uuid` column query.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * True when a thrown error is a Postgres invalid-text-representation, i.e. a
 * value (often a slug) being cast to a typed column such as `uuid`. PG raises
 * SQLSTATE 22P02 with a message like
 * `invalid input syntax for type uuid: "support-rag"`. We surface these as a
 * clear 400 instead of a 500.
 */
export function isInvalidTextRepresentation(e: unknown): boolean {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  if (code === "22P02") return true;
  const msg =
    e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /invalid input syntax for type uuid/i.test(msg);
}

/** Decode a `{timestamp, id}` cursor; returns null on any parse failure
 *  so callers fall back to "start from the top". */
export function decodeCursor(
  raw: string | undefined
): { timestamp: string; id: string } | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    const parsed = JSON.parse(decoded) as { t?: string; i?: string };
    if (typeof parsed.t === "string" && typeof parsed.i === "string") {
      return { timestamp: parsed.t, id: parsed.i };
    }
    return null;
  } catch {
    return null;
  }
}

export function encodeCursor(timestamp: string, id: string): string {
  return Buffer.from(JSON.stringify({ t: timestamp, i: id })).toString(
    "base64url"
  );
}

/* -------------------------------------------------------------------------- */
/*  Route matcher                                                             */
/* -------------------------------------------------------------------------- */

export function compile(pattern: string): string[] {
  return pattern.split("/").filter((part) => part.length > 0);
}

interface RouteLike {
  method: string;
  segments: string[];
}

export function matchRoute(
  route: RouteLike,
  method: string,
  pathSegments: string[]
): Record<string, string> | undefined {
  if (route.method !== method) return undefined;
  if (route.segments.length !== pathSegments.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < route.segments.length; i += 1) {
    const seg = route.segments[i];
    if (seg.startsWith(":")) {
      params[seg.slice(1)] = decodeURIComponent(pathSegments[i]);
    } else if (seg !== pathSegments[i]) {
      return undefined;
    }
  }
  return params;
}
