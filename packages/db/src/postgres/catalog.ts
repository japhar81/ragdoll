/**
 * Postgres repositories — catalog domain.
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


export class PostgresProviderRepository
  extends PostgresCrudRepository<T.ProviderRow>
  implements T.ProviderRepository
{
  constructor(pool: PoolLike) {
    super(pool, "providers", "provider", ["config"]);
  }
  async findByProviderId(providerId: string): Promise<T.ProviderRow | undefined> {
    return (
      await this.queryRows(`SELECT * FROM providers WHERE provider_id = $1`, [
        providerId
      ])
    )[0];
  }
}


export class PostgresProviderModelRepository
  extends PostgresCrudRepository<T.ProviderModelRow>
  implements T.ProviderModelRepository
{
  constructor(pool: PoolLike) {
    super(pool, "provider_models", "provider_model", ["metadata"]);
  }
  async listByProvider(providerId: string): Promise<T.ProviderModelRow[]> {
    return this.queryRows(
      `SELECT * FROM provider_models WHERE provider_id = $1`,
      [providerId]
    );
  }
}


/**
 * Postgres repository over the unified `connections` table (ADR-0023,
 * migration 019). Supersedes PostgresDatasourceConnectionRepository
 * (per-tenant ADR-0020 registry) and PostgresExternalConnectionRepository
 * (ADR-0021). Both old types are gone.
 */
export class PostgresConnectionRepository
  extends PostgresCrudRepository<T.ConnectionRow>
  implements T.ConnectionRepository
{
  constructor(pool: PoolLike) {
    super(pool, "connections", "connection", ["config"]);
  }

  async resolveSlug(args: {
    slug: string;
    tenantId?: string;
    environmentId?: string;
  }): Promise<T.ConnectionRow | undefined> {
    if (args.tenantId && args.environmentId) {
      const envRow = (
        await this.queryRows(
          `SELECT * FROM connections
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
          `SELECT * FROM connections
           WHERE slug = $1 AND scope = 'tenant'
             AND tenant_id = $2 AND archived_at IS NULL`,
          [args.slug, args.tenantId]
        )
      )[0];
      if (tenantRow) return tenantRow;
    }
    return (
      await this.queryRows(
        `SELECT * FROM connections
         WHERE slug = $1 AND scope = 'global' AND archived_at IS NULL`,
        [args.slug]
      )
    )[0];
  }

  async listVisibleAt(args: {
    tenantId?: string;
    environmentId?: string;
    includeArchived?: boolean;
  }): Promise<T.ConnectionRow[]> {
    return this.queryRows(
      `SELECT * FROM connections
       WHERE (${args.includeArchived ? "TRUE" : "archived_at IS NULL"})
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
      scope?: T.ConnectionRow["scope"];
      tenantId?: string;
      environmentId?: string;
      kind?: string;
      includeArchived?: boolean;
    } = {}
  ): Promise<T.ConnectionRow[]> {
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
      `SELECT * FROM connections ${where} ORDER BY scope, kind, slug`,
      params
    );
  }

  async recordProbe(
    id: string,
    result: { ok: boolean; error?: string; at: string }
  ): Promise<void> {
    await this.pool.query(
      `UPDATE connections
         SET last_probed_at = $2,
             last_probe_ok = $3,
             last_probe_error = $4
       WHERE id = $1`,
      [id, result.at, result.ok, result.error ?? null]
    );
  }
}


export class PostgresPipelineDatasetBindingRepository
  extends PostgresCrudRepository<T.PipelineDatasetBindingRow>
  implements T.PipelineDatasetBindingRepository
{
  constructor(pool: PoolLike) {
    super(pool, "pipeline_dataset_bindings", "pipeline_dataset_binding", []);
  }
  async listByPipeline(pipelineId: string): Promise<T.PipelineDatasetBindingRow[]> {
    return this.queryRows(
      `SELECT * FROM pipeline_dataset_bindings
       WHERE pipeline_id = $1
       ORDER BY tenant_id, environment_id NULLS FIRST, source_slug`,
      [pipelineId]
    );
  }
  async resolveBinding(args: {
    pipelineId: string;
    tenantId: string;
    environmentId?: string;
    sourceSlug: string;
  }): Promise<T.PipelineDatasetBindingRow | undefined> {
    // Two-tier cascade per the migration's comment block:
    //   2 = (pipeline, tenant, env=E)         env-specific override
    //   1 = (pipeline, tenant, env=NULL)      tenant-wide override (all envs)
    // ORDER BY tier DESC picks the more-specific row.
    const rows = await this.queryRows(
      `SELECT *,
              CASE
                WHEN environment_id = $3 THEN 2
                WHEN environment_id IS NULL THEN 1
                ELSE 0
              END AS _tier
       FROM pipeline_dataset_bindings
       WHERE pipeline_id = $1
         AND tenant_id = $2
         AND source_slug = $4
         AND (environment_id = $3 OR environment_id IS NULL)
       ORDER BY _tier DESC
       LIMIT 1`,
      [args.pipelineId, args.tenantId, args.environmentId ?? null, args.sourceSlug]
    );
    return rows[0];
  }
}


export class PostgresVectorCollectionRepository
  extends PostgresCrudRepository<T.VectorCollectionRow>
  implements T.VectorCollectionRepository
{
  constructor(pool: PoolLike) {
    super(pool, "vector_collections", "vector_collection", [
      "embeddingProfile"
    ]);
  }
  async findByName(
    collectionName: string
  ): Promise<T.VectorCollectionRow | undefined> {
    return (
      await this.queryRows(
        `SELECT * FROM vector_collections WHERE collection_name = $1`,
        [collectionName]
      )
    )[0];
  }
  async listByTenantPipeline(
    tenantId: string,
    pipelineId: string,
    environment: string
  ): Promise<T.VectorCollectionRow[]> {
    return this.queryRows(
      `SELECT * FROM vector_collections
       WHERE tenant_id = $1 AND pipeline_id = $2 AND environment = $3`,
      [tenantId, pipelineId, environment]
    );
  }
}

/**
 * Postgres `T.ConfigDefinitionRepository` over the `config_definitions` table.
 * The table is keyed by `key` (not `id`), so it cannot reuse the generic
 * `PostgresCrudRepository`; `upsert` performs an `ON CONFLICT (key)` merge.
 */
