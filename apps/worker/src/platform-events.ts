/**
 * Durable transport for the platform-plugin event bus (ADR 0036).
 *
 * `post` PlatformEvents are published to a JetStream stream `ragdoll.events`
 * (subject `ragdoll.events.<category>` — mutation | execution | usage, a
 * bounded token set that lets future consumers filter coarsely). A shared
 * durable pull consumer ("platform-hooks") fans them out to the in-process
 * dispatcher — shared across worker replicas so each event runs the observers
 * ONCE (not once per replica). LIMITS retention keeps a bounded window so
 * additional independent consumers (webhook delivery — Phase 1c) and replay
 * (Phase 3) can be layered without changing producers.
 *
 * `@nats-io/*` is lazy-imported (like the job queue's nats.ts) so nothing on
 * the offline test path loads it. When NATS_URL is unset the stream is
 * in-process (publish → deliver straight to the local dispatcher), which keeps
 * the single-process worker + tests working with no broker.
 */

import type { StructuredLogger } from "../../../packages/observability/src/index.ts";
import { connectNats, RetryableLazy, type NatsTransportLike } from "./nats.ts";
import type {
  PlatformEvent,
  PlatformEventDispatcher
} from "../../../packages/platform-plugins/src/index.ts";
import { inProcessEmitter } from "../../../packages/platform-plugins/src/index.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyModule = Record<string, any>;

const STREAM = "ragdoll_events";
const SUBJECT_ROOT = "ragdoll.events";
const DURABLE = "platform-hooks";
const RETENTION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h window (replay + late consumers)

export interface PlatformEventStream {
  /** Fire-and-forget publish of a `post` event. Never throws. */
  publish(event: PlatformEvent): void;
  /** Bind the dispatcher that runs the in-process observers. Returns a handle
   *  to stop consuming. */
  startConsumer(
    dispatcher: PlatformEventDispatcher
  ): Promise<{ close(): Promise<void> }>;
  close(): Promise<void>;
}

/** No-broker stream: publish delivers straight to the bound dispatcher. Used
 *  for the single-process worker / offline tests. */
class InProcessPlatformEventStream implements PlatformEventStream {
  private emit?: (e: PlatformEvent) => void;
  private logger?: StructuredLogger;
  constructor(logger?: StructuredLogger) {
    this.logger = logger;
  }
  publish(event: PlatformEvent): void {
    this.emit?.(event);
  }
  async startConsumer(
    dispatcher: PlatformEventDispatcher
  ): Promise<{ close(): Promise<void> }> {
    this.emit = inProcessEmitter(dispatcher, (e) =>
      this.logger?.warn?.("platform_event_deliver_failed", {
        error: e instanceof Error ? e.message : String(e)
      })
    );
    return { close: async () => undefined };
  }
  async close(): Promise<void> {
    this.emit = undefined;
  }
}

class NatsPlatformEventStream implements PlatformEventStream {
  private natsUrl: string;
  private logger?: StructuredLogger;
  // Self-healing lazies (see RetryableLazy) — a failed connect drops the cache
  // so a later publish/subscribe retries rather than replaying the rejection.
  private readonly connLazy: RetryableLazy<{ transport: AnyModule; js: AnyModule; nc: any }>;
  private readonly jsLazy: RetryableLazy<any>;
  private readonly streamLazy: RetryableLazy<void>;

  constructor(natsUrl: string, logger?: StructuredLogger) {
    this.natsUrl = natsUrl;
    this.logger = logger;
    this.connLazy = new RetryableLazy(async () => {
      const transport = (await import("@nats-io/transport-node")) as AnyModule;
      const js = (await import("@nats-io/jetstream")) as AnyModule;
      const nc = await connectNats(
        transport as NatsTransportLike,
        { servers: this.natsUrl, name: "ragdoll-platform-events" },
        { logger: this.logger }
      );
      return { transport, js, nc };
    });
    this.jsLazy = new RetryableLazy(async () => {
      const { js, nc } = await this.connLazy.get();
      return js.jetstream(nc);
    });
    this.streamLazy = new RetryableLazy(async () => {
      const { js, nc } = await this.connLazy.get();
      const jsm = await js.jetstreamManager(nc);
      const config = {
        name: STREAM,
        subjects: [`${SUBJECT_ROOT}.>`],
        retention: js.RetentionPolicy.Limits,
        storage: js.StorageType.File,
        max_age: RETENTION_MAX_AGE_MS * 1_000_000 // nanos
      };
      try {
        await jsm.streams.add(config);
      } catch {
        await jsm.streams.update(STREAM, config).catch(() => undefined);
      }
    });
  }

  publish(event: PlatformEvent): void {
    // Fire-and-forget: never block or throw on the operation's hot path.
    void (async () => {
      try {
        await this.streamLazy.get();
        const client = await this.jsLazy.get();
        const payload = new TextEncoder().encode(JSON.stringify(event));
        await client.publish(`${SUBJECT_ROOT}.${event.category}`, payload, {
          msgID: event.id
        });
      } catch (e) {
        this.logger?.warn?.("platform_event_publish_failed", {
          event: event.event,
          error: e instanceof Error ? e.message : String(e)
        });
      }
    })();
  }

  async startConsumer(
    dispatcher: PlatformEventDispatcher
  ): Promise<{ close(): Promise<void> }> {
    const { js, nc } = await this.connLazy.get();
    const jsm = await js.jetstreamManager(nc);
    await this.streamLazy.get();
    const consumerConfig = {
      durable_name: DURABLE,
      ack_policy: js.AckPolicy.Explicit,
      filter_subject: `${SUBJECT_ROOT}.>`,
      max_ack_pending: 256
    };
    try {
      await jsm.consumers.add(STREAM, consumerConfig);
    } catch {
      await jsm.consumers.update(STREAM, DURABLE, consumerConfig).catch(() => undefined);
    }
    const client = await this.jsLazy.get();
    const consumer = await client.consumers.get(STREAM, DURABLE);
    const messages = await consumer.consume({ max_messages: 64 });
    const dec = new TextDecoder();
    let stopped = false;

    void (async () => {
      for await (const m of messages) {
        if (stopped) break;
        try {
          const event = JSON.parse(dec.decode(m.data)) as PlatformEvent;
          // deliver() is isolated (never throws) — always ack; per-hook
          // retry/DLQ is Phase 3.
          await dispatcher.deliver(event);
        } catch (e) {
          this.logger?.warn?.("platform_event_consume_failed", {
            error: e instanceof Error ? e.message : String(e)
          });
        } finally {
          m.ack();
        }
      }
    })();

    this.logger?.info?.("platform_events_consuming", { stream: STREAM, durable: DURABLE });
    return {
      close: async () => {
        stopped = true;
        try {
          messages.stop();
        } catch {
          /* already stopping */
        }
      }
    };
  }

  async close(): Promise<void> {
    const cached = this.connLazy.peek();
    if (!cached) return; // never connected → nothing to drain
    try {
      const { nc } = await cached;
      await nc.drain().catch(() => undefined);
    } catch {
      /* connect had failed → no live connection to drain */
    }
  }
}

/** NATS-backed stream when NATS_URL is set, else the in-process fallback. */
export function createPlatformEventStream(opts: {
  natsUrl?: string;
  logger?: StructuredLogger;
}): PlatformEventStream {
  return opts.natsUrl
    ? new NatsPlatformEventStream(opts.natsUrl, opts.logger)
    : new InProcessPlatformEventStream(opts.logger);
}
