/**
 * Pure, DOM-free helpers backing the Builder's bottom Console panel.
 *
 * - `LogEntry` / `appendEntry` — a tiny ring-buffer reducer used by the
 *   logging hook; newest entries last, capped at MAX_ENTRIES.
 * - `summarizeRequest` — a redacted, human one-liner for an outgoing request
 *   body (so secrets / huge specs never bloat or leak into the log).
 * - `formatApiError` — turns an ApiError-shaped value, a network failure, or
 *   an unknown throw into a stable {message, code, status, issues} record.
 * - `isProbablyUuid` / `hasRealPipeline` — the doomed-run guard: is the
 *   builder pointed at a real saved/opened pipeline, or still the placeholder?
 *
 * No React/DOM imports so this is unit-testable with `node --test`, zero
 * install. Kept independent of api.ts (ApiError is structural, not nominal,
 * here) so the tests need no fetch shim.
 */

export type LogLevel = "info" | "success" | "warn" | "error";

export interface HttpMeta {
  method: string;
  /** Request path (may include a query string). */
  path: string;
  /** HTTP status once the response is known. */
  status?: number;
}

export interface LogEntry {
  /** Monotonic id (assigned by the store, unique within a session). */
  id: number;
  /** Epoch millis the entry was created. */
  ts: number;
  level: LogLevel;
  /** Short action label, e.g. "Run" or "Save failed". */
  label: string;
  /** Optional HTTP method/path/status badge data. */
  http?: HttpMeta;
  /** Optional expandable detail (pretty-printed when rendered). */
  detail?: unknown;
}

/** Hard cap so a long session can't grow the log unbounded. */
export const MAX_ENTRIES = 300;

export interface ConsoleState {
  entries: LogEntry[];
  /** Next id to hand out. */
  seq: number;
}

export function emptyConsole(): ConsoleState {
  return { entries: [], seq: 1 };
}

/**
 * Append an entry (assigning id from `seq` and a timestamp if absent),
 * trimming the oldest once over MAX_ENTRIES. Returns a new state object;
 * never mutates the input (React-reducer friendly).
 */
export function appendEntry(
  state: ConsoleState,
  entry: Omit<LogEntry, "id" | "ts"> & { ts?: number }
): ConsoleState {
  const next: LogEntry = {
    id: state.seq,
    ts: entry.ts ?? Date.now(),
    level: entry.level,
    label: entry.label,
    http: entry.http,
    detail: entry.detail
  };
  const entries = [...state.entries, next];
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
  return { entries, seq: state.seq + 1 };
}

/** Keys whose values are replaced with a placeholder in request summaries. */
const REDACT_KEYS = /^(secret|secrets|apikey|api_key|token|password|authorization)$/i;
const REDACTED = "[redacted]";

/** Render a single scalar compactly for the one-line request summary. */
function scalar(v: unknown): string {
  if (typeof v === "string") return v.length > 60 ? `${v.slice(0, 57)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null) return "null";
  return "";
}

/**
 * One-line, redacted summary of a request body for the "→ request" line.
 * Top-level secret-ish keys are masked; nested objects/arrays are collapsed
 * to a size hint rather than dumped (the full body still rides along as the
 * entry `detail`, where redaction is also applied — see `redact`).
 */
export function summarizeRequest(body: unknown): string {
  if (body === undefined) return "(no body)";
  if (body === null) return "null";
  if (typeof body === "string") {
    return body.length > 80 ? `${body.slice(0, 77)}… (${body.length} chars)` : body;
  }
  if (typeof body !== "object") return String(body);
  if (Array.isArray(body)) return `[${body.length} item${body.length === 1 ? "" : "s"}]`;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (REDACT_KEYS.test(k)) {
      parts.push(`${k}=${REDACTED}`);
    } else if (v !== null && typeof v === "object") {
      const n = Array.isArray(v) ? v.length : Object.keys(v as object).length;
      parts.push(`${k}={${Array.isArray(v) ? `${n} items` : `${n} keys`}}`);
    } else {
      parts.push(`${k}=${scalar(v)}`);
    }
  }
  return parts.length > 0 ? parts.join(", ") : "{}";
}

/**
 * Deep copy with secret-ish keys masked, for safe storage as entry detail.
 * Bounded recursion; arrays preserved; non-plain values passed through.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEYS.test(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

export interface FormattedError {
  /** Best human-readable sentence. */
  message: string;
  /** Server error code (e.g. "no_active_deployment") when present. */
  code?: string;
  /** HTTP status when this came from an ApiError. */
  status?: number;
  /** Validation issues when the server returned them. */
  issues?: unknown[];
  /** Coarse classification for the caller / styling. */
  kind: "api" | "network" | "unknown";
}

/** Anything with a numeric `.status` and a `.body` looks like our ApiError. */
function isApiErrorLike(e: unknown): e is { status: number; body: unknown; message?: string } {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { status?: unknown }).status === "number" &&
    "body" in e
  );
}

/** A fetch failure (offline / CORS / DNS) throws a TypeError, no status. */
function isNetworkError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /Failed to fetch|NetworkError|fetch failed|ECONNREFUSED|ENOTFOUND/i.test(msg);
}

function pickIssues(body: unknown): unknown[] | undefined {
  if (body && typeof body === "object" && "issues" in body) {
    const i = (body as { issues: unknown }).issues;
    if (Array.isArray(i)) return i;
    if (i !== undefined) return [i];
  }
  return undefined;
}

function bodyMessage(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const m = (body as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m;
  }
  if (typeof body === "string" && body.trim()) return body;
  return undefined;
}

function bodyCode(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const c = (body as { error?: unknown }).error;
    if (typeof c === "string" && c.trim()) return c;
  }
  return undefined;
}

/**
 * Normalize any thrown value into a stable, displayable error record.
 * Handles: our ApiError (status + structured {error,message,issues} body),
 * raw network failures ("API unreachable …"), and unknown throws. Robust to
 * any {error,message,issues} shape — never assumes the teammate's exact body.
 */
export function formatApiError(e: unknown): FormattedError {
  if (isApiErrorLike(e)) {
    const code = bodyCode(e.body);
    const msg =
      bodyMessage(e.body) ??
      (code ? `Server returned ${code}` : undefined) ??
      e.message ??
      `HTTP ${e.status}`;
    return {
      kind: "api",
      status: e.status,
      code,
      issues: pickIssues(e.body),
      message: msg
    };
  }
  if (isNetworkError(e)) {
    return {
      kind: "network",
      message: `API unreachable — ${
        e instanceof Error && e.message ? e.message : "the request never completed"
      }. Is the API running?`
    };
  }
  return {
    kind: "unknown",
    message: e instanceof Error ? e.message : String(e)
  };
}

/** One-line summary of a FormattedError for the log label/line. */
export function describeError(f: FormattedError): string {
  const bits: string[] = [];
  if (f.status !== undefined) bits.push(`HTTP ${f.status}`);
  if (f.code) bits.push(f.code);
  bits.push(f.message);
  if (f.issues && f.issues.length > 0) {
    bits.push(`(${f.issues.length} issue${f.issues.length === 1 ? "" : "s"})`);
  }
  return bits.join(" · ");
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical 8-4-4-4-12 UUID string (any version). */
export function isProbablyUuid(value: unknown): boolean {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

/**
 * Whether the builder is pointed at a real, saved/opened pipeline rather than
 * the default placeholder. A pipeline is "real" if it was opened from the
 * Pipelines tree (`openedViaTree`) OR its identifier is a UUID. The default
 * "support-rag" slug typed into a fresh builder is NOT real → Run should warn
 * before firing a doomed request.
 */
export function hasRealPipeline(args: {
  pipelineId: string;
  openedViaTree?: boolean;
}): boolean {
  if (args.openedViaTree) return true;
  return isProbablyUuid(args.pipelineId);
}
