/**
 * Postgres repositories — datasets domain.
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


export class PostgresDatasetRepository
  extends PostgresCrudRepository<T.DatasetRow>
  implements T.DatasetRepository
{
  constructor(pool: PoolLike) {
    super(
      pool,
      "datasets",
      "dataset",
      ["embeddingProfile", "chunkSchema", "backends"],
      ["createdBy"]
    );
  }
  async resolveSlug(args: {
    slug: string;
    tenantId?: string;
    environmentId?: string;
  }): Promise<T.DatasetRow | undefined> {
    // The narrowest scope wins; we run three independent lookups in
    // priority order and stop at the first hit. Could be one CTE-shaped
    // query but the three are tiny and this is easier to reason about.
    if (args.tenantId && args.environmentId) {
      const envRow = (
        await this.queryRows(
          `SELECT * FROM datasets
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
          `SELECT * FROM datasets
           WHERE slug = $1 AND scope = 'tenant'
             AND tenant_id = $2 AND archived_at IS NULL`,
          [args.slug, args.tenantId]
        )
      )[0];
      if (tenantRow) return tenantRow;
    }
    const globalRow = (
      await this.queryRows(
        `SELECT * FROM datasets
         WHERE slug = $1 AND scope = 'global' AND archived_at IS NULL`,
        [args.slug]
      )
    )[0];
    return globalRow;
  }
  async listVisibleAt(args: {
    tenantId?: string;
    environmentId?: string;
  }): Promise<T.DatasetRow[]> {
    // Return globals + tenant-scoped (for the given tenant) + env-scoped
    // (for the given env). The caller's tenant/env are NULL-safe so a
    // platform user looking at the all-tenants view sees globals only
    // and (separately) every tenant's datasets via listAll.
    return this.queryRows(
      `SELECT * FROM datasets
       WHERE archived_at IS NULL
         AND (
           scope = 'global'
           OR (scope = 'tenant' AND tenant_id = $1)
           OR (scope = 'environment' AND tenant_id = $1 AND environment_id = $2)
         )
       ORDER BY scope, slug`,
      [args.tenantId ?? null, args.environmentId ?? null]
    );
  }
  async listAll(
    filter: {
      scope?: T.DatasetRow["scope"];
      tenantId?: string;
      environmentId?: string;
      includeArchived?: boolean;
    } = {}
  ): Promise<T.DatasetRow[]> {
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
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.queryRows(
      `SELECT * FROM datasets ${where} ORDER BY scope, slug`,
      params
    );
  }
}


export class PostgresDatasetVersionRepository
  extends PostgresCrudRepository<T.DatasetVersionRow>
  implements T.DatasetVersionRepository
{
  constructor(pool: PoolLike) {
    super(
      pool,
      "dataset_versions",
      "dataset_version",
      ["schemaSpec", "backendCollections"]
    );
  }
  async listByDataset(datasetId: string): Promise<T.DatasetVersionRow[]> {
    return this.queryRows(
      `SELECT * FROM dataset_versions WHERE dataset_id = $1 ORDER BY version_label`,
      [datasetId]
    );
  }
}


export class PostgresDatasetAliasRepository implements T.DatasetAliasRepository {
  private pool: PoolLike;
  constructor(pool: PoolLike) {
    this.pool = pool;
  }
  async upsert(row: T.DatasetAliasRow): Promise<T.DatasetAliasRow> {
    // UNIQUE (dataset_id, alias). ON CONFLICT swaps the version pointer
    // atomically — which is the whole point of aliases.
    const result = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO dataset_aliases
         (id, dataset_id, alias, version_id, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (dataset_id, alias) DO UPDATE
       SET version_id = EXCLUDED.version_id,
           updated_at = EXCLUDED.updated_at,
           updated_by = EXCLUDED.updated_by
       RETURNING *`,
      [
        row.id,
        row.datasetId,
        row.alias,
        row.versionId,
        row.updatedAt,
        toUuidOrNull(row.updatedBy)
      ]
    );
    return rowFromDb<T.DatasetAliasRow>(result.rows[0]);
  }
  async resolve(
    datasetId: string,
    alias: string
  ): Promise<T.DatasetAliasRow | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM dataset_aliases WHERE dataset_id = $1 AND alias = $2`,
      [datasetId, alias]
    );
    return result.rows[0] ? rowFromDb<T.DatasetAliasRow>(result.rows[0]) : undefined;
  }
  async listByDataset(datasetId: string): Promise<T.DatasetAliasRow[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM dataset_aliases WHERE dataset_id = $1 ORDER BY alias`,
      [datasetId]
    );
    return result.rows.map((r) => rowFromDb<T.DatasetAliasRow>(r));
  }
  async delete(datasetId: string, alias: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM dataset_aliases WHERE dataset_id = $1 AND alias = $2`,
      [datasetId, alias]
    );
  }
}

