/**
 * Cron scheduler for org-versioned pipeline runs.
 *
 * `createScheduler(deps)` returns `{ tick, start }`. On each `tick()` it scans
 * the `ScheduleRepository` for due schedules and enqueues a `run_pipeline`
 * QueueJob WITHOUT a `pipelineVersionId`, so the worker's `resolveRunVersion`
 * (see `./handlers.ts`) resolves the effective version through the org
 * activation table at execution time. After enqueuing it advances the
 * schedule's `next_run_at` via `markRun`.
 *
 * This module is intentionally dependency-free (no bullmq / ioredis / pg /
 * runtime imports) so the offline test path stays install-free: it depends
 * only on the queue port, the schedule repository contract, and the
 * dependency-free cron evaluator.
 *
 * SINGLE-INSTANCE CAVEAT: this scheduler assumes exactly ONE active instance.
 * `listDue` + `markRun` are not transactionally fenced here, so running more
 * than one scheduler process against the same schedule table would
 * double-enqueue due schedules in the window before `markRun` lands. A
 * multi-worker deployment must add leader election (e.g. an advisory lock /
 * leased "scheduler" row) and only `start()` the scheduler on the leader.
 */

import { randomUUID } from "node:crypto";
import { nextAfter, parseCron } from "../../../packages/cron/src/index.ts";
import type {
  ScheduleRepository,
  ScheduleRow
} from "../../../packages/db/src/index.ts";
import type { StructuredLogger } from "../../../packages/observability/src/index.ts";
import type { QueuePort } from "./index.ts";
import type { QueueJob } from "./index.ts";
import type { RunPipelineJob } from "./handlers.ts";

export interface SchedulerDeps {
  schedules: ScheduleRepository;
  queue: QueuePort;
  /** Clock injection for deterministic tests; defaults to wall clock. */
  now?: () => Date;
  logger?: StructuredLogger;
}

export interface Scheduler {
  /** Enqueue every due schedule once and advance its `next_run_at`. */
  tick(): Promise<{ enqueued: number }>;
  /**
   * Prime null `next_run_at` for enabled schedules, then run `tick()` every
   * `intervalMs`. Returns a stop function that clears the interval.
   */
  start(intervalMs?: number): () => void;
  /**
   * Set `next_run_at` (via `markRun`, leaving `last_run_at` unchanged) for
   * every enabled schedule whose `next_run_at` is currently null. Idempotent.
   */
  prime(): Promise<{ primed: number }>;
}

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Builds the `run_pipeline` payload a due schedule enqueues. Deliberately
 * carries NO `pipelineVersionId`: the worker resolves the effective version
 * from the org activation table at run time (see `resolveRunVersion`). The
 * API teammate MUST enqueue this same shape for scheduled/activation-driven
 * runs so both paths resolve identically.
 */
function runPipelinePayload(schedule: ScheduleRow): RunPipelineJob {
  return {
    tenantId: schedule.tenantId,
    pipelineId: schedule.pipelineId,
    environment: schedule.environment,
    activationLabel: schedule.activationLabel ?? undefined,
    input: schedule.input ?? {},
    source: "schedule"
  };
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger;

  async function prime(): Promise<{ primed: number }> {
    const enabled = await deps.schedules.listEnabled();
    let primed = 0;
    for (const schedule of enabled) {
      if (schedule.nextRunAt !== null && schedule.nextRunAt !== undefined) {
        continue;
      }
      let nextIso: string;
      try {
        nextIso = nextAfter(schedule.cron, now(), schedule.timezone).toISOString();
      } catch (error) {
        logger?.warn("scheduler: skipping schedule with invalid cron during prime", {
          scheduleId: schedule.id,
          cron: schedule.cron,
          error: error instanceof Error ? error.message : String(error)
        });
        continue;
      }
      // Priming only touches next_run_at. We re-write last_run_at with its
      // CURRENT value so a never-run schedule stays null and a previously-run
      // one is preserved (markRun overwrites both columns). The repository
      // contract types lastRunIso as `string`; a primed row's lastRunAt is in
      // practice always null (it has no next_run_at yet), and the SQL/in-mem
      // markRun both accept null at runtime, so passing the existing value
      // through is the correct "unchanged" semantics.
      await deps.schedules.markRun(
        schedule.id,
        schedule.lastRunAt as string,
        nextIso
      );
      primed += 1;
    }
    if (primed > 0) logger?.info("scheduler primed schedules", { primed });
    return { primed };
  }

  async function tick(): Promise<{ enqueued: number }> {
    const at = now();
    const due = await deps.schedules.listDue(at.toISOString());
    let enqueued = 0;
    for (const schedule of due) {
      // Compute the next fire time first; a malformed stored expression must
      // not crash the whole tick (skip just this schedule).
      let nextIso: string | null;
      try {
        nextIso = nextAfter(schedule.cron, at, schedule.timezone).toISOString();
      } catch (error) {
        logger?.warn("scheduler: skipping due schedule with invalid cron", {
          scheduleId: schedule.id,
          cron: schedule.cron,
          error: error instanceof Error ? error.message : String(error)
        });
        continue;
      }

      const job: QueueJob<RunPipelineJob> = {
        id: randomUUID(),
        type: "run_pipeline",
        payload: runPipelinePayload(schedule)
      };
      await deps.queue.enqueue(job);
      await deps.schedules.markRun(schedule.id, at.toISOString(), nextIso);
      enqueued += 1;
      logger?.info("scheduler enqueued run_pipeline", {
        scheduleId: schedule.id,
        jobId: job.id,
        tenantId: schedule.tenantId,
        pipelineId: schedule.pipelineId,
        environment: schedule.environment,
        nextRunAt: nextIso
      });
    }
    return { enqueued };
  }

  function start(intervalMs: number = DEFAULT_INTERVAL_MS): () => void {
    // Prime null next_run_at, then begin the periodic tick. Errors inside the
    // interval are logged and swallowed so the loop keeps running.
    void prime()
      .then(() => tick())
      .catch((error) => {
        logger?.error("scheduler initial run failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    const handle = setInterval(() => {
      void tick().catch((error) => {
        logger?.error("scheduler tick failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, intervalMs);
    // Don't keep the process alive solely for the scheduler timer. Node's
    // timer handle exposes `unref()`; under DOM lib typings setInterval is
    // typed as `number`, so reach it through an unknown cast (no-op if absent).
    const timer = handle as unknown as { unref?: () => void };
    if (typeof timer.unref === "function") timer.unref();
    return () => clearInterval(handle);
  }

  return { tick, start, prime };
}
