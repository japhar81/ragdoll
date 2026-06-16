/**
 * In-memory repositories — observability domain.
 *
 * Extracted from memory.ts so each domain's in-memory store lives
 * next to its sibling repos. The public barrel (memory.ts) re-exports
 * everything here so the existing import path keeps working.
 */
import { randomUUID } from "node:crypto";
import type { ExecutionNodeRecord, ExecutionRecord, ExecutionStore } from "../../../runtime/src/index.ts";
import type { UsageRecord, UUID } from "../../../core/src/index.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import { InMemoryCrudRepository } from "./base.ts";
import type * as T from "../types.ts";


export class InMemoryAuditLogRepository implements T.AuditLogRepository {
  private rows: T.AuditLogRow[] = [];

  async append(row: Omit<T.AuditLogRow, "id">): Promise<T.AuditLogRow> {
    const stored: T.AuditLogRow = { ...row, id: randomUUID() };
    this.rows.push(structuredClone(stored));
    return structuredClone(stored);
  }

  async list(
    filter: { tenantId?: UUID; actorId?: UUID; limit?: number } = {}
  ): Promise<T.AuditLogRow[]> {
    let result = this.rows.filter((row) => {
      if (filter.tenantId !== undefined && row.tenantId !== filter.tenantId) return false;
      if (filter.actorId !== undefined && row.actorId !== filter.actorId) return false;
      return true;
    });
    result = result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (filter.limit !== undefined) result = result.slice(0, filter.limit);
    return result.map((row) => structuredClone(row));
  }
}


export class InMemoryUsageRecordRepository implements T.UsageRecordRepository {
  private rows: T.UsageRecordRow[] = [];

  async append(row: Omit<T.UsageRecordRow, "id" | "createdAt">): Promise<T.UsageRecordRow> {
    const stored: T.UsageRecordRow = {
      ...row,
      id: randomUUID(),
      createdAt: new Date().toISOString()
    };
    this.rows.push(structuredClone(stored));
    return structuredClone(stored);
  }

  async list(
    filter: { tenantId?: UUID; executionId?: string } = {}
  ): Promise<T.UsageRecordRow[]> {
    return this.rows
      .filter((row) => {
        if (filter.tenantId !== undefined && row.tenantId !== filter.tenantId) return false;
        if (
          filter.executionId !== undefined &&
          row.executionId !== filter.executionId
        ) {
          return false;
        }
        return true;
      })
      .map((row) => structuredClone(row));
  }
}


export class InMemoryRetentionSettingsRepository
  implements T.RetentionSettingsRepository
{
  private rows = new Map<string, T.RetentionSettingRow>();

  async list(): Promise<T.RetentionSettingRow[]> {
    return [...this.rows.values()].map((r) => structuredClone(r));
  }

  async upsert(input: {
    resource: T.RetentionSettingRow["resource"];
    maxCount: number | null;
    maxAgeDays: number | null;
    updatedBy?: string;
  }): Promise<T.RetentionSettingRow> {
    const stored: T.RetentionSettingRow = {
      resource: input.resource,
      maxCount: input.maxCount,
      maxAgeDays: input.maxAgeDays,
      updatedAt: new Date().toISOString(),
      updatedBy: input.updatedBy ?? null
    };
    this.rows.set(input.resource, structuredClone(stored));
    return structuredClone(stored);
  }
}


/**
 * In-memory `ExecutionStore` mirroring the runtime contract. The runtime
 * package ships its own `InMemoryExecutionStore`; this one is convenient for
 * db-layer tests and parity checks without depending on a Postgres pool.
 */
export class InMemoryExecutionStore implements ExecutionStore {
  executions: ExecutionRecord[] = [];
  nodes: ExecutionNodeRecord[] = [];
  usage: UsageRecord[] = [];

  async start(record: ExecutionRecord): Promise<void> {
    this.executions.push(structuredClone(record));
  }

  async complete(record: ExecutionRecord): Promise<void> {
    this.executions = this.executions.filter(
      (existing) => existing.executionId !== record.executionId
    );
    this.executions.push(structuredClone(record));
  }

  async startNode(record: ExecutionNodeRecord): Promise<void> {
    this.nodes.push(structuredClone(record));
  }

  async completeNode(record: ExecutionNodeRecord): Promise<void> {
    this.nodes = this.nodes.filter(
      (existing) =>
        !(
          existing.executionId === record.executionId &&
          existing.nodeId === record.nodeId
        )
    );
    this.nodes.push(structuredClone(record));
  }

  async recordUsage(record: UsageRecord): Promise<void> {
    this.usage.push(structuredClone(record));
  }

  // Async read methods (the control-plane `ReadableExecutionStore` contract).
  async listExecutions(
    tenantId?: string,
    pipelineId?: string
  ): Promise<ExecutionRecord[]> {
    return this.executions
      .filter((e) => tenantId === undefined || e.tenantId === tenantId)
      .filter((e) => pipelineId === undefined || e.pipelineId === pipelineId)
      .map((e) => structuredClone(e));
  }

  async getExecution(
    executionId: string
  ): Promise<ExecutionRecord | undefined> {
    const found = this.executions.find(
      (e) => e.executionId === executionId
    );
    return found ? structuredClone(found) : undefined;
  }

  async listNodes(executionId: string): Promise<ExecutionNodeRecord[]> {
    return this.nodes
      .filter((n) => n.executionId === executionId)
      .map((n) => structuredClone(n));
  }
}

// --- Auth / RBAC -----------------------------------------------------------

