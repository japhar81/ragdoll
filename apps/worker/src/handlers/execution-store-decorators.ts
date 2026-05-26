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
    logger?: StructuredLogger
  ) {
    this.inner = inner;
    this.bus = bus;
    this.logger = logger;
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
    return this.inner.recordUsage(record);
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
