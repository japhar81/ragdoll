/**
 * NATS JetStream transport adapter for the RAGdoll worker queue (ADR 0004
 * amendment — replaces the BullMQ/Redis queue).
 *
 * `@nats-io/transport-node` + `@nats-io/jetstream` are imported lazily inside
 * methods only, so importing this module never pulls in those packages.
 * Nothing on the offline test path imports this file; only the production
 * entrypoints (`apps/worker/src/main.ts`, `apps/api/src/server.ts`) do, and
 * only when NATS_URL is set. (Same lazy pattern the old `bullmq.ts` used.)
 *
 * Topology: one JetStream WORK-QUEUE stream captures `<name>.>` — a subject
 * per job type, e.g. `ragdoll-jobs.run_pipeline`. A single durable PULL
 * consumer is shared by every worker replica; JetStream load-balances
 * deliveries across them (the BullMQ "many workers, one queue" model).
 * Work-queue retention deletes a message the moment it's acked — the queue
 * semantic (not an event log).
 *
 * BullMQ-parity behaviours that NATS must replicate:
 *  - DEDUP: published with `Nats-Msg-Id = job.id` + a stream duplicate
 *    window, so the scheduler's reliance on jobId uniqueness (it enqueues
 *    fresh UUIDs but a double-fire within the window collapses) holds.
 *  - PER-JOB ATTEMPTS + EXPONENTIAL BACKOFF: the producer stamps `attempts`
 *    and `backoffMs` headers. On failure the consumer `term()`s once the
 *    delivery count reaches `attempts` (no redelivery — BullMQ's "move to
 *    failed" / dead-letter), else `nak()`s with exponential backoff.
 *    `run_pipeline` enqueues attempts:1 so a state-mutating run is never
 *    silently re-executed.
 *  - LONG JOBS: a `working()` heartbeat every ackWait/2 keeps a slow run
 *    (CPU Ollama can take minutes) from having its ack deadline expire and
 *    the message redelivered mid-flight.
 */

import type { QueueJob, QueuePort, QueueJobStatus } from "./index.ts";
import type { Worker } from "./handlers.ts";
import type { StructuredLogger } from "../../../packages/observability/src/index.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyModule = Record<string, any>;

const DEFAULT_QUEUE_NAME = "ragdoll-jobs";
/** Within this window a re-published job.id is a no-op (dedup). */
const DEFAULT_DUPLICATE_WINDOW_MS = 2 * 60_000;
/** Ack deadline; refreshed mid-job by a working() heartbeat. */
const DEFAULT_ACK_WAIT_MS = 5 * 60_000;
/** Hard ceiling on redeliveries — the per-job `attempts` header owns the
 *  real limit; this just caps a pathological always-nak loop. */
const DEFAULT_MAX_DELIVER_CEILING = 25;

const ATTEMPTS_HEADER = "x-ragdoll-attempts";
const BACKOFF_HEADER = "x-ragdoll-backoff-ms";
const JOB_ID_HEADER = "x-ragdoll-job-id";
const JOB_TYPE_HEADER = "x-ragdoll-job-type";

const msToNanos = (ms: number): number => Math.round(ms) * 1_000_000;
const subjectFor = (name: string, type: string): string => `${name}.${type}`;

/**
 * Pure redelivery policy — extracted so the BullMQ-parity retry/backoff math
 * is unit-testable without a live NATS server. Given the per-job `attempts`
 * budget and the current 1-based delivery count, decide whether to give up
 * (terminal — no more redelivery) or negative-ack with an exponential delay.
 */
export function decideRedelivery(opts: {
  attempts: number;
  deliveryCount: number;
  backoffMs: number;
}): { action: "term" | "nak"; delayMs?: number } {
  if (opts.deliveryCount >= opts.attempts) return { action: "term" };
  // 1st delivery → backoffMs, 2nd → 2×, 3rd → 4×, … (BullMQ exponential).
  const delayMs = opts.backoffMs * 2 ** (opts.deliveryCount - 1);
  return { action: "nak", delayMs };
}

/** Idempotently create-or-update the work-queue job stream. Shared by the
 *  producer (enqueue) and the consumer (which may start first). */
async function ensureJobStream(
  jsm: any,
  js: AnyModule,
  name: string
): Promise<void> {
  const config = {
    name,
    subjects: [`${name}.>`],
    retention: js.RetentionPolicy.Workqueue,
    storage: js.StorageType.File,
    duplicate_window: msToNanos(DEFAULT_DUPLICATE_WINDOW_MS)
  };
  try {
    await jsm.streams.add(config);
  } catch {
    // Already exists → reconcile subjects/retention idempotently.
    await jsm.streams.update(name, config).catch(() => undefined);
  }
}

export interface NatsQueueOptions {
  natsUrl: string;
  /** Logical queue name → stream name + subject prefix. Default
   *  "ragdoll-jobs" (matches WORKER_QUEUE_NAME / the old BullMQ default). */
  queueName?: string;
  /** Default attempts when a job doesn't carry its own. */
  attempts?: number;
  backoffMs?: number;
  /** Logs a `nats_connect_failed` line when a connection attempt is rejected
   *  (auth/reachability), so the failure lands in the log stream instead of
   *  only surfacing lazily via /readyz's queue check. */
  logger?: StructuredLogger;
}

// ---------------------------------------------------------------------------
// Connection auth + resilience.
// ---------------------------------------------------------------------------

/** The credential env vars an operator sets as a Secret. Read here so they
 *  don't have to be embedded in NATS_URL. */
export interface NatsAuthEnv {
  NATS_USER?: string;
  NATS_PASSWORD?: string;
  NATS_TOKEN?: string;
  /** Path to a JWT/nkey `.creds` file (mounted from a Secret). */
  NATS_CREDS?: string;
}

/** Minimal transport surface we depend on — lets tests inject a fake. */
export interface NatsTransportLike {
  connect: (opts: Record<string, unknown>) => Promise<unknown>;
  credsAuthenticator?: (creds: Uint8Array) => unknown;
}

/**
 * Layer NATS credentials from the environment onto base connect options.
 * Pure + synchronous for the common cases (user/pass, token).
 *
 * Why this exists: the client used to pass only `{ servers }`, so operators who
 * set NATS_USER / NATS_PASSWORD as separate Secret env vars (the natural thing)
 * had them silently ignored — every auth-required server rejected the anonymous
 * connection. Credentials already embedded in NATS_URL keep working; env values
 * layer on top only when present.
 */
export function withNatsAuth(
  base: Record<string, unknown>,
  env: NatsAuthEnv = process.env
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  const user = env.NATS_USER?.trim();
  if (user) {
    out.user = user;
    // A password can legitimately contain leading/trailing whitespace — never
    // trim it; only require that the variable is present.
    if (env.NATS_PASSWORD != null) out.pass = env.NATS_PASSWORD;
  }
  const token = env.NATS_TOKEN?.trim();
  if (token) out.token = token;
  return out;
}

/**
 * Connect to NATS with env-sourced credentials, logging (and rethrowing) on
 * failure. NATS_CREDS (a JWT/nkey creds FILE) is resolved here since it needs
 * an fs read + the authenticator. The error message (e.g.
 * "AUTHORIZATION_VIOLATION") is logged; the credential itself never is.
 */
export async function connectNats(
  transport: NatsTransportLike,
  base: { servers: string; name: string },
  deps: { logger?: StructuredLogger; env?: NatsAuthEnv } = {}
): Promise<any> {
  const env = deps.env ?? process.env;
  const opts = withNatsAuth({ ...base }, env);
  const credsPath = env.NATS_CREDS?.trim();
  if (credsPath && transport.credsAuthenticator) {
    const { readFileSync } = await import("node:fs");
    opts.authenticator = transport.credsAuthenticator(
      new TextEncoder().encode(readFileSync(credsPath, "utf8"))
    );
  }
  try {
    return await transport.connect(opts);
  } catch (e) {
    deps.logger?.warn?.("nats_connect_failed", {
      client: base.name,
      error: e instanceof Error ? e.message : String(e)
    });
    throw e;
  }
}

/**
 * A memoized async value that SELF-HEALS: if the underlying promise rejects,
 * the cache is dropped so the next `get()` retries.
 *
 * Plain promise memoization (`this.p ??= factory()`) caches a REJECTION
 * forever — a single failed NATS connect at boot would wedge the queue (and
 * therefore /readyz) until the pod restarted, even after the server recovered.
 * A successful value is cached normally; concurrent callers share one in-flight
 * attempt.
 */
export class RetryableLazy<T> {
  private promise?: Promise<T>;
  private readonly factory: () => Promise<T>;
  constructor(factory: () => Promise<T>) {
    this.factory = factory;
  }
  get(): Promise<T> {
    let p = this.promise;
    if (!p) {
      p = this.factory();
      this.promise = p;
      p.catch(() => {
        if (this.promise === p) this.promise = undefined;
      });
    }
    return p;
  }
  /** The cached promise if one exists, without creating it (for teardown). */
  peek(): Promise<T> | undefined {
    return this.promise;
  }
}

/**
 * `QueuePort` backed by a JetStream work-queue stream. Heavy deps are
 * resolved on first use and memoized. Only `enqueue` has real callers —
 * `cancel`/`status`/`retry`/`deadLetter` exist to satisfy the port but are
 * not supported by a work-queue (a message is gone the instant it's acked,
 * so there's no random-access job to mutate). They are documented no-ops;
 * nothing in the codebase calls them (cancellation flows through the
 * execution store + AbortSignal, not the queue).
 */
export class NatsJetStreamQueue implements QueuePort {
  private options: NatsQueueOptions;
  // Self-healing lazies: a failed connect (auth/reachability) drops the cache
  // so the next call — e.g. the next /readyz probe — retries instead of
  // replaying the rejection until the pod restarts.
  private readonly connLazy: RetryableLazy<{ transport: AnyModule; js: AnyModule; nc: any }>;
  private readonly jsClientLazy: RetryableLazy<any>;
  private readonly streamLazy: RetryableLazy<void>;

  constructor(options: NatsQueueOptions) {
    this.options = options;
    this.connLazy = new RetryableLazy(async () => {
      const transport = (await import("@nats-io/transport-node")) as AnyModule;
      const js = (await import("@nats-io/jetstream")) as AnyModule;
      const nc = await connectNats(
        transport as NatsTransportLike,
        { servers: this.options.natsUrl, name: "ragdoll-producer" },
        { logger: this.options.logger }
      );
      return { transport, js, nc };
    });
    this.jsClientLazy = new RetryableLazy(async () => {
      const { js, nc } = await this.connLazy.get();
      return js.jetstream(nc);
    });
    this.streamLazy = new RetryableLazy(async () => {
      const { js, nc } = await this.connLazy.get();
      const jsm = await js.jetstreamManager(nc);
      await ensureJobStream(jsm, js, this.name);
    });
  }

  private get name(): string {
    return this.options.queueName ?? DEFAULT_QUEUE_NAME;
  }

  private conn(): Promise<{ transport: AnyModule; js: AnyModule; nc: any }> {
    return this.connLazy.get();
  }

  private jsClient(): Promise<any> {
    return this.jsClientLazy.get();
  }

  private ensureStream(): Promise<void> {
    return this.streamLazy.get();
  }

  async enqueue<T>(job: QueueJob<T>): Promise<void> {
    await this.ensureStream();
    const { transport } = await this.conn();
    const client = await this.jsClient();
    const h = transport.headers();
    h.set(JOB_ID_HEADER, job.id);
    h.set(JOB_TYPE_HEADER, job.type);
    h.set(ATTEMPTS_HEADER, String(job.attempts ?? this.options.attempts ?? 3));
    h.set(BACKOFF_HEADER, String(job.backoffMs ?? this.options.backoffMs ?? 1000));
    const payload = new TextEncoder().encode(JSON.stringify(job.payload ?? null));
    await client.publish(subjectFor(this.name, job.type), payload, {
      msgID: job.id, // Nats-Msg-Id → dedup within the stream's duplicate window
      headers: h
    });
  }

  // --- vestigial QueuePort methods (no callers; see class doc) -------------
  async cancel(_id: string): Promise<void> {
    /* work-queue: no random-access job to remove. No-op. */
  }

  async status(_id: string): Promise<QueueJobStatus> {
    // A work-queue keeps no per-id state after ack; report "queued" as the
    // neutral default. Not called anywhere — present only for the port.
    return "queued";
  }

  async retry(_id: string): Promise<void> {
    /* redelivery is automatic via nak/ack_wait; manual retry is a no-op. */
  }

  async deadLetter(_id: string, _reason: string): Promise<void> {
    /* terminal handling happens in the consumer via term(). No-op here. */
  }

  /** Readiness probe — round-trips to the NATS server; throws if down. */
  async ping(): Promise<void> {
    const { nc } = await this.conn();
    await nc.flush();
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

export interface NatsConsumerOptions {
  natsUrl: string;
  queueName?: string;
  /** Shared durable consumer name — every replica binds to this one so
   *  JetStream load-balances across them. Default "ragdoll-workers". */
  durable?: string;
  concurrency?: number;
  ackWaitMs?: number;
  logger?: StructuredLogger;
}

/**
 * Binds `worker.handle` to a JetStream pull consumer. Returns a handle
 * exposing `close()`. Mirrors `startBullMqConsumer`: a fresh AbortController
 * per message, structured start/complete/fail logs, bounded concurrency.
 */
export async function startNatsConsumer(
  worker: Worker,
  options: NatsConsumerOptions
): Promise<{ close(): Promise<void> }> {
  const transport = (await import("@nats-io/transport-node")) as AnyModule;
  const js = (await import("@nats-io/jetstream")) as AnyModule;
  const nc = await connectNats(
    transport as NatsTransportLike,
    { servers: options.natsUrl, name: "ragdoll-consumer" },
    { logger: options.logger }
  );
  const name = options.queueName ?? DEFAULT_QUEUE_NAME;
  const durable = options.durable ?? "ragdoll-workers";
  const concurrency = options.concurrency ?? 4;
  const ackWaitMs = options.ackWaitMs ?? DEFAULT_ACK_WAIT_MS;
  const logger = options.logger;

  const jsm = await js.jetstreamManager(nc);
  await ensureJobStream(jsm, js, name);
  const consumerConfig = {
    durable_name: durable,
    ack_policy: js.AckPolicy.Explicit,
    ack_wait: msToNanos(ackWaitMs),
    max_deliver: DEFAULT_MAX_DELIVER_CEILING,
    filter_subject: `${name}.>`,
    max_ack_pending: Math.max(concurrency * 2, concurrency)
  };
  try {
    await jsm.consumers.add(name, consumerConfig);
  } catch {
    await jsm.consumers
      .update(name, durable, consumerConfig)
      .catch(() => undefined);
  }

  const client = js.jetstream(nc);
  const consumer = await client.consumers.get(name, durable);
  const messages = await consumer.consume({ max_messages: concurrency });

  // Bounded-concurrency drain: keep at most `concurrency` handlers in flight.
  const inflight = new Set<Promise<void>>();
  let stopped = false;

  const processOne = async (m: any): Promise<void> => {
    const h = m.headers;
    const jobId = h?.get(JOB_ID_HEADER) || String(m.seq);
    const type =
      h?.get(JOB_TYPE_HEADER) || m.subject.slice(name.length + 1) || m.subject;
    const attempts = Number(h?.get(ATTEMPTS_HEADER) || "3") || 3;
    const backoffMs = Number(h?.get(BACKOFF_HEADER) || "1000") || 1000;
    const deliveryCount = m.info.deliveryCount;

    let payload: unknown = null;
    try {
      payload = m.data.length ? JSON.parse(new TextDecoder().decode(m.data)) : null;
    } catch {
      // Undecodable payload is a permanent failure — terminate, don't retry.
      logger?.error("worker job bad_payload", { id: jobId, type });
      m.term();
      return;
    }
    const job: QueueJob = { id: jobId, type: type as QueueJob["type"], payload };
    const controller = new AbortController();
    // Heartbeat: extend the ack deadline while a long job runs.
    const heartbeat = setInterval(
      () => {
        try {
          m.working();
        } catch {
          /* message already settled */
        }
      },
      Math.max(1000, Math.floor(ackWaitMs / 2))
    );
    logger?.info("worker job started", { id: jobId, type, delivery: deliveryCount });
    try {
      await worker.handle(job, controller.signal);
      m.ack();
      logger?.info("worker job completed", { id: jobId, type });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const decision = decideRedelivery({ attempts, deliveryCount, backoffMs });
      if (decision.action === "term") {
        m.term();
        logger?.error("worker job dead_letter", {
          id: jobId,
          type,
          delivery: deliveryCount,
          attempts,
          error: reason
        });
      } else {
        m.nak(decision.delayMs);
        logger?.warn("worker job retry", {
          id: jobId,
          type,
          delivery: deliveryCount,
          attempts,
          delayMs: decision.delayMs,
          error: reason
        });
      }
    } finally {
      clearInterval(heartbeat);
    }
  };

  void (async () => {
    for await (const m of messages) {
      if (stopped) break;
      const p = processOne(m).finally(() => inflight.delete(p));
      inflight.add(p);
      if (inflight.size >= concurrency) {
        // Backpressure: don't pull the next message until a slot frees.
        await Promise.race(inflight).catch(() => undefined);
      }
    }
  })();

  logger?.info("worker consuming NATS JetStream queue", {
    stream: name,
    durable,
    concurrency
  });

  return {
    async close(): Promise<void> {
      stopped = true;
      try {
        messages.stop();
      } catch {
        /* already stopping */
      }
      await Promise.allSettled(inflight);
      await nc.drain().catch(() => undefined);
    }
  };
}
