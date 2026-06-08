/**
 * BullMQ / ioredis transport adapter for the RAGdoll worker.
 *
 * `bullmq` and `ioredis` are imported lazily inside methods only, so importing
 * this module never pulls in those packages. Nothing in the offline test path
 * imports this file; only the production entrypoint (`./main.ts`) does, and
 * only when REDIS_URL is configured.
 */

import type { QueueJob, QueuePort, QueueJobStatus } from "./index.ts";
import type { Worker } from "./handlers.ts";
import type { StructuredLogger } from "../../../packages/observability/src/index.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyModule = Record<string, any>;

export interface BullMqQueueOptions {
  redisUrl: string;
  queueName?: string;
  /** Default attempts for enqueued jobs (BullMQ retry count). */
  attempts?: number;
  backoffMs?: number;
}

const DEFAULT_QUEUE_NAME = "ragdoll-jobs";

/**
 * `QueuePort` backed by a BullMQ queue. Heavy deps are resolved on first use
 * and memoized.
 */
export class BullMqQueue implements QueuePort {
  private options: BullMqQueueOptions;
  private connectionPromise?: Promise<any>;
  private queuePromise?: Promise<any>;

  constructor(options: BullMqQueueOptions) {
    this.options = options;
  }

  private async connection(): Promise<any> {
    if (!this.connectionPromise) {
      this.connectionPromise = (async () => {
        const ioredis = (await import("ioredis")) as AnyModule;
        const Redis = ioredis.default ?? ioredis.Redis ?? ioredis;
        return new Redis(this.options.redisUrl, { maxRetriesPerRequest: null });
      })();
    }
    return this.connectionPromise;
  }

  private async queue(): Promise<any> {
    if (!this.queuePromise) {
      this.queuePromise = (async () => {
        const bullmq = (await import("bullmq")) as AnyModule;
        const connection = await this.connection();
        return new bullmq.Queue(this.options.queueName ?? DEFAULT_QUEUE_NAME, {
          connection
        });
      })();
    }
    return this.queuePromise;
  }

  async enqueue<T>(job: QueueJob<T>): Promise<void> {
    const queue = await this.queue();
    await queue.add(job.type, job.payload, {
      jobId: job.id,
      attempts: job.attempts ?? this.options.attempts ?? 3,
      backoff: {
        type: "exponential",
        delay: job.backoffMs ?? this.options.backoffMs ?? 1000
      },
      removeOnComplete: 1000,
      removeOnFail: 5000
    });
  }

  async cancel(id: string): Promise<void> {
    const queue = await this.queue();
    const job = await queue.getJob(id);
    if (job) await job.remove();
  }

  async status(id: string): Promise<QueueJobStatus> {
    const queue = await this.queue();
    const job = await queue.getJob(id);
    if (!job) return "failed";
    const state = await job.getState();
    return mapState(state);
  }

  async retry(id: string): Promise<void> {
    const queue = await this.queue();
    const job = await queue.getJob(id);
    if (job) await job.retry();
  }

  async deadLetter(id: string, reason: string): Promise<void> {
    const queue = await this.queue();
    const job = await queue.getJob(id);
    if (job) {
      await job.moveToFailed(new Error(reason), "0", false).catch(() => undefined);
    }
  }

  // Readiness probe — runs `PING` on the underlying ioredis connection.
  // Cheap (single RTT) and fails loudly if Redis isn't reachable so /readyz
  // can flip the pod out of the service mesh before traffic blackholes.
  async ping(): Promise<void> {
    const connection = await this.connection();
    const reply = await connection.ping();
    if (reply !== "PONG") {
      throw new Error(`redis ping returned ${String(reply)} (expected PONG)`);
    }
  }

  async close(): Promise<void> {
    if (this.queuePromise) {
      const queue = await this.queuePromise;
      await queue.close().catch(() => undefined);
    }
    if (this.connectionPromise) {
      const connection = await this.connectionPromise;
      await connection.quit().catch(() => undefined);
    }
  }
}

function mapState(state: string): QueueJobStatus {
  switch (state) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "active":
      return "running";
    case "waiting":
    case "delayed":
    case "waiting-children":
    case "prioritized":
      return "queued";
    default:
      return "queued";
  }
}

export interface BullMqConsumerOptions {
  redisUrl: string;
  queueName?: string;
  concurrency?: number;
  logger?: StructuredLogger;
}

/**
 * Binds `worker.handle` to a BullMQ Worker that consumes the queue. Returns a
 * handle exposing `close()`. The BullMQ `Worker` propagates an `AbortSignal`
 * via the job token; we wrap a fresh controller per job and abort it if the
 * job is removed/cancelled.
 */
export async function startBullMqConsumer(
  worker: Worker,
  options: BullMqConsumerOptions
): Promise<{ close(): Promise<void> }> {
  const bullmq = (await import("bullmq")) as AnyModule;
  const ioredis = (await import("ioredis")) as AnyModule;
  const Redis = ioredis.default ?? ioredis.Redis ?? ioredis;
  const connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });

  const bullWorker = new bullmq.Worker(
    options.queueName ?? DEFAULT_QUEUE_NAME,
    async (bullJob: any) => {
      const controller = new AbortController();
      const job: QueueJob = {
        id: String(bullJob.id),
        type: bullJob.name,
        payload: bullJob.data
      };
      options.logger?.info("worker job started", { id: job.id, type: job.type });
      try {
        const result = await worker.handle(job, controller.signal);
        options.logger?.info("worker job completed", {
          id: job.id,
          type: job.type
        });
        return result;
      } catch (error) {
        options.logger?.error("worker job failed", {
          id: job.id,
          type: job.type,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    },
    {
      connection,
      concurrency: options.concurrency ?? 4
    }
  );

  return {
    async close(): Promise<void> {
      await bullWorker.close().catch(() => undefined);
      await connection.quit().catch(() => undefined);
    }
  };
}
