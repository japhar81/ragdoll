/**
 * In-memory ExternalConnectionRepository for tests + offline mode.
 *
 * Mirrors the Postgres SQL invariants from migration 017:
 *   - scope-shape: scope=global → tenant/env null; scope=tenant → tenant set,
 *     env null; scope=environment → both set.
 *   - slug uniqueness within scope (same slug allowed across scopes).
 *   - env → tenant → global resolution cascade.
 */
import { ConflictError, NotFoundError } from "../errors.ts";
import type * as T from "../types.ts";

export class InMemoryExternalConnectionRepository
  implements T.ExternalConnectionRepository
{
  protected rows = new Map<string, T.ExternalConnectionRow>();

  async create(row: T.ExternalConnectionRow): Promise<T.ExternalConnectionRow> {
    if (this.rows.has(row.id)) {
      throw new ConflictError(
        "external_connection",
        `id already exists: ${row.id}`
      );
    }
    for (const existing of this.rows.values()) {
      if (existing.slug !== row.slug || existing.scope !== row.scope) continue;
      const sameTenant = (existing.tenantId ?? null) === (row.tenantId ?? null);
      const sameEnv =
        (existing.environmentId ?? null) === (row.environmentId ?? null);
      if (sameTenant && sameEnv) {
        throw new ConflictError(
          "external_connection",
          `slug already exists at scope: ${row.slug}`
        );
      }
    }
    this.rows.set(row.id, structuredClone(row));
    return structuredClone(row);
  }

  async get(id: string): Promise<T.ExternalConnectionRow | undefined> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async require(id: string): Promise<T.ExternalConnectionRow> {
    const row = await this.get(id);
    if (!row) throw new NotFoundError("external_connection", id);
    return row;
  }

  async update(
    id: string,
    patch: Partial<T.ExternalConnectionRow>
  ): Promise<T.ExternalConnectionRow> {
    const existing = this.rows.get(id);
    if (!existing) throw new NotFoundError("external_connection", id);
    const next: T.ExternalConnectionRow = {
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
  }): Promise<T.ExternalConnectionRow | undefined> {
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
  }): Promise<T.ExternalConnectionRow[]> {
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
      scope?: T.ExternalConnectionRow["scope"];
      tenantId?: string;
      environmentId?: string;
      kind?: string;
      includeArchived?: boolean;
    } = {}
  ): Promise<T.ExternalConnectionRow[]> {
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
    if (!existing) throw new NotFoundError("external_connection", id);
    this.rows.set(id, {
      ...existing,
      lastProbedAt: result.at,
      lastProbeOk: result.ok,
      lastProbeError: result.error ?? null
    });
  }
}
