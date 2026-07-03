/**
 * The `PlatformEvent` envelope — the wire vocabulary every platform plugin
 * (hook) speaks. It is a dependency-free SUPERSET of `@ragdoll/events`'
 * `ChangeEvent`, so a single emission can feed BOTH the durable platform
 * stream (for hooks) AND the ephemeral change bus (for the live UI) — see
 * {@link toChangeEvent}.
 *
 * Three families share the base envelope, discriminated by `category`:
 *   - `mutation`  — a resource changed (the 72 audited actions). before/after.
 *   - `execution` — the pipeline-run lifecycle bracket (accept → start →
 *                   finish → success/failure/denied/cancelled).
 *   - `usage`     — a metered LLM/embedding/ingestion cost was recorded.
 *
 * Every event has a `phase`: `pre` (synchronous, interceptable — a hook may
 * veto/mutate) or `post` (observational, delivered durably + async). `pre`
 * and `post` of the SAME operation share a `correlationId` so a hook can
 * bracket them (open a span/txn on pre, close on post).
 *
 * SECURITY: `post` payloads are broadcast to matching hooks + webhooks.
 * Redact upstream — never put secrets, password hashes, or raw keys here.
 */

export type EventCategory = "mutation" | "execution" | "usage";
export type EventPhase = "pre" | "post";

/** Terminal + interim states a pipeline run passes through. */
export type ExecutionStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "denied"
  | "cancelled";

/** Who caused the event. `type` mirrors the auth Principal kind. */
export interface EventActor {
  id: string;
  type?: string;
  tenantId?: string;
}

/** The resource the event is about (`pipeline`, `secret`, `execution`, …). */
export interface EventTarget {
  type: string;
  id: string;
}

interface PlatformEventBase {
  /** Stable id for THIS event (dedupe across at-least-once redelivery). */
  id: string;
  /** Stable across the pre/post of the SAME operation: the executionId for
   *  execution events, the requestId (or target id) for mutations. Lets a
   *  hook correlate its own pre + post work. */
  correlationId: string;
  /** Dotted event name from the catalog: `pipeline.deploy`, `secret.delete`,
   *  `execution.start`, `usage.recorded`, … */
  event: string;
  phase: EventPhase;
  category: EventCategory;
  /** ISO timestamp the event occurred. */
  at: string;
  actor: EventActor;
  /** Tenant the event belongs to; `null` = platform-level (only surfaced to
   *  global-scope hooks / never to a per-tenant webhook of another tenant). */
  tenantId: string | null;
  target: EventTarget;
  /** Permission a subscriber must hold to receive this event (reuses the
   *  api's SENSITIVE_ACTIONS gating). Untagged → visible to any subscriber
   *  the tenant filter admits. Free string to stay dependency-free. */
  requiredPermission?: string;
  requestId?: string;
  sourceIp?: string;
  userAgent?: string;
}

/** A resource mutation (one of the 72 audited actions). */
export interface MutationEvent extends PlatformEventBase {
  category: "mutation";
  /** Prior state (redacted on `post`). `undefined` on create. */
  before?: unknown;
  /** New state (redacted on `post`). `undefined` on delete. */
  after?: unknown;
}

/** A structural mirror of a usage record — kept local so this package stays
 *  dependency-free (the emitter maps its own UsageRecord onto this). */
export interface UsagePayload {
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  embeddingTokens?: number;
  estimatedCostUsd?: number;
  latencyMs?: number;
  success?: boolean;
}

/** The pipeline-run lifecycle bracket. */
export interface ExecutionEvent extends PlatformEventBase {
  category: "execution";
  executionId: string;
  pipelineId: string;
  versionId?: string;
  environment?: string;
  /** Run input — a `pre` hook on `execution.start` may rewrite this. */
  input?: unknown;
  /** Run output — a `pre` hook on `execution.finish` may rewrite this. */
  output?: unknown;
  status?: ExecutionStatus;
  error?: { message: string; code?: string };
}

/** A metered cost record. */
export interface UsageEvent extends PlatformEventBase {
  category: "usage";
  executionId?: string;
  pipelineId?: string;
  usage: UsagePayload;
}

export type PlatformEvent = MutationEvent | ExecutionEvent | UsageEvent;

/** Minimal shape of a `@ragdoll/events` ChangeEvent — declared locally so the
 *  mapping helper doesn't create a package dependency. */
export interface ChangeEventLike {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  tenantId: string | null;
  actorId: string | null;
  requiredPermission?: string;
  at: string;
  payload?: Record<string, unknown>;
}

/**
 * Project a `post` PlatformEvent onto a ChangeEvent so the SAME emission can
 * drive the existing live-UI bus. Only meaningful for `post` events (the UI
 * never sees interceptable `pre` phases).
 */
export function toChangeEvent(event: PlatformEvent): ChangeEventLike {
  const payload: Record<string, unknown> = {};
  if (event.category === "mutation") {
    if (event.before !== undefined) payload.before = event.before;
    if (event.after !== undefined) payload.after = event.after;
  } else if (event.category === "execution") {
    payload.executionId = event.executionId;
    payload.pipelineId = event.pipelineId;
    if (event.status) payload.status = event.status;
  } else {
    payload.usage = event.usage;
  }
  return {
    id: event.id,
    action: event.event,
    targetType: event.target.type,
    targetId: event.target.id,
    tenantId: event.tenantId,
    actorId: event.actor.id ?? null,
    ...(event.requiredPermission ? { requiredPermission: event.requiredPermission } : {}),
    at: event.at,
    payload
  };
}
