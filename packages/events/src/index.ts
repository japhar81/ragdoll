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
  /** ISO timestamp the event occurred. */
  at: string;
  /** Optional, non-secret structured payload. */
  payload?: Record<string, unknown>;
}

export type ChangeEventHandler = (event: ChangeEvent) => void;

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
