/**
 * Two ExecutionStore decorators the worker stacks around its runtime
 * store. Composed outermost-first in createWorker:
 *
 *   PublishingExecutionStore        ← live-events broadcast
 *     UsageMirroringExecutionStore  ← /api/usage mirror (in-memory only)
 *       <real store>                ← Postgres or in-memory
 *
 * Pulled into its own file because both classes are pure decorators —
 * no createWorker closure state, no module-level helpers — so they
 * read more naturally next to each other than buried in handlers.ts.
 */

import { randomUUID } from "node:crypto";
import type {
  ExecutionStore,
  ExecutionRecord,
  ExecutionNodeRecord
} from "../../../../packages/runtime/src/index.ts";
import type { UsageRecord } from "../../../../packages/core/src/index.ts";
import type { ChangeBus } from "../../../../packages/events/src/index.ts";
import type { StructuredLogger } from "../../../../packages/observability/src/index.ts";
import type { UsageRecordRepository } from "../../../../packages/db/src/index.ts";
import type {
  PlatformEmitter,
  PlatformEvent
} from "../../../../packages/platform-plugins/src/index.ts";

/**
 * ExecutionStore decorator that mirrors every lifecycle write onto a
 * {@link ChangeBus} so the API can rebroadcast to subscribed WebSocket
 * clients. The publish is best-effort: a bus failure is logged but never
 * rolled back, so a transient Redis outage never breaks the run.
 */
export class PublishingExecutionStore implements ExecutionStore {
  private inner: ExecutionStore;
  private bus: ChangeBus;
  private logger?: StructuredLogger;
  /**
   * Optional platform-plugin emitter (ADR 0036). Fires the richer
   * `execution.start / finish / success / failure / denied / cancelled`
   * lifecycle events onto the durable platform stream, in ADDITION to the
   * ephemeral change-bus broadcast above. Fire-and-forget; never throws.
   */
  private emit?: PlatformEmitter;
  /**
   * Node records carry neither tenant nor actor; the parent execution does.
   * Cache both from `start()` so node events can be scoped correctly and
   * the live broadcast carries the enqueuing principal's id. Cleared on
   * `complete()` to keep the map bounded.
   */
  private metaByExecution = new Map<
    string,
    { tenantId: string; actorId: string | null }
  >();

  constructor(
    inner: ExecutionStore,
    bus: ChangeBus,
    logger?: StructuredLogger,
    emit?: PlatformEmitter
  ) {
    this.inner = inner;
    this.bus = bus;
    this.logger = logger;
    this.emit = emit;
  }

  /** Build + emit a `post` execution PlatformEvent (best-effort). */
  private emitExecution(
    event: string,
    record: ExecutionRecord,
    actorId: string | null
  ): void {
    if (!this.emit) return;
    const platformEvent: PlatformEvent = {
      id: randomUUID(),
      correlationId: record.executionId,
      event,
      phase: "post",
      category: "execution",
      at: new Date().toISOString(),
      actor: { id: actorId ?? "system", tenantId: record.tenantId },
      tenantId: record.tenantId ?? null,
      target: { type: "execution", id: record.executionId },
      executionId: record.executionId,
      pipelineId: record.pipelineId,
      versionId: record.pipelineVersionId,
      status: record.status
    };
    this.emit(platformEvent);
  }

  private async fire(
    action: string,
    targetId: string,
    tenantId: string | null | undefined,
    actorId: string | null,
    payload?: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.bus.publish({
        id: randomUUID(),
        action,
        targetType: "execution",
        targetId,
        tenantId: tenantId ?? null,
        actorId,
        at: new Date().toISOString(),
        payload
      });
    } catch (e) {
      this.logger?.warn?.("change_bus_publish_failed", {
        action,
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }

  async start(record: ExecutionRecord): Promise<void> {
    await this.inner.start(record);
    const actorId = record.actorId ?? null;
    this.metaByExecution.set(record.executionId, {
      tenantId: record.tenantId,
      actorId
    });
    await this.fire(
      "execution.started",
      record.executionId,
      record.tenantId,
      actorId,
      {
        pipelineId: record.pipelineId,
        pipelineVersionId: record.pipelineVersionId,
        status: record.status,
        startedAt: record.startedAt
      }
    );
    // Platform-plugin lifecycle: the run has started (post).
    this.emitExecution("execution.start", record, actorId);
  }

  async complete(record: ExecutionRecord): Promise<void> {
    await this.inner.complete(record);
    const action =
      record.status === "succeeded"
        ? "execution.completed"
        : record.status === "failed"
          ? "execution.failed"
          : record.status === "denied"
            ? "execution.denied"
            : "execution.updated";
    const meta = this.metaByExecution.get(record.executionId);
    await this.fire(
      action,
      record.executionId,
      record.tenantId,
      record.actorId ?? meta?.actorId ?? null,
      {
        pipelineId: record.pipelineId,
        pipelineVersionId: record.pipelineVersionId,
        status: record.status,
        completedAt: record.completedAt
      }
    );
    // Platform-plugin lifecycle: the run finished — `execution.finish` (post)
    // fires for every terminal status, plus the outcome-specialized event so
    // a hook can subscribe to just `execution.failure`, etc.
    const actorId = record.actorId ?? meta?.actorId ?? null;
    this.emitExecution("execution.finish", record, actorId);
    const outcome =
      record.status === "succeeded"
        ? "execution.success"
        : record.status === "failed"
          ? "execution.failure"
          : record.status === "denied"
            ? "execution.denied"
            : record.status === "cancelled"
              ? "execution.cancelled"
              : undefined;
    if (outcome) this.emitExecution(outcome, record, actorId);
    this.metaByExecution.delete(record.executionId);
  }

  async startNode(record: ExecutionNodeRecord): Promise<void> {
    await this.inner.startNode(record);
    const meta = this.metaByExecution.get(record.executionId);
    await this.fire(
      "execution.node.started",
      record.executionId,
      meta?.tenantId ?? null,
      meta?.actorId ?? null,
      {
        nodeId: record.nodeId,
        status: record.status,
        startedAt: record.startedAt
      }
    );
  }

  async completeNode(record: ExecutionNodeRecord): Promise<void> {
    await this.inner.completeNode(record);
    const meta = this.metaByExecution.get(record.executionId);
    await this.fire(
      "execution.node.completed",
      record.executionId,
      meta?.tenantId ?? null,
      meta?.actorId ?? null,
      {
        nodeId: record.nodeId,
        status: record.status,
        completedAt: record.completedAt
      }
    );
  }

  async recordUsage(record: UsageRecord): Promise<void> {
    await this.inner.recordUsage(record);
    if (this.emit) {
      this.emit({
        id: randomUUID(),
        correlationId: record.executionId ?? record.pipelineId,
        event: "usage.recorded",
        phase: "post",
        category: "usage",
        at: new Date().toISOString(),
        actor: { id: "system", tenantId: record.tenantId },
        tenantId: record.tenantId ?? null,
        target: { type: "execution", id: record.executionId ?? record.pipelineId },
        executionId: record.executionId,
        pipelineId: record.pipelineId,
        usage: {
          provider: record.provider,
          model: record.model,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          embeddingTokens: record.embeddingTokens,
          estimatedCostUsd: record.estimatedCostUsd,
          latencyMs: record.latencyMs,
          success: record.success
        }
      });
    }
  }
}

/**
 * ExecutionStore decorator that delegates every call to a wrapped store and
 * additionally mirrors `recordUsage` into a control-plane
 * `UsageRecordRepository`. Used only when `mirrorUsageToRepository` is enabled
 * (in-memory wiring) so pipeline-run usage surfaces via `/api/usage` without
 * risking a double write in Postgres mode (see `WorkerDeps`).
 */
export class UsageMirroringExecutionStore implements ExecutionStore {
  private inner: ExecutionStore;
  private usageRepo: UsageRecordRepository;

  constructor(inner: ExecutionStore, usageRepo: UsageRecordRepository) {
    this.inner = inner;
    this.usageRepo = usageRepo;
  }

  start(record: ExecutionRecord): Promise<void> {
    return this.inner.start(record);
  }

  complete(record: ExecutionRecord): Promise<void> {
    return this.inner.complete(record);
  }

  startNode(record: ExecutionNodeRecord): Promise<void> {
    return this.inner.startNode(record);
  }

  completeNode(record: ExecutionNodeRecord): Promise<void> {
    return this.inner.completeNode(record);
  }

  async recordUsage(record: UsageRecord): Promise<void> {
    await this.inner.recordUsage(record);
    await this.usageRepo.append({
      tenantId: record.tenantId,
      pipelineId: record.pipelineId ?? null,
      executionId: record.executionId ?? null,
      provider: record.provider ?? null,
      model: record.model ?? null,
      inputTokens: record.inputTokens ?? 0,
      outputTokens: record.outputTokens ?? 0,
      embeddingTokens: record.embeddingTokens ?? 0,
      estimatedCostUsd: record.estimatedCostUsd ?? 0,
      latencyMs: record.latencyMs ?? null,
      success: record.success
    });
  }
}
