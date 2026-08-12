/**
 * In-process and Redis-backed change-event bus.
 *
 * The API and worker publish a {@link ChangeEvent} every time they mutate a
 * resource or advance an execution; subscribed WebSocket clients receive a
 * filtered stream so the UI can react without polling. The interface is
 * deliberately tiny — `publish` + `subscribe` + `close` — so the rest of the
 * system can target it without caring whether the underlying transport is
 * in-process or Redis pubsub. Multi-replica installs (the default ops
 * topology) need the Redis adapter so events fan out across every API
 * instance; the in-process adapter is the no-install fallback used by the
 * offline test suites.
 */

/**
 * One observable change. The shape mirrors an audit row plus a free-form
 * payload, so the same record can be persisted for compliance AND streamed
 * to live clients without two parallel definitions.
 *
 * Payloads MUST be redacted upstream — anything published here is broadcast
 * to every subscribed connection (filtered only by tenant scope). Do NOT
 * include secrets, password hashes, or raw API keys.
 */
export interface ChangeEvent {
  /** Stable identifier so duplicate deliveries (during reconnect) can be
   *  de-duplicated client-side. */
  id: string;
  /**
   * Dotted action name, mirroring the audit log:
   * `tenant.create`, `pipeline.update`, `execution.started`, etc. The web UI
   * uses this to decide which React Query keys to invalidate.
   */
  action: string;
  /** Resource type the event is about — `tenant`, `pipeline`, `execution`, … */
  targetType: string;
  /** Resource id (uuid or slug). */
  targetId: string;
  /**
   * Tenant the event belongs to. `null` denotes a platform-level event
   * (tenant create, role catalog change, …) and is only forwarded to
   * principals with a global-scope grant.
   */
  tenantId: string | null;
  /** Principal id that caused the change. `null` for system-generated events. */
  actorId: string | null;
  /**
   * Optional permission required to receive this event. The WebSocket
   * fan-out drops events for subscribers whose scoped authorize closure
   * does not grant this permission at the event's tenant scope. Untagged
   * events remain visible to every subscriber the tenant filter admits.
   * Typed as a free string to keep this package dependency-free; consumers
   * cast to `Permission` from `@ragdoll/auth`.
   */
  requiredPermission?: string;
  /** ISO timestamp the event occurred. */
  at: string;
  /** Optional, non-secret structured payload. */
  payload?: Record<string, unknown>;
}

export type ChangeEventHandler = (event: ChangeEvent) => void;

// --- Execution result streaming (ADR-0037) ---------------------------------
//
// A "step frame" carries a single node's (redacted) output — or a payload a
// plugin pushed via ctx.emit — out to clients watching an execution's live
// stream. Frames ride the change bus as `execution.step` ChangeEvents (payload
// = a StepWireFrame) and are persisted to `execution_events` for replay. The
// full body is size-capped on the wire: large payloads travel as a preview +
// `truncated` flag, and the client fetches the whole thing by frameId from
// `GET /api/executions/:id/steps/:frameId`.

/** Max serialized size (bytes) of a step body sent inline on the wire. Larger
 *  bodies are truncated to a preview + `bytes`; the full body is fetched by
 *  frameId. 16 KiB keeps the change bus / SSE frames small without forcing a
 *  round-trip for ordinary step outputs. */
export const STEP_INLINE_MAX_BYTES = 16 * 1024;

/** Where a step frame's body came from. */
export type StepSource = "node_output" | "emit";

/** The on-the-wire shape of one streamed step (SSE `data:` and change-bus
 *  `payload`). Either `data` is present (small enough to inline) OR
 *  `truncated` is set with a `preview` + `bytes` and the client fetches the
 *  full body by `frameId`. */
export interface StepWireFrame {
  /** Stable per-frame id (also the execution_events row id) — used for
   *  replay/live dedup and as the fetch-by-ref key. */
  frameId: string;
  nodeId: string;
  /** Channel label (node.streamAs, the ctx.emit channel, or the node id). */
  channel: string;
  source: StepSource;
  /** Monotonic per-execution sequence, assigned by the runtime. */
  seq: number;
  at: string;
  /** Present when the redacted body fit under the inline cap. */
  data?: Record<string, unknown>;
  /** Set when the body was too large to inline. */
  truncated?: boolean;
  /** Byte size of the full serialized body (only when `truncated`). */
  bytes?: number;
  /** Short text preview of the full body (only when `truncated`). */
  preview?: string;
}

/** One persisted/emitted step, pre-capping. `data` is the full redacted body. */
export interface StepFrameBody {
  frameId: string;
  nodeId: string;
  channel: string;
  source: StepSource;
  seq: number;
  at: string;
  data: Record<string, unknown>;
}

/** How many characters of the serialized body to include as a preview when a
 *  step is too large to inline. */
const STEP_PREVIEW_CHARS = 512;

/**
 * Project a full step body onto its wire frame, inlining the body when it fits
 * under `maxBytes` and otherwise emitting a truncated preview. Pure + shared by
 * the worker (change-bus publish) and the API (SSE replay/live) so both cap
 * identically.
 */
export function toStepWireFrame(
  step: StepFrameBody,
  maxBytes = STEP_INLINE_MAX_BYTES
): StepWireFrame {
  const base = {
    frameId: step.frameId,
    nodeId: step.nodeId,
    channel: step.channel,
    source: step.source,
    seq: step.seq,
    at: step.at
  };
  const json = JSON.stringify(step.data ?? {});
  if (json.length <= maxBytes) return { ...base, data: step.data ?? {} };
  return {
    ...base,
    truncated: true,
    bytes: json.length,
    preview: json.slice(0, STEP_PREVIEW_CHARS)
  };
}

/**
 * Transport-agnostic change-event bus. Implementations MUST be safe to use
 * concurrently from many call sites; subscribers MUST NOT block the publish
 * path (handler errors are swallowed and logged).
 */
export interface ChangeBus {
  publish(event: ChangeEvent): Promise<void>;
  /** Subscribe to every event delivered to this bus. Returns an idempotent
   *  unsubscribe function. */
  subscribe(handler: ChangeEventHandler): () => void;
  /** Release any underlying resources (Redis clients). Idempotent. */
  close(): Promise<void>;
}

interface BusLogger {
  warn?(message: string, fields?: Record<string, unknown>): void;
  error?(message: string, fields?: Record<string, unknown>): void;
}

function safeInvoke(
  handler: ChangeEventHandler,
  event: ChangeEvent,
  logger?: BusLogger
): void {
  try {
    handler(event);
  } catch (e) {
    logger?.error?.("change_event_handler_failed", {
      action: event.action,
      error: e instanceof Error ? e.message : String(e)
    });
  }
}

/**
 * Pure in-process bus. One process publishes, the same process subscribes.
 * Used by every offline test and by single-replica deployments where Redis is
 * not wired. NOT safe across replicas — use {@link createRedisChangeBus}
 * there.
 */
export class InMemoryChangeBus implements ChangeBus {
  private handlers = new Set<ChangeEventHandler>();
  private logger?: BusLogger;

  constructor(options: { logger?: BusLogger } = {}) {
    this.logger = options.logger;
  }

  async publish(event: ChangeEvent): Promise<void> {
    // Snapshot so a handler unsubscribing during dispatch can't skip peers.
    for (const handler of [...this.handlers]) {
      safeInvoke(handler, event, this.logger);
    }
  }

  subscribe(handler: ChangeEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}

export interface RedisChangeBusOptions {
  redisUrl: string;
  /** Pubsub channel name. Defaults to `ragdoll:changes`. */
  channel?: string;
  logger?: BusLogger;
}

/**
 * Redis pubsub bus. Two `ioredis` connections (one publish, one subscribe) are
 * required because a subscribed connection cannot issue arbitrary commands.
 * `ioredis` is imported lazily so this module — and everything that imports
 * it — never pulls Redis into the dependency-free test paths.
 *
 * Both clients are constructed with `lazyConnect: true` and explicitly
 * connected before the factory returns, so a misconfigured `REDIS_URL`
 * surfaces immediately instead of as a flaky publish later.
 */
export async function createRedisChangeBus(
  options: RedisChangeBusOptions
): Promise<ChangeBus> {
  const channel = options.channel ?? "ragdoll:changes";
  const logger = options.logger;
  // Lazy-load ioredis to keep this package install-free for callers that
  // never construct a Redis bus.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ioredis: any = await import("ioredis");
  const Redis = ioredis.default ?? ioredis.Redis ?? ioredis;

  const pub = new Redis(options.redisUrl, { lazyConnect: true });
  const sub = new Redis(options.redisUrl, { lazyConnect: true });
  await pub.connect();
  await sub.connect();

  const handlers = new Set<ChangeEventHandler>();
  // Surface unexpected client errors instead of swallowing them. A real
  // outage will reconnect under ioredis's retry strategy; we only log so
  // operators can correlate with the rest of the platform.
  pub.on("error", (e: Error) =>
    logger?.warn?.("change_bus_redis_pub_error", { message: e.message })
  );
  sub.on("error", (e: Error) =>
    logger?.warn?.("change_bus_redis_sub_error", { message: e.message })
  );

  sub.on("message", (incoming: string, raw: string) => {
    if (incoming !== channel) return;
    let event: ChangeEvent;
    try {
      event = JSON.parse(raw) as ChangeEvent;
    } catch (e) {
      logger?.warn?.("change_bus_redis_bad_message", {
        message: e instanceof Error ? e.message : String(e)
      });
      return;
    }
    for (const handler of [...handlers]) safeInvoke(handler, event, logger);
  });
  await sub.subscribe(channel);

  let closed = false;
  return {
    async publish(event: ChangeEvent): Promise<void> {
      if (closed) return;
      await pub.publish(channel, JSON.stringify(event));
    },
    subscribe(handler: ChangeEventHandler): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      handlers.clear();
      try {
        await sub.unsubscribe(channel);
      } catch {
        /* best-effort */
      }
      try {
        await Promise.all([sub.quit(), pub.quit()]);
      } catch {
        /* best-effort */
      }
    }
  };
}

// --- WebSocket wire protocol -----------------------------------------------
//
// Both the API server and the web client import these so the message shapes
// can never drift. Keep the union small and explicit; the server discards any
// message whose `type` it doesn't recognise.

/** Client → Server. */
export type WsClientMessage =
  | {
      type: "auth";
      /** Bearer session token. */
      token?: string;
      /** API key (`rgd_<prefix>_<secret>`). */
      apiKey?: string;
    }
  | { type: "ping" }
  | { type: "builder:join"; pipelineId: string; focusNodeId?: string | null }
  | { type: "builder:leave"; pipelineId: string }
  | {
      type: "builder:presence";
      pipelineId: string;
      focusNodeId?: string | null;
    }
  | {
      type: "builder:edit";
      pipelineId: string;
      /** Full spec snapshot from the sender's editor. */
      spec: unknown;
      /** Per-node activity stamps used to bias the merge. */
      nodeStamps?: Record<string, string>;
    };

/** Server → Client. */
export type WsServerMessage =
  | {
      type: "ready";
      connectionId: string;
      principal: {
        id: string;
        type: string;
        tenantId: string | null;
      };
    }
  | { type: "pong" }
  | {
      type: "error";
      code: string;
      message: string;
    }
  | {
      type: "event";
      event: ChangeEvent;
    }
  | {
      type: "builder:roster";
      pipelineId: string;
      members: BuilderPresence[];
    }
  | {
      type: "builder:edit";
      pipelineId: string;
      edit: BuilderEdit;
    };

// --- Builder room (collaborative editing) ----------------------------------
//
// These types are exported as the wire contract for the Builder room channel
// the WS server multiplexes alongside ChangeEvents. They are NOT consumed by
// the bus implementation directly; both endpoints (web client + API
// WebSocket handler) import them so the shape stays in sync.

/** One editor present in a Builder room. */
export interface BuilderPresence {
  /** Stable per-WS-connection id (server-assigned). */
  connectionId: string;
  /** Principal id (user, api_key, or service). */
  principalId: string;
  /** Displayable label (email or display name). */
  label: string;
  /** Optional 1–2 char avatar initials derived by the server for the UI. */
  initials: string;
  /** ISO timestamp of last activity (focus change, edit, presence ping). */
  lastSeenAt: string;
  /** Optional id of the node the user is currently focused on. */
  focusNodeId?: string | null;
}

/** A spec change broadcast inside a Builder room. The payload is the full
 *  authoritative editor state from the sender; receivers apply a per-node
 *  last-writer-wins merge against their own pending state. */
export interface BuilderEdit {
  /** Pipeline being edited. */
  pipelineId: string;
  /** ISO timestamp the edit was applied locally. */
  at: string;
  /** Sender's connection id (echoed by the server; clients ignore their own). */
  fromConnectionId: string;
  /** Sender's display label (so the receiver can show "edited by X"). */
  fromLabel: string;
  /** Full pipeline spec at the moment of the edit. */
  spec: unknown;
  /** Optional per-node activity stamps (nodeId -> ISO ts) used to bias the
   *  merge: a node whose stamp is newer than the receiver's wins. */
  nodeStamps?: Record<string, string>;
}
