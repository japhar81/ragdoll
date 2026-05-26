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


export class PostgresDatasourceConnectionRepository
  extends PostgresCrudRepository<T.DatasourceConnectionRow>
  implements T.DatasourceConnectionRepository
{
  constructor(pool: PoolLike) {
    super(pool, "datasource_connections", "datasource_connection", [
      "configRedacted"
    ]);
  }
  async listByTenant(tenantId: string): Promise<T.DatasourceConnectionRow[]> {
    return this.queryRows(
      `SELECT * FROM datasource_connections WHERE tenant_id = $1`,
      [tenantId]
    );
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
