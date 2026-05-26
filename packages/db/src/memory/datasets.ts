/**
 * In-memory repositories — datasets domain.
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


export class InMemoryDatasetRepository implements T.DatasetRepository {
  protected rows = new Map<string, T.DatasetRow>();

  async create(row: T.DatasetRow): Promise<T.DatasetRow> {
    if (this.rows.has(row.id)) {
      throw new ConflictError("dataset", `id already exists: ${row.id}`);
    }
    // Enforce slug uniqueness within scope — same invariant the SQL
    // migration installs as three partial unique indexes.
    for (const existing of this.rows.values()) {
      if (existing.slug !== row.slug || existing.scope !== row.scope) continue;
      const sameTenant = (existing.tenantId ?? null) === (row.tenantId ?? null);
      const sameEnv =
        (existing.environmentId ?? null) === (row.environmentId ?? null);
      if (sameTenant && sameEnv) {
        throw new ConflictError(
          "dataset",
          `slug already exists at scope: ${row.slug}`
        );
      }
    }
    this.rows.set(row.id, structuredClone(row));
    return structuredClone(row);
  }

  async get(id: string): Promise<T.DatasetRow | undefined> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async require(id: string): Promise<T.DatasetRow> {
    const row = await this.get(id);
    if (!row) throw new NotFoundError("dataset", id);
    return row;
  }

  async update(id: string, patch: Partial<T.DatasetRow>): Promise<T.DatasetRow> {
    const existing = this.rows.get(id);
    if (!existing) throw new NotFoundError("dataset", id);
    const next: T.DatasetRow = {
      ...existing,
      ...patch,
      id: existing.id,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    };
    this.rows.set(id, next);
    return structuredClone(next);
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }

  async resolveSlug(args: {
    slug: string;
    tenantId?: string;
    environmentId?: string;
  }): Promise<T.DatasetRow | undefined> {
    const all = [...this.rows.values()].filter(
      (r) => r.slug === args.slug && !r.archivedAt
    );
    // env > tenant > global, first match wins.
    if (args.tenantId && args.environmentId) {
      const envHit = all.find(
        (r) =>
          r.scope === "environment" &&
          r.tenantId === args.tenantId &&
          r.environmentId === args.environmentId
      );
      if (envHit) return structuredClone(envHit);
    }
    if (args.tenantId) {
      const tenantHit = all.find(
        (r) => r.scope === "tenant" && r.tenantId === args.tenantId
      );
      if (tenantHit) return structuredClone(tenantHit);
    }
    const globalHit = all.find((r) => r.scope === "global");
    return globalHit ? structuredClone(globalHit) : undefined;
  }

  async listVisibleAt(args: {
    tenantId?: string;
    environmentId?: string;
  }): Promise<T.DatasetRow[]> {
    const all = [...this.rows.values()].filter((r) => !r.archivedAt);
    // Surface every dataset reachable from the (tenant, env) the caller
    // is acting in: globals plus tenant-scoped plus matching-env-scoped.
    return all
      .filter((r) => {
        if (r.scope === "global") return true;
        if (r.scope === "tenant") return r.tenantId === args.tenantId;
        return (
          r.scope === "environment" &&
          r.tenantId === args.tenantId &&
          r.environmentId === args.environmentId
        );
      })
      .map((row) => structuredClone(row));
  }

  async listAll(filter: {
    scope?: T.DatasetRow["scope"];
    tenantId?: string;
    environmentId?: string;
    includeArchived?: boolean;
  } = {}): Promise<T.DatasetRow[]> {
    return [...this.rows.values()]
      .filter((r) => filter.includeArchived || !r.archivedAt)
      .filter((r) => !filter.scope || r.scope === filter.scope)
      .filter((r) => !filter.tenantId || r.tenantId === filter.tenantId)
      .filter(
        (r) => !filter.environmentId || r.environmentId === filter.environmentId
      )
      .map((row) => structuredClone(row));
  }
}


export class InMemoryDatasetVersionRepository
  implements T.DatasetVersionRepository
{
  protected rows = new Map<string, T.DatasetVersionRow>();

  async create(row: T.DatasetVersionRow): Promise<T.DatasetVersionRow> {
    if (this.rows.has(row.id)) {
      throw new ConflictError("dataset_version", `id already exists: ${row.id}`);
    }
    // UNIQUE (dataset_id, version_label).
    for (const existing of this.rows.values()) {
      if (
        existing.datasetId === row.datasetId &&
        existing.versionLabel === row.versionLabel
      ) {
        throw new ConflictError(
          "dataset_version",
          `version ${row.versionLabel} already exists for dataset ${row.datasetId}`
        );
      }
    }
    this.rows.set(row.id, structuredClone(row));
    return structuredClone(row);
  }

  async get(id: string): Promise<T.DatasetVersionRow | undefined> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async listByDataset(datasetId: string): Promise<T.DatasetVersionRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.datasetId === datasetId)
      .sort((a, b) => a.versionLabel.localeCompare(b.versionLabel))
      .map((row) => structuredClone(row));
  }

  async update(
    id: string,
    patch: Partial<T.DatasetVersionRow>
  ): Promise<T.DatasetVersionRow> {
    const existing = this.rows.get(id);
    if (!existing) throw new NotFoundError("dataset_version", id);
    const next = { ...existing, ...patch, id: existing.id };
    this.rows.set(id, next);
    return structuredClone(next);
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
}


export class InMemoryDatasetAliasRepository
  implements T.DatasetAliasRepository
{
  protected rows = new Map<string, T.DatasetAliasRow>();
  // Index by (datasetId, alias) for resolve().
  private byKey = new Map<string, string>();

  private keyOf(datasetId: string, alias: string): string {
    return `${datasetId}:${alias}`;
  }

  async upsert(row: T.DatasetAliasRow): Promise<T.DatasetAliasRow> {
    const key = this.keyOf(row.datasetId, row.alias);
    const existingId = this.byKey.get(key);
    if (existingId && existingId !== row.id) {
      // Move the alias to point at the new version atomically (the SQL
      // path uses ON CONFLICT (dataset_id, alias) DO UPDATE).
      this.rows.delete(existingId);
    }
    this.rows.set(row.id, structuredClone(row));
    this.byKey.set(key, row.id);
    return structuredClone(row);
  }

  async resolve(
    datasetId: string,
    alias: string
  ): Promise<T.DatasetAliasRow | undefined> {
    const id = this.byKey.get(this.keyOf(datasetId, alias));
    if (!id) return undefined;
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async listByDataset(datasetId: string): Promise<T.DatasetAliasRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.datasetId === datasetId)
      .sort((a, b) => a.alias.localeCompare(b.alias))
      .map((row) => structuredClone(row));
  }

  async delete(datasetId: string, alias: string): Promise<void> {
    const key = this.keyOf(datasetId, alias);
    const id = this.byKey.get(key);
    if (!id) return;
    this.rows.delete(id);
    this.byKey.delete(key);
  }
}

