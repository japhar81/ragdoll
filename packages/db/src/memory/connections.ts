/**
 * In-memory ConnectionRepository for tests + offline mode (ADR-0023).
 *
 * Mirrors the Postgres SQL invariants from migration 019:
 *   - scope-shape: scope=global → tenant/env null; scope=tenant → tenant
 *     set, env null; scope=environment → both set.
 *   - slug uniqueness within scope (same slug allowed across scopes).
 *   - env → tenant → global resolution cascade.
 *
 * Supersedes InMemoryDatasourceConnectionRepository (ADR-0020 vintage)
 * and InMemoryExternalConnectionRepository (ADR-0021). Both names
 * remain as TS aliases re-exported from memory.ts for one release so
 * existing test harnesses keep compiling; new code should use
 * InMemoryConnectionRepository directly.
 */
import { ConflictError, NotFoundError } from "../errors.ts";
import type * as T from "../types.ts";

export class InMemoryConnectionRepository implements T.ConnectionRepository {
  protected rows = new Map<string, T.ConnectionRow>();

  async create(row: T.ConnectionRow): Promise<T.ConnectionRow> {
    if (this.rows.has(row.id)) {
      throw new ConflictError("connection", `id already exists: ${row.id}`);
    }
    for (const existing of this.rows.values()) {
      if (existing.slug !== row.slug || existing.scope !== row.scope) continue;
      const sameTenant = (existing.tenantId ?? null) === (row.tenantId ?? null);
      const sameEnv =
        (existing.environmentId ?? null) === (row.environmentId ?? null);
      if (sameTenant && sameEnv) {
        throw new ConflictError(
          "connection",
          `slug already exists at scope: ${row.slug}`
        );
      }
    }
    this.rows.set(row.id, structuredClone(row));
    return structuredClone(row);
  }

  async get(id: string): Promise<T.ConnectionRow | undefined> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async require(id: string): Promise<T.ConnectionRow> {
    const row = await this.get(id);
    if (!row) throw new NotFoundError("connection", id);
    return row;
  }

  async update(
    id: string,
    patch: Partial<T.ConnectionRow>
  ): Promise<T.ConnectionRow> {
    const existing = this.rows.get(id);
    if (!existing) throw new NotFoundError("connection", id);
    const next: T.ConnectionRow = {
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
  }): Promise<T.ConnectionRow | undefined> {
    const all = [...this.rows.values()].filter(
      (r) => r.slug === args.slug && !r.archivedAt
    );
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
  }): Promise<T.ConnectionRow[]> {
    return [...this.rows.values()]
      .filter((r) => !r.archivedAt)
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

  async listAll(
    filter: {
      scope?: T.ConnectionRow["scope"];
      tenantId?: string;
      environmentId?: string;
      kind?: string;
      includeArchived?: boolean;
    } = {}
  ): Promise<T.ConnectionRow[]> {
    return [...this.rows.values()]
      .filter((r) => filter.includeArchived || !r.archivedAt)
      .filter((r) => !filter.scope || r.scope === filter.scope)
      .filter((r) => !filter.tenantId || r.tenantId === filter.tenantId)
      .filter(
        (r) => !filter.environmentId || r.environmentId === filter.environmentId
      )
      .filter((r) => !filter.kind || r.kind === filter.kind)
      .map((row) => structuredClone(row));
  }

  async recordProbe(
    id: string,
    result: { ok: boolean; error?: string; at: string }
  ): Promise<void> {
    const existing = this.rows.get(id);
    if (!existing) throw new NotFoundError("connection", id);
    this.rows.set(id, {
      ...existing,
      lastProbedAt: result.at,
      lastProbeOk: result.ok,
      lastProbeError: result.error ?? null
    });
  }
}
