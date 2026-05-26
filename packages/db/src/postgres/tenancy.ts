/**
 * Postgres repositories — tenancy domain.
 *
 * Extracted from postgres-repos.ts so each domain's repository code
 * lives next to the other repos that share its table neighbourhood.
 * The public barrel `postgres-repos.ts` re-exports everything here.
 */
import type { UUID } from "../../../core/src/index.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import type { PoolLike } from "../pool.ts";
import { withTransaction } from "../pool.ts";
import {
  PostgresCrudRepository,
  toUuidOrNull,
  rowFromDb,
  camelToSnake,
  snakeToCamel
} from "./base.ts";
import type * as T from "../types.ts";


export class PostgresTenantRepository
  extends PostgresCrudRepository<T.TenantRow>
  implements T.TenantRepository
{
  constructor(pool: PoolLike) {
    super(pool, "tenants", "tenant", ["metadata"]);
  }
  async findBySlug(slug: string): Promise<T.TenantRow | undefined> {
    return (
      await this.queryRows(`SELECT * FROM tenants WHERE slug = $1`, [slug])
    )[0];
  }
}

/**
 * Postgres repo for the per-tenant Git-storage side table (see
 * migration 007). The composite key is just `tenant_id` — at most one
 * git config per tenant — so we hand-roll CRUD instead of reusing the
 * generic id-keyed CRUD base. `upsert` is `ON CONFLICT (tenant_id)`.
 */

/**
 * Postgres repo for the per-tenant Git-storage side table (see
 * migration 007). The composite key is just `tenant_id` — at most one
 * git config per tenant — so we hand-roll CRUD instead of reusing the
 * generic id-keyed CRUD base. `upsert` is `ON CONFLICT (tenant_id)`.
 */
export class PostgresTenantGitConfigRepository
  implements T.TenantGitConfigRepository
{
  private pool: PoolLike;
  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async get(tenantId: UUID): Promise<T.TenantGitConfigRow | undefined> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM tenant_git_configs WHERE tenant_id = $1`,
      [tenantId]
    );
    return r.rows[0] ? rowFromDb<T.TenantGitConfigRow>(r.rows[0]) : undefined;
  }

  async upsert(row: T.TenantGitConfigRow): Promise<T.TenantGitConfigRow> {
    const r = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO tenant_git_configs
         (tenant_id, remote_url, branch, path_prefix, auth_method,
          auth_secret_id, dek_wrapped, poll_interval_sec,
          last_synced_sha, last_synced_at, last_sync_error,
          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
               COALESCE($12, now()), now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         remote_url = EXCLUDED.remote_url,
         branch = EXCLUDED.branch,
         path_prefix = EXCLUDED.path_prefix,
         auth_method = EXCLUDED.auth_method,
         auth_secret_id = EXCLUDED.auth_secret_id,
         dek_wrapped = EXCLUDED.dek_wrapped,
         poll_interval_sec = EXCLUDED.poll_interval_sec,
         updated_at = now()
       RETURNING *`,
      [
        row.tenantId,
        row.remoteUrl,
        row.branch,
        row.pathPrefix,
        row.authMethod,
        row.authSecretId,
        row.dekWrapped,
        row.pollIntervalSec,
        row.lastSyncedSha ?? null,
        row.lastSyncedAt ?? null,
        row.lastSyncError ?? null,
        row.createdAt ?? null
      ]
    );
    return rowFromDb<T.TenantGitConfigRow>(r.rows[0]);
  }

  async delete(tenantId: UUID): Promise<void> {
    await this.pool.query(`DELETE FROM tenant_git_configs WHERE tenant_id = $1`, [tenantId]);
  }

  async listDue(nowIso: string): Promise<T.TenantGitConfigRow[]> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT g.*
         FROM tenant_git_configs g
         JOIN tenants t ON t.id = g.tenant_id
        WHERE t.storage_mode = 'git'
          AND (
            g.last_synced_at IS NULL
            OR g.last_synced_at + (g.poll_interval_sec || ' seconds')::interval <= $1::timestamptz
          )`,
      [nowIso]
    );
    return r.rows.map((row) => rowFromDb<T.TenantGitConfigRow>(row));
  }

  async recordSync(
    tenantId: UUID,
    result: { sha?: string | null; syncedAt: string; error?: string | null }
  ): Promise<void> {
    await this.pool.query(
      `UPDATE tenant_git_configs
          SET last_synced_sha = COALESCE($2, last_synced_sha),
              last_synced_at = $3::timestamptz,
              last_sync_error = $4,
              updated_at = now()
        WHERE tenant_id = $1`,
      [tenantId, result.sha ?? null, result.syncedAt, result.error ?? null]
    );
  }
}


export class PostgresEnvironmentRepository
  extends PostgresCrudRepository<T.EnvironmentRow>
  implements T.EnvironmentRepository
{
  constructor(pool: PoolLike) {
    super(pool, "environments", "environment");
  }
  async listByTenant(tenantId: string): Promise<T.EnvironmentRow[]> {
    return this.queryRows(
      `SELECT * FROM environments WHERE tenant_id = $1 ORDER BY name`,
      [tenantId]
    );
  }
}

// --- Datasets (Phase 4 of dataset/RBAC/retrieval refactor) ---

