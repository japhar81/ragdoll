/**
 * In-memory repositories — config domain.
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


export class InMemoryConfigDefinitionRepository implements T.ConfigDefinitionRepository {
  private rows = new Map<string, T.ConfigDefinitionRow>();

  async upsert(row: T.ConfigDefinitionRow): Promise<T.ConfigDefinitionRow> {
    this.rows.set(row.key, structuredClone(row));
    return structuredClone(row);
  }

  async get(key: string): Promise<T.ConfigDefinitionRow | undefined> {
    const row = this.rows.get(key);
    return row ? structuredClone(row) : undefined;
  }

  async require(key: string): Promise<T.ConfigDefinitionRow> {
    const row = await this.get(key);
    if (!row) throw new NotFoundError("config_definition", key);
    return row;
  }

  async delete(key: string): Promise<void> {
    this.rows.delete(key);
  }

  async list(): Promise<T.ConfigDefinitionRow[]> {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }
}


export class InMemoryConfigValueRepository implements T.ConfigValueRepository {
  private rows = new Map<string, T.ConfigValueRow>();

  private uniqueKey(row: Pick<T.ConfigValueRow, "key" | "scope" | "scopeId">): string {
    return `${row.key}::${row.scope}::${row.scopeId ?? ""}`;
  }

  async upsert(
    input: Omit<T.ConfigValueRow, "id" | "createdAt" | "updatedAt"> &
      Partial<Pick<T.ConfigValueRow, "id" | "createdAt" | "updatedAt">>
  ): Promise<T.ConfigValueRow> {
    const now = new Date().toISOString();
    const unique = this.uniqueKey(input);
    const existing = [...this.rows.values()].find(
      (row) => this.uniqueKey(row) === unique
    );
    const row: T.ConfigValueRow = {
      id: existing?.id ?? input.id ?? randomUUID(),
      key: input.key,
      value: input.value,
      scope: input.scope,
      scopeId: input.scopeId ?? null,
      locked: input.locked,
      createdBy: input.createdBy ?? null,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now
    };
    this.rows.set(row.id, structuredClone(row));
    return structuredClone(row);
  }

  async get(id: UUID): Promise<T.ConfigValueRow | undefined> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async delete(id: UUID): Promise<void> {
    this.rows.delete(id);
  }

  async listConfigValues(filter: T.ConfigValueScopeFilter = {}): Promise<T.ConfigValueRow[]> {
    return [...this.rows.values()]
      .filter((row) => {
        if (filter.key !== undefined && row.key !== filter.key) return false;
        if (filter.scope !== undefined && row.scope !== filter.scope) return false;
        if (
          filter.scopeId !== undefined &&
          (row.scopeId ?? null) !== (filter.scopeId ?? null)
        ) {
          return false;
        }
        return true;
      })
      .map((row) => structuredClone(row));
  }
}

