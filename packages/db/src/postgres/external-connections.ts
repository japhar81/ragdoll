/**
 * Postgres repository — external_connections (ADR-0021).
 *
 * Same cascade as datasets (env → tenant → global) and same per-scope
 * partial unique indexes installed by migration 017.
 */
import type { PoolLike } from "../pool.ts";
import { PostgresCrudRepository } from "./base.ts";
import type * as T from "../types.ts";

export class PostgresExternalConnectionRepository
  extends PostgresCrudRepository<T.ExternalConnectionRow>
  implements T.ExternalConnectionRepository
{
  constructor(pool: PoolLike) {
    super(
      pool,
      "external_connections",
      "external_connection",
      ["options"] // jsonb columns
    );
  }

  async resolveSlug(args: {
    slug: string;
    tenantId?: string;
    environmentId?: string;
  }): Promise<T.ExternalConnectionRow | undefined> {
    if (args.tenantId && args.environmentId) {
      const envRow = (
        await this.queryRows(
          `SELECT * FROM external_connections
           WHERE slug = $1 AND scope = 'environment'
             AND tenant_id = $2 AND environment_id = $3
             AND archived_at IS NULL`,
          [args.slug, args.tenantId, args.environmentId]
        )
      )[0];
      if (envRow) return envRow;
    }
    if (args.tenantId) {
      const tenantRow = (
        await this.queryRows(
          `SELECT * FROM external_connections
           WHERE slug = $1 AND scope = 'tenant'
             AND tenant_id = $2 AND archived_at IS NULL`,
          [args.slug, args.tenantId]
        )
      )[0];
      if (tenantRow) return tenantRow;
    }
    return (
      await this.queryRows(
        `SELECT * FROM external_connections
         WHERE slug = $1 AND scope = 'global' AND archived_at IS NULL`,
        [args.slug]
      )
    )[0];
  }

  async listVisibleAt(args: {
    tenantId?: string;
    environmentId?: string;
  }): Promise<T.ExternalConnectionRow[]> {
    return this.queryRows(
      `SELECT * FROM external_connections
       WHERE archived_at IS NULL
         AND (
           scope = 'global'
           OR (scope = 'tenant' AND tenant_id = $1)
           OR (scope = 'environment' AND tenant_id = $1 AND environment_id = $2)
         )
       ORDER BY scope, kind, slug`,
      [args.tenantId ?? null, args.environmentId ?? null]
    );
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
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (!filter.includeArchived) clauses.push(`archived_at IS NULL`);
    if (filter.scope) {
      params.push(filter.scope);
      clauses.push(`scope = $${params.length}`);
    }
    if (filter.tenantId) {
      params.push(filter.tenantId);
      clauses.push(`tenant_id = $${params.length}`);
    }
    if (filter.environmentId) {
      params.push(filter.environmentId);
      clauses.push(`environment_id = $${params.length}`);
    }
    if (filter.kind) {
      params.push(filter.kind);
      clauses.push(`kind = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.queryRows(
      `SELECT * FROM external_connections ${where} ORDER BY scope, kind, slug`,
      params
    );
  }

  async recordProbe(
    id: string,
    result: { ok: boolean; error?: string; at: string }
  ): Promise<void> {
    await this.pool.query(
      `UPDATE external_connections
         SET last_probed_at = $2,
             last_probe_ok = $3,
             last_probe_error = $4
       WHERE id = $1`,
      [id, result.at, result.ok, result.error ?? null]
    );
  }
}
