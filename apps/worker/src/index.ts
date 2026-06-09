/**
 * Shared queue contract for the RAGdoll worker.
 *
 * This module is intentionally dependency-free (no bullmq / ioredis / pg /
 * runtime imports) so it can be imported by the API app and by the offline
 * test suite without any install. Job handlers live in `./handlers.ts`; the
 * BullMQ adapter + production consumer live in `./bullmq.ts`; the production
 * entrypoint lives in `./main.ts`.
 */

export type QueueJobType =
  | "ingest_datasource"
  | "reindex_tenant"
  | "evaluate_pipeline"
  | "batch_run"
  | "delete_tenant_vector_data"
  | "rotate_provider_model_metadata"
  | "plugin_health_check"
  | "run_pipeline"
  // System sweep jobs — enqueued by the scheduler on un-deletable rows. The
  // worker picks them up through the same BullMQ concurrency pool, so they
  // run alongside pipelines without blocking either side.
  | "stale_exec_sweep"
  | "retention_sweep"
  // ADR-0021 — periodic probe sweep that exercises every non-archived
  // external connection's driver health check and stores the result on
  // the row so the Builder / admin UI can render badges. Job-shaped
  // (not in-process) so multiple workers cooperate via BullMQ's
  // single-runner-per-job guarantee.
  | "connection_probe_sweep";

export type QueueJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "dead_letter";

export interface QueueJob<T = unknown> {
  id: string;
  type: QueueJobType;
  payload: T;
  attempts?: number;
  backoffMs?: number;
}

export interface QueuePort {
  enqueue<T>(job: QueueJob<T>): Promise<void>;
  cancel(id: string): Promise<void>;
  status(id: string): Promise<QueueJobStatus>;
  retry(id: string): Promise<void>;
  deadLetter(id: string, reason: string): Promise<void>;
  /** Readiness probe — should resolve quickly when the queue's transport is
   * reachable, reject otherwise. Optional so in-process adapters can omit. */
  ping?(): Promise<void>;
}

interface InMemoryQueueEntry {
  job: QueueJob;
  status: QueueJobStatus;
  reason?: string;
}

/**
 * In-process queue used by tests and by the worker when no REDIS_URL is set.
 *
 * Beyond the {@link QueuePort} contract it exposes a cooperative `drain` helper
 * so tests can enqueue jobs and then run them through a handler synchronously.
 * `cancel` flips the status to `cancelled` and aborts the per-job
 * `AbortController` so an in-flight handler honoring `signal` stops promptly.
 */
export class InMemoryQueue implements QueuePort {
  private jobs = new Map<string, InMemoryQueueEntry>();
  private controllers = new Map<string, AbortController>();

  async enqueue<T>(job: QueueJob<T>): Promise<void> {
    this.jobs.set(job.id, { job: job as QueueJob, status: "queued" });
  }

  async cancel(id: string): Promise<void> {
    const item = this.jobs.get(id);
    if (item && item.status !== "completed") item.status = "cancelled";
    this.controllers.get(id)?.abort(new Error("job cancelled"));
  }

  async status(id: string): Promise<QueueJobStatus> {
    return this.jobs.get(id)?.status ?? "failed";
  }

  async retry(id: string): Promise<void> {
    const item = this.jobs.get(id);
    if (item) {
      item.status = "queued";
      item.reason = undefined;
      this.controllers.delete(id);
    }
  }

  async deadLetter(id: string, reason: string): Promise<void> {
    const item = this.jobs.get(id);
    if (item) {
      item.status = "dead_letter";
      item.reason = reason;
    }
  }

  // In-process queue is always reachable if the API process is running.
  async ping(): Promise<void> {}

  /** Test/inspection helper: the failure or dead-letter reason, if any. */
  reason(id: string): string | undefined {
    return this.jobs.get(id)?.reason;
  }

  /** Test/inspection helper: every enqueued job (in insertion order). */
  list(): QueueJob[] {
    return [...this.jobs.values()].map((entry) => entry.job);
  }

  /**
   * Returns (creating if needed) the AbortController bound to `jobId`. A
   * handler can read `.signal` to honor cooperative cancellation; `cancel`
   * aborts it.
   */
  controller(jobId: string): AbortController {
    let controller = this.controllers.get(jobId);
    if (!controller) {
      controller = new AbortController();
      this.controllers.set(jobId, controller);
    }
    return controller;
  }

  /**
   * Runs every `queued` job through `run`, transitioning status across
   * `running` -> `completed`/`failed`. A job that is `cancelled` before it
   * starts is skipped. Returns the per-job results keyed by job id.
   */
  async drain(
    run: (job: QueueJob, signal: AbortSignal) => Promise<unknown>
  ): Promise<Map<string, { status: QueueJobStatus; result?: unknown; error?: string }>> {
    const results = new Map<string, { status: QueueJobStatus; result?: unknown; error?: string }>();
    for (const [id, entry] of this.jobs) {
      if (entry.status !== "queued") {
        results.set(id, { status: entry.status });
        continue;
      }
      entry.status = "running";
      const controller = this.controller(id);
      try {
        const result = await run(entry.job, controller.signal);
        if ((entry.status as QueueJobStatus) === "cancelled") {
          results.set(id, { status: "cancelled", result });
        } else {
          entry.status = "completed";
          results.set(id, { status: "completed", result });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const aborted =
          controller.signal.aborted ||
          (error instanceof Error &&
            (error.name === "CancelledError" ||
              error.name === "DeadlineExceededError" ||
              error.name === "AbortError"));
        entry.status = aborted ? "cancelled" : "failed";
        entry.reason = message;
        results.set(id, { status: entry.status, error: message });
      }
    }
    return results;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Defer the heavyweight production wiring so this module stays import-light.
  import("./main.ts")
    .then((mod) => mod.main())
    .catch((error) => {
      console.error(
        JSON.stringify({
          level: "error",
          message: "worker failed to start",
          error: error instanceof Error ? error.message : String(error)
        })
      );
      process.exitCode = 1;
    });
}
