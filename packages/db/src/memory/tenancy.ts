/**
 * In-memory repositories — tenancy domain.
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


export class InMemoryTenantRepository
  extends InMemoryCrudRepository<T.TenantRow>
  implements T.TenantRepository
{
  constructor() {
    super("tenant");
  }
  async findBySlug(slug: string): Promise<T.TenantRow | undefined> {
    return (await this.list()).find((row) => row.slug === slug);
  }
}

/**
 * In-memory mirror of the per-tenant Git-storage side table. Keyed by
 * tenantId (one git config per tenant). `listDue` honours the
 * `pollIntervalSec` heuristic the Postgres impl uses.
 */

/**
 * In-memory mirror of the per-tenant Git-storage side table. Keyed by
 * tenantId (one git config per tenant). `listDue` honours the
 * `pollIntervalSec` heuristic the Postgres impl uses.
 */
export class InMemoryTenantGitConfigRepository
  implements T.TenantGitConfigRepository
{
  private rows = new Map<string, T.TenantGitConfigRow>();

  async get(tenantId: string): Promise<T.TenantGitConfigRow | undefined> {
    const row = this.rows.get(tenantId);
    return row ? structuredClone(row) : undefined;
  }

  async upsert(row: T.TenantGitConfigRow): Promise<T.TenantGitConfigRow> {
    const existing = this.rows.get(row.tenantId);
    const next: T.TenantGitConfigRow = {
      ...row,
      createdAt: existing?.createdAt ?? row.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.rows.set(row.tenantId, structuredClone(next));
    return structuredClone(next);
  }

  async delete(tenantId: string): Promise<void> {
    this.rows.delete(tenantId);
  }

  async listDue(nowIso: string): Promise<T.TenantGitConfigRow[]> {
    const now = Date.parse(nowIso);
    return [...this.rows.values()]
      .filter((row) => {
        if (!row.lastSyncedAt) return true;
        const due = Date.parse(row.lastSyncedAt) + row.pollIntervalSec * 1000;
        return due <= now;
      })
      .map((row) => structuredClone(row));
  }

  async recordSync(
    tenantId: string,
    result: { sha?: string | null; syncedAt: string; error?: string | null }
  ): Promise<void> {
    const row = this.rows.get(tenantId);
    if (!row) return;
    row.lastSyncedSha = result.sha ?? row.lastSyncedSha;
    row.lastSyncedAt = result.syncedAt;
    row.lastSyncError = result.error ?? null;
    row.updatedAt = new Date().toISOString();
    this.rows.set(tenantId, row);
  }
}


export class InMemoryEnvironmentRepository
  extends InMemoryCrudRepository<T.EnvironmentRow>
  implements T.EnvironmentRepository
{
  constructor() {
    super("environment");
  }
  async listByTenant(tenantId: string): Promise<T.EnvironmentRow[]> {
    return (await this.list())
      .filter((row) => row.tenantId === tenantId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

// --- Datasets (Phase 4 of dataset/RBAC/retrieval refactor) ---

