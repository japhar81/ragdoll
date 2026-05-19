import type { UUID } from "../../core/src/index.ts";
import { ConflictError, NotFoundError } from "./errors.ts";
import type { PoolLike } from "./pool.ts";
import { withTransaction } from "./pool.ts";
import type {
  ApiKeyRepository,
  ApiKeyRow,
  AuditLogRepository,
  AuditLogRow,
  ConfigDefinitionRepository,
  ConfigDefinitionRow,
  ConfigValueRepository,
  ConfigValueRow,
  ConfigValueScopeFilter,
  DatasourceConnectionRepository,
  DatasourceConnectionRow,
  EnvironmentRepository,
  EnvironmentRow,
  PipelineActivationRepository,
  PipelineActivationRow,
  PipelineDeploymentRepository,
  PipelineDeploymentRow,
  PipelineFolderRepository,
  PipelineFolderRow,
  PipelineFolderTreeNode,
  PipelineRepository,
  PipelineRow,
  PipelineVersionRepository,
  PipelineVersionRow,
  ScheduleRepository,
  ScheduleRow,
  ProviderModelRepository,
  ProviderModelRow,
  ProviderRepository,
  ProviderRow,
  TenantPipelineKey,
  TenantPipelineRepository,
  TenantPipelineRow,
  TenantRepository,
  TenantRow,
  UsageRecordRepository,
  UsageRecordRow,
  UserRepository,
  UserRow,
  RoleRepository,
  RoleRow,
  UserIdentityRepository,
  UserIdentityRow,
  IdentityProviderRepository,
  IdentityProviderRow,
  RbacPolicyRepository,
  RbacRolePermissionRow,
  RbacGrantRow,
  AuthSettingsRepository,
  AuthSettingsRow,
  VectorCollectionRepository,
  VectorCollectionRow
} from "./types.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Coerce a value to a Postgres `uuid` literal, or NULL when it is not a valid
 * UUID. Dev principals use non-UUID ids (e.g. "smoke", "dev-user"); writing
 * those into nullable `uuid` FK columns would raise
 * `invalid input syntax for type uuid`. The audit/identity columns that are
 * NOT uuid-typed still preserve the original identity.
 */
export function toUuidOrNull(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function rowFromDb<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[snakeToCamel(key)] =
      value instanceof Date ? value.toISOString() : value;
  }
  return out as T;
}

/**
 * Generic Postgres CRUD repository that maps camelCase row fields to snake_case
 * columns. JSON-typed columns must be passed in `jsonColumns` so they are
 * serialized on write.
 */
export class PostgresCrudRepository<T extends { id: string }> {
  protected pool: PoolLike;
  protected table: string;
  protected entity: string;
  protected jsonColumns: Set<string>;
  /**
   * Columns that are nullable `uuid` FKs to `users(id)` populated from a
   * caller-supplied principal id (e.g. `created_by`, `deployed_by`). Dev
   * principals use non-UUID ids ("dev-user"); writing those into a `uuid`
   * column raises `invalid input syntax for type uuid`. Values here are
   * coerced via `toUuidOrNull` so non-UUID actors become NULL.
   */
  protected principalUuidColumns: Set<string>;

  constructor(
    pool: PoolLike,
    table: string,
    entity: string,
    jsonColumns: string[] = [],
    principalUuidColumns: string[] = []
  ) {
    this.pool = pool;
    this.table = table;
    this.entity = entity;
    this.jsonColumns = new Set(jsonColumns.map(camelToSnake));
    this.principalUuidColumns = new Set(
      principalUuidColumns.map(camelToSnake)
    );
  }

  private serialize(column: string, value: unknown): unknown {
    if (this.jsonColumns.has(column)) return JSON.stringify(value ?? null);
    if (this.principalUuidColumns.has(column)) return toUuidOrNull(value);
    return value === undefined ? null : value;
  }

  async create(row: T): Promise<T> {
    const entries = Object.entries(row).filter(([, v]) => v !== undefined);
    const columns = entries.map(([k]) => camelToSnake(k));
    const values = entries.map(([k, v]) => this.serialize(camelToSnake(k), v));
    const placeholders = columns.map((_, i) => `$${i + 1}`);
    try {
      const result = await this.pool.query<Record<string, unknown>>(
        `INSERT INTO ${this.table} (${columns.join(", ")})
         VALUES (${placeholders.join(", ")}) RETURNING *`,
        values
      );
      return rowFromDb<T>(result.rows[0]);
    } catch (error) {
      if (
        error instanceof Error &&
        /duplicate key|unique constraint/i.test(error.message)
      ) {
        throw new ConflictError(this.entity, error.message);
      }
      throw error;
    }
  }

  async get(id: string): Promise<T | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM ${this.table} WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    return row ? rowFromDb<T>(row) : undefined;
  }

  async require(id: string): Promise<T> {
    const row = await this.get(id);
    if (!row) throw new NotFoundError(this.entity, id);
    return row;
  }

  async update(id: string, patch: Partial<T>): Promise<T> {
    const entries = Object.entries(patch).filter(
      ([k, v]) => k !== "id" && v !== undefined
    );
    if (entries.length === 0) return this.require(id);
    const sets = entries.map(
      ([k], i) => `${camelToSnake(k)} = $${i + 2}`
    );
    const values = entries.map(([k, v]) => this.serialize(camelToSnake(k), v));
    const result = await this.pool.query<Record<string, unknown>>(
      `UPDATE ${this.table} SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      [id, ...values]
    );
    const updated = result.rows[0];
    if (!updated) throw new NotFoundError(this.entity, id);
    return rowFromDb<T>(updated);
  }

  async delete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.table} WHERE id = $1`, [id]);
  }

  async list(): Promise<T[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM ${this.table}`
    );
    return result.rows.map((row) => rowFromDb<T>(row));
  }

  protected async queryRows(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> {
    const result = await this.pool.query<Record<string, unknown>>(sql, params);
    return result.rows.map((row) => rowFromDb<T>(row));
  }
}

export class PostgresTenantRepository
  extends PostgresCrudRepository<TenantRow>
  implements TenantRepository
{
  constructor(pool: PoolLike) {
    super(pool, "tenants", "tenant", ["metadata"]);
  }
  async findBySlug(slug: string): Promise<TenantRow | undefined> {
    return (
      await this.queryRows(`SELECT * FROM tenants WHERE slug = $1`, [slug])
    )[0];
  }
}

export class PostgresEnvironmentRepository
  extends PostgresCrudRepository<EnvironmentRow>
  implements EnvironmentRepository
{
  constructor(pool: PoolLike) {
    super(pool, "environments", "environment");
  }
  async listByTenant(tenantId: string): Promise<EnvironmentRow[]> {
    return this.queryRows(
      `SELECT * FROM environments WHERE tenant_id = $1 ORDER BY name`,
      [tenantId]
    );
  }
}

export class PostgresPipelineRepository
  extends PostgresCrudRepository<PipelineRow>
  implements PipelineRepository
{
  constructor(pool: PoolLike) {
    super(pool, "pipelines", "pipeline", ["labels"], ["createdBy"]);
  }
  async findBySlug(slug: string): Promise<PipelineRow | undefined> {
    return (
      await this.queryRows(`SELECT * FROM pipelines WHERE slug = $1`, [slug])
    )[0];
  }
  async setLatestVersion(
    pipelineId: UUID,
    versionId: UUID | null
  ): Promise<PipelineRow> {
    const result = await this.pool.query<Record<string, unknown>>(
      `UPDATE pipelines SET latest_version_id = $2 WHERE id = $1 RETURNING *`,
      [pipelineId, versionId]
    );
    if (!result.rows[0]) throw new NotFoundError("pipeline", pipelineId);
    return (await this.queryRows(`SELECT * FROM pipelines WHERE id = $1`, [
      pipelineId
    ]))[0];
  }
  async setFolder(
    pipelineId: UUID,
    folderId: UUID | null
  ): Promise<PipelineRow> {
    const result = await this.pool.query<Record<string, unknown>>(
      `UPDATE pipelines SET folder_id = $2 WHERE id = $1 RETURNING *`,
      [pipelineId, folderId]
    );
    if (!result.rows[0]) throw new NotFoundError("pipeline", pipelineId);
    return (await this.queryRows(`SELECT * FROM pipelines WHERE id = $1`, [
      pipelineId
    ]))[0];
  }
}

export class PostgresProviderRepository
  extends PostgresCrudRepository<ProviderRow>
  implements ProviderRepository
{
  constructor(pool: PoolLike) {
    super(pool, "providers", "provider", ["config"]);
  }
  async findByProviderId(providerId: string): Promise<ProviderRow | undefined> {
    return (
      await this.queryRows(`SELECT * FROM providers WHERE provider_id = $1`, [
        providerId
      ])
    )[0];
  }
}

export class PostgresProviderModelRepository
  extends PostgresCrudRepository<ProviderModelRow>
  implements ProviderModelRepository
{
  constructor(pool: PoolLike) {
    super(pool, "provider_models", "provider_model", ["metadata"]);
  }
  async listByProvider(providerId: string): Promise<ProviderModelRow[]> {
    return this.queryRows(
      `SELECT * FROM provider_models WHERE provider_id = $1`,
      [providerId]
    );
  }
}

export class PostgresDatasourceConnectionRepository
  extends PostgresCrudRepository<DatasourceConnectionRow>
  implements DatasourceConnectionRepository
{
  constructor(pool: PoolLike) {
    super(pool, "datasource_connections", "datasource_connection", [
      "configRedacted"
    ]);
  }
  async listByTenant(tenantId: string): Promise<DatasourceConnectionRow[]> {
    return this.queryRows(
      `SELECT * FROM datasource_connections WHERE tenant_id = $1`,
      [tenantId]
    );
  }
}

export class PostgresVectorCollectionRepository
  extends PostgresCrudRepository<VectorCollectionRow>
  implements VectorCollectionRepository
{
  constructor(pool: PoolLike) {
    super(pool, "vector_collections", "vector_collection", [
      "embeddingProfile"
    ]);
  }
  async findByName(
    collectionName: string
  ): Promise<VectorCollectionRow | undefined> {
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
  ): Promise<VectorCollectionRow[]> {
    return this.queryRows(
      `SELECT * FROM vector_collections
       WHERE tenant_id = $1 AND pipeline_id = $2 AND environment = $3`,
      [tenantId, pipelineId, environment]
    );
  }
}

/**
 * Postgres `ConfigDefinitionRepository` over the `config_definitions` table.
 * The table is keyed by `key` (not `id`), so it cannot reuse the generic
 * `PostgresCrudRepository`; `upsert` performs an `ON CONFLICT (key)` merge.
 */
export class PostgresConfigDefinitionRepository
  implements ConfigDefinitionRepository
{
  private pool: PoolLike;

  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async upsert(row: ConfigDefinitionRow): Promise<ConfigDefinitionRow> {
    const result = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO config_definitions
         (key, type, default_value, allowed_scopes, required, secret,
          sensitive, overridable, inherited, nullable, tenant_overridable,
          runtime_overridable, validation, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (key) DO UPDATE SET
         type = EXCLUDED.type,
         default_value = EXCLUDED.default_value,
         allowed_scopes = EXCLUDED.allowed_scopes,
         required = EXCLUDED.required,
         secret = EXCLUDED.secret,
         sensitive = EXCLUDED.sensitive,
         overridable = EXCLUDED.overridable,
         inherited = EXCLUDED.inherited,
         nullable = EXCLUDED.nullable,
         tenant_overridable = EXCLUDED.tenant_overridable,
         runtime_overridable = EXCLUDED.runtime_overridable,
         validation = EXCLUDED.validation,
         description = EXCLUDED.description
       RETURNING *`,
      [
        row.key,
        row.type,
        row.defaultValue === undefined ? null : JSON.stringify(row.defaultValue),
        row.allowedScopes,
        row.required,
        row.secret,
        row.sensitive,
        row.overridable,
        row.inherited,
        row.nullable,
        row.tenantOverridable,
        row.runtimeOverridable,
        JSON.stringify(row.validation ?? {}),
        row.description ?? null
      ]
    );
    return mapConfigDefinition(result.rows[0]);
  }

  async get(key: string): Promise<ConfigDefinitionRow | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM config_definitions WHERE key = $1`,
      [key]
    );
    return result.rows[0] ? mapConfigDefinition(result.rows[0]) : undefined;
  }

  async require(key: string): Promise<ConfigDefinitionRow> {
    const row = await this.get(key);
    if (!row) throw new NotFoundError("config_definition", key);
    return row;
  }

  async delete(key: string): Promise<void> {
    await this.pool.query(`DELETE FROM config_definitions WHERE key = $1`, [
      key
    ]);
  }

  async list(): Promise<ConfigDefinitionRow[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM config_definitions`
    );
    return result.rows.map(mapConfigDefinition);
  }
}

function mapConfigDefinition(
  row: Record<string, unknown>
): ConfigDefinitionRow {
  return {
    key: row.key as string,
    type: row.type as ConfigDefinitionRow["type"],
    defaultValue: row.default_value,
    allowedScopes: (row.allowed_scopes ??
      []) as ConfigDefinitionRow["allowedScopes"],
    required: row.required as boolean,
    secret: row.secret as boolean,
    sensitive: row.sensitive as boolean,
    overridable: row.overridable as boolean,
    inherited: row.inherited as boolean,
    nullable: row.nullable as boolean,
    tenantOverridable: row.tenant_overridable as boolean,
    runtimeOverridable: row.runtime_overridable as boolean,
    validation: (row.validation ?? {}) as Record<string, unknown>,
    description: (row.description as string | null) ?? null
  };
}

export class PostgresPipelineVersionRepository
  extends PostgresCrudRepository<PipelineVersionRow>
  implements PipelineVersionRepository
{
  constructor(pool: PoolLike) {
    super(pool, "pipeline_versions", "pipeline_version", ["spec"], [
      "createdBy"
    ]);
  }
  async listByPipeline(pipelineId: UUID): Promise<PipelineVersionRow[]> {
    return this.queryRows(
      `SELECT * FROM pipeline_versions WHERE pipeline_id = $1 ORDER BY created_at`,
      [pipelineId]
    );
  }
  async findByVersion(
    pipelineId: UUID,
    version: string
  ): Promise<PipelineVersionRow | undefined> {
    return (
      await this.queryRows(
        `SELECT * FROM pipeline_versions WHERE pipeline_id = $1 AND version = $2`,
        [pipelineId, version]
      )
    )[0];
  }
}

export class PostgresPipelineDeploymentRepository
  extends PostgresCrudRepository<PipelineDeploymentRow>
  implements PipelineDeploymentRepository
{
  constructor(pool: PoolLike) {
    super(pool, "pipeline_deployments", "pipeline_deployment", [], [
      "deployedBy"
    ]);
  }
  async getActiveDeployment(
    pipelineId: UUID,
    environment: string,
    tenantId?: UUID | null
  ): Promise<PipelineDeploymentRow | undefined> {
    return (
      await this.queryRows(
        `SELECT * FROM pipeline_deployments
         WHERE pipeline_id = $1 AND environment = $2
           AND tenant_id IS NOT DISTINCT FROM $3
           AND status = 'active'
         LIMIT 1`,
        [pipelineId, environment, tenantId ?? null]
      )
    )[0];
  }
  async listByPipeline(pipelineId: UUID): Promise<PipelineDeploymentRow[]> {
    return this.queryRows(
      `SELECT * FROM pipeline_deployments WHERE pipeline_id = $1`,
      [pipelineId]
    );
  }
}

/**
 * Postgres `TenantPipelineRepository` over the `tenant_pipelines` table
 * (composite PK tenant_id + pipeline_id + environment, from 001). It cannot
 * reuse the generic id-keyed CRUD repo, so it mirrors the in-memory contract
 * directly: `upsert` is an `ON CONFLICT` merge on the composite PK.
 */
export class PostgresTenantPipelineRepository
  implements TenantPipelineRepository
{
  private pool: PoolLike;

  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async upsert(row: TenantPipelineRow): Promise<TenantPipelineRow> {
    try {
      const result = await this.pool.query<Record<string, unknown>>(
        `INSERT INTO tenant_pipelines
           (tenant_id, pipeline_id, environment, enabled,
            vector_isolation, provider_policy, rate_limit_policy,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,
                 COALESCE($8, now()), COALESCE($9, now()))
         ON CONFLICT (tenant_id, pipeline_id, environment) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           vector_isolation = EXCLUDED.vector_isolation,
           provider_policy = EXCLUDED.provider_policy,
           rate_limit_policy = EXCLUDED.rate_limit_policy,
           updated_at = now()
         RETURNING *`,
        [
          row.tenantId,
          row.pipelineId,
          row.environment,
          row.enabled,
          JSON.stringify(row.vectorIsolation ?? {}),
          JSON.stringify(row.providerPolicy ?? {}),
          JSON.stringify(row.rateLimitPolicy ?? {}),
          row.createdAt ?? null,
          row.updatedAt ?? null
        ]
      );
      return mapTenantPipeline(result.rows[0]);
    } catch (error) {
      if (
        error instanceof Error &&
        /duplicate key|unique constraint/i.test(error.message)
      ) {
        throw new ConflictError("tenant_pipeline", error.message);
      }
      throw error;
    }
  }

  async get(key: TenantPipelineKey): Promise<TenantPipelineRow | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM tenant_pipelines
       WHERE tenant_id = $1 AND pipeline_id = $2 AND environment = $3`,
      [key.tenantId, key.pipelineId, key.environment]
    );
    return result.rows[0] ? mapTenantPipeline(result.rows[0]) : undefined;
  }

  async require(key: TenantPipelineKey): Promise<TenantPipelineRow> {
    const row = await this.get(key);
    if (!row) {
      throw new NotFoundError(
        "tenant_pipeline",
        `${key.tenantId}:${key.pipelineId}:${key.environment}`
      );
    }
    return row;
  }

  async delete(key: TenantPipelineKey): Promise<void> {
    await this.pool.query(
      `DELETE FROM tenant_pipelines
       WHERE tenant_id = $1 AND pipeline_id = $2 AND environment = $3`,
      [key.tenantId, key.pipelineId, key.environment]
    );
  }

  async listByTenant(tenantId: UUID): Promise<TenantPipelineRow[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM tenant_pipelines WHERE tenant_id = $1`,
      [tenantId]
    );
    return result.rows.map(mapTenantPipeline);
  }
}

function mapTenantPipeline(
  row: Record<string, unknown>
): TenantPipelineRow {
  return {
    tenantId: row.tenant_id as string,
    pipelineId: row.pipeline_id as string,
    environment: row.environment as string,
    enabled: row.enabled as boolean,
    vectorIsolation: (row.vector_isolation ?? {}) as Record<string, unknown>,
    providerPolicy: (row.provider_policy ?? {}) as Record<string, unknown>,
    rateLimitPolicy: (row.rate_limit_policy ?? {}) as Record<string, unknown>,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : (row.created_at as string),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : (row.updated_at as string)
  };
}

export class PostgresPipelineFolderRepository
  extends PostgresCrudRepository<PipelineFolderRow>
  implements PipelineFolderRepository
{
  constructor(pool: PoolLike) {
    super(pool, "pipeline_folders", "pipeline_folder");
  }

  async rename(id: UUID, name: string): Promise<PipelineFolderRow> {
    try {
      const result = await this.pool.query<Record<string, unknown>>(
        `UPDATE pipeline_folders SET name = $2 WHERE id = $1 RETURNING *`,
        [id, name]
      );
      if (!result.rows[0]) throw new NotFoundError("pipeline_folder", id);
      return (
        await this.queryRows(`SELECT * FROM pipeline_folders WHERE id = $1`, [
          id
        ])
      )[0];
    } catch (error) {
      if (
        error instanceof Error &&
        /duplicate key|unique constraint/i.test(error.message)
      ) {
        throw new ConflictError("pipeline_folder", error.message);
      }
      throw error;
    }
  }

  async listChildren(parentId: UUID | null): Promise<PipelineFolderRow[]> {
    return this.queryRows(
      `SELECT * FROM pipeline_folders
       WHERE parent_id IS NOT DISTINCT FROM $1
       ORDER BY name`,
      [parentId]
    );
  }

  override async delete(id: string): Promise<void> {
    const child = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM pipeline_folders WHERE parent_id = $1`,
      [id]
    );
    if (Number(child.rows[0]?.n ?? 0) > 0) {
      throw new ConflictError(
        "pipeline_folder",
        `folder has child folder(s): ${id}`
      );
    }
    const pipes = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM pipelines WHERE folder_id = $1`,
      [id]
    );
    if (Number(pipes.rows[0]?.n ?? 0) > 0) {
      throw new ConflictError(
        "pipeline_folder",
        `folder has pipeline(s): ${id}`
      );
    }
    try {
      await this.pool.query(`DELETE FROM pipeline_folders WHERE id = $1`, [id]);
    } catch (error) {
      if (
        error instanceof Error &&
        /foreign key|violates foreign key constraint/i.test(error.message)
      ) {
        throw new ConflictError("pipeline_folder", error.message);
      }
      throw error;
    }
  }

  async tree(): Promise<PipelineFolderTreeNode[]> {
    const all = await this.list();
    const byParent = new Map<string, PipelineFolderRow[]>();
    for (const row of all) {
      const key = row.parentId ?? " root";
      const bucket = byParent.get(key) ?? [];
      bucket.push(row);
      byParent.set(key, bucket);
    }
    const build = (row: PipelineFolderRow): PipelineFolderTreeNode => ({
      ...row,
      children: (byParent.get(row.id) ?? [])
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(build)
    });
    return (byParent.get(" root") ?? [])
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(build);
  }
}

export class PostgresPipelineActivationRepository
  extends PostgresCrudRepository<PipelineActivationRow>
  implements PipelineActivationRepository
{
  constructor(pool: PoolLike) {
    super(pool, "pipeline_activations", "pipeline_activation");
  }

  async listByTenantPipelineEnv(
    tenantId: UUID,
    pipelineId: UUID,
    environment: string
  ): Promise<PipelineActivationRow[]> {
    return this.queryRows(
      `SELECT * FROM pipeline_activations
       WHERE tenant_id = $1 AND pipeline_id = $2 AND environment = $3
       ORDER BY label`,
      [tenantId, pipelineId, environment]
    );
  }

  async listByTenant(tenantId: UUID): Promise<PipelineActivationRow[]> {
    return this.queryRows(
      `SELECT * FROM pipeline_activations WHERE tenant_id = $1`,
      [tenantId]
    );
  }

  async listByPipeline(pipelineId: UUID): Promise<PipelineActivationRow[]> {
    return this.queryRows(
      `SELECT * FROM pipeline_activations WHERE pipeline_id = $1`,
      [pipelineId]
    );
  }
}

export class PostgresScheduleRepository
  extends PostgresCrudRepository<ScheduleRow>
  implements ScheduleRepository
{
  constructor(pool: PoolLike) {
    super(pool, "schedules", "schedule", ["input"]);
  }

  async listEnabled(): Promise<ScheduleRow[]> {
    return this.queryRows(
      `SELECT * FROM schedules WHERE enabled = true ORDER BY next_run_at NULLS LAST`
    );
  }

  async listDue(nowIso: string): Promise<ScheduleRow[]> {
    return this.queryRows(
      `SELECT * FROM schedules
       WHERE enabled = true
         AND next_run_at IS NOT NULL
         AND next_run_at <= $1
       ORDER BY next_run_at`,
      [nowIso]
    );
  }

  async markRun(
    id: UUID,
    lastRunIso: string,
    nextRunIso: string | null
  ): Promise<ScheduleRow> {
    const result = await this.pool.query<Record<string, unknown>>(
      `UPDATE schedules SET last_run_at = $2, next_run_at = $3
       WHERE id = $1 RETURNING *`,
      [id, lastRunIso, nextRunIso]
    );
    if (!result.rows[0]) throw new NotFoundError("schedule", id);
    return (
      await this.queryRows(`SELECT * FROM schedules WHERE id = $1`, [id])
    )[0];
  }
}

export class PostgresConfigValueRepository implements ConfigValueRepository {
  private pool: PoolLike;

  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async upsert(
    input: Omit<ConfigValueRow, "id" | "createdAt" | "updatedAt"> &
      Partial<Pick<ConfigValueRow, "id" | "createdAt" | "updatedAt">>
  ): Promise<ConfigValueRow> {
    const result = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO config_values (key, value, scope, scope_id, locked, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (key, scope, scope_id) DO UPDATE SET
         value = EXCLUDED.value,
         locked = EXCLUDED.locked,
         updated_at = now()
       RETURNING *`,
      [
        input.key,
        JSON.stringify(input.value ?? null),
        input.scope,
        input.scopeId ?? null,
        input.locked,
        // created_by is a nullable uuid FK to users(id); a dev/non-UUID
        // principal id ("dev-user") must be coerced to NULL, not raw-bound.
        toUuidOrNull(input.createdBy)
      ]
    );
    return mapConfigValue(result.rows[0]);
  }

  async get(id: UUID): Promise<ConfigValueRow | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM config_values WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? mapConfigValue(result.rows[0]) : undefined;
  }

  async delete(id: UUID): Promise<void> {
    await this.pool.query(`DELETE FROM config_values WHERE id = $1`, [id]);
  }

  async listConfigValues(
    filter: ConfigValueScopeFilter = {}
  ): Promise<ConfigValueRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.key !== undefined) {
      params.push(filter.key);
      conditions.push(`key = $${params.length}`);
    }
    if (filter.scope !== undefined) {
      params.push(filter.scope);
      conditions.push(`scope = $${params.length}`);
    }
    if (filter.scopeId !== undefined) {
      params.push(filter.scopeId);
      conditions.push(`scope_id IS NOT DISTINCT FROM $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM config_values ${where}`,
      params
    );
    return result.rows.map(mapConfigValue);
  }
}

function mapConfigValue(row: Record<string, unknown>): ConfigValueRow {
  return {
    id: row.id as string,
    key: row.key as string,
    value: row.value,
    scope: row.scope as ConfigValueRow["scope"],
    scopeId: (row.scope_id as string | null) ?? null,
    locked: row.locked as boolean,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : (row.created_at as string),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : (row.updated_at as string)
  };
}

export class PostgresAuditLogRepository implements AuditLogRepository {
  private pool: PoolLike;

  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async append(row: Omit<AuditLogRow, "id">): Promise<AuditLogRow> {
    const result = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO audit_logs
         (actor_id, tenant_id, pipeline_id, action, target_type, target_id,
          before_redacted, after_redacted, request_id, source_ip, user_agent, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        toUuidOrNull(row.actorId),
        toUuidOrNull(row.tenantId),
        toUuidOrNull(row.pipelineId),
        row.action,
        row.targetType,
        row.targetId,
        row.beforeRedacted === undefined
          ? null
          : JSON.stringify(row.beforeRedacted),
        row.afterRedacted === undefined
          ? null
          : JSON.stringify(row.afterRedacted),
        row.requestId ?? null,
        row.sourceIp ?? null,
        row.userAgent ?? null,
        row.createdAt
      ]
    );
    return mapAuditLog(result.rows[0]);
  }

  async list(
    filter: { tenantId?: UUID; actorId?: UUID; limit?: number } = {}
  ): Promise<AuditLogRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.tenantId !== undefined) {
      params.push(filter.tenantId);
      conditions.push(`tenant_id = $${params.length}`);
    }
    if (filter.actorId !== undefined) {
      params.push(filter.actorId);
      conditions.push(`actor_id = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter.limit !== undefined ? `LIMIT ${Number(filter.limit)}` : "";
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC ${limit}`,
      params
    );
    return result.rows.map(mapAuditLog);
  }
}

function mapAuditLog(row: Record<string, unknown>): AuditLogRow {
  return {
    id: row.id as string,
    actorId: (row.actor_id as string | null) ?? null,
    tenantId: (row.tenant_id as string | null) ?? null,
    pipelineId: (row.pipeline_id as string | null) ?? null,
    action: row.action as string,
    targetType: row.target_type as string,
    targetId: row.target_id as string,
    beforeRedacted: row.before_redacted,
    afterRedacted: row.after_redacted,
    requestId: (row.request_id as string | null) ?? null,
    sourceIp: (row.source_ip as string | null) ?? null,
    userAgent: (row.user_agent as string | null) ?? null,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : (row.created_at as string)
  };
}

export class PostgresUsageRecordRepository implements UsageRecordRepository {
  private pool: PoolLike;

  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async append(
    row: Omit<UsageRecordRow, "id" | "createdAt">
  ): Promise<UsageRecordRow> {
    const result = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO usage_records
         (tenant_id, pipeline_id, execution_id, provider, model,
          input_tokens, output_tokens, embedding_tokens, estimated_cost_usd,
          latency_ms, success)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        row.tenantId,
        row.pipelineId ?? null,
        row.executionId ?? null,
        row.provider ?? null,
        row.model ?? null,
        row.inputTokens,
        row.outputTokens,
        row.embeddingTokens,
        row.estimatedCostUsd,
        row.latencyMs ?? null,
        row.success
      ]
    );
    return mapUsageRecord(result.rows[0]);
  }

  async list(
    filter: { tenantId?: UUID; executionId?: string } = {}
  ): Promise<UsageRecordRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.tenantId !== undefined) {
      params.push(filter.tenantId);
      conditions.push(`tenant_id = $${params.length}`);
    }
    if (filter.executionId !== undefined) {
      params.push(filter.executionId);
      conditions.push(`execution_id = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM usage_records ${where} ORDER BY created_at DESC`,
      params
    );
    return result.rows.map(mapUsageRecord);
  }
}

function mapUsageRecord(row: Record<string, unknown>): UsageRecordRow {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    pipelineId: (row.pipeline_id as string | null) ?? null,
    executionId: (row.execution_id as string | null) ?? null,
    provider: (row.provider as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    embeddingTokens: Number(row.embedding_tokens ?? 0),
    estimatedCostUsd: Number(row.estimated_cost_usd ?? 0),
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    success: row.success as boolean,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : (row.created_at as string)
  };
}

export class PostgresApiKeyRepository implements ApiKeyRepository {
  private pool: PoolLike;

  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async create(row: ApiKeyRow): Promise<ApiKeyRow> {
    try {
      const result = await this.pool.query<Record<string, unknown>>(
        `INSERT INTO api_keys
           (id, tenant_id, principal_id, name, prefix, hash, roles, created_at, last_used_at, revoked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          row.id,
          row.tenantId ?? null,
          row.principalId,
          row.name,
          row.prefix,
          row.hash,
          row.roles,
          row.createdAt,
          row.lastUsedAt ?? null,
          row.revokedAt ?? null
        ]
      );
      return mapApiKey(result.rows[0]);
    } catch (error) {
      if (
        error instanceof Error &&
        /duplicate key|unique constraint/i.test(error.message)
      ) {
        throw new ConflictError("api_key", error.message);
      }
      throw error;
    }
  }

  async findByPrefix(prefix: string): Promise<ApiKeyRow | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM api_keys WHERE prefix = $1`,
      [prefix]
    );
    return result.rows[0] ? mapApiKey(result.rows[0]) : undefined;
  }

  async touch(id: UUID, at: string = new Date().toISOString()): Promise<void> {
    const result = await this.pool.query(
      `UPDATE api_keys SET last_used_at = $2 WHERE id = $1`,
      [id, at]
    );
    if (!result.rowCount) throw new NotFoundError("api_key", id);
  }

  async revoke(id: UUID, at: string = new Date().toISOString()): Promise<void> {
    const result = await this.pool.query(
      `UPDATE api_keys SET revoked_at = $2 WHERE id = $1`,
      [id, at]
    );
    if (!result.rowCount) throw new NotFoundError("api_key", id);
  }

  async listByPrincipal(principalId: UUID): Promise<ApiKeyRow[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM api_keys WHERE principal_id = $1`,
      [principalId]
    );
    return result.rows.map(mapApiKey);
  }
}

function mapApiKey(row: Record<string, unknown>): ApiKeyRow {
  return {
    id: row.id as string,
    tenantId: (row.tenant_id as string | null) ?? undefined,
    principalId: row.principal_id as string,
    name: row.name as string,
    prefix: row.prefix as string,
    hash: row.hash as string,
    roles: ((row.roles as string[] | null) ?? []) as ApiKeyRow["roles"],
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : (row.created_at as string),
    lastUsedAt:
      row.last_used_at instanceof Date
        ? row.last_used_at.toISOString()
        : ((row.last_used_at as string | null) ?? undefined),
    revokedAt:
      row.revoked_at instanceof Date
        ? row.revoked_at.toISOString()
        : ((row.revoked_at as string | null) ?? undefined)
  };
}

// --- Auth / RBAC -----------------------------------------------------------

export class PostgresUserRepository
  extends PostgresCrudRepository<UserRow>
  implements UserRepository
{
  constructor(pool: PoolLike) {
    super(pool, "users", "user");
  }
  async findByEmail(email: string): Promise<UserRow | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM users WHERE lower(email) = lower($1)`,
      [email]
    );
    return result.rows[0] ? rowFromDb<UserRow>(result.rows[0]) : undefined;
  }
}

export class PostgresRoleRepository
  extends PostgresCrudRepository<RoleRow>
  implements RoleRepository
{
  constructor(pool: PoolLike) {
    super(pool, "roles", "role");
  }
  async findByName(name: string): Promise<RoleRow | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM roles WHERE name = $1`,
      [name]
    );
    return result.rows[0] ? rowFromDb<RoleRow>(result.rows[0]) : undefined;
  }
}

export class PostgresUserIdentityRepository
  implements UserIdentityRepository
{
  private pool: PoolLike;
  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async create(row: UserIdentityRow): Promise<UserIdentityRow> {
    try {
      const r = await this.pool.query<Record<string, unknown>>(
        `INSERT INTO user_identities (id, user_id, provider, subject, email)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [row.id, row.userId, row.provider, row.subject, row.email ?? null]
      );
      return rowFromDb<UserIdentityRow>(r.rows[0]);
    } catch (error) {
      if (
        error instanceof Error &&
        /duplicate key|unique constraint/i.test(error.message)
      ) {
        throw new ConflictError("user_identity", error.message);
      }
      throw error;
    }
  }

  async findBySubject(
    provider: string,
    subject: string
  ): Promise<UserIdentityRow | undefined> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM user_identities WHERE provider = $1 AND subject = $2`,
      [provider, subject]
    );
    return r.rows[0] ? rowFromDb<UserIdentityRow>(r.rows[0]) : undefined;
  }

  async listForUser(userId: string): Promise<UserIdentityRow[]> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM user_identities WHERE user_id = $1 ORDER BY created_at`,
      [userId]
    );
    return r.rows.map((row) => rowFromDb<UserIdentityRow>(row));
  }

  async delete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM user_identities WHERE id = $1`, [id]);
  }
}

export class PostgresIdentityProviderRepository
  extends PostgresCrudRepository<IdentityProviderRow>
  implements IdentityProviderRepository
{
  constructor(pool: PoolLike) {
    super(pool, "identity_providers", "identity_provider", ["config"]);
  }
  async findBySlug(slug: string): Promise<IdentityProviderRow | undefined> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM identity_providers WHERE slug = $1`,
      [slug]
    );
    return r.rows[0] ? rowFromDb<IdentityProviderRow>(r.rows[0]) : undefined;
  }
  async listEnabled(): Promise<IdentityProviderRow[]> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM identity_providers WHERE enabled = true ORDER BY display_name`
    );
    return r.rows.map((row) => rowFromDb<IdentityProviderRow>(row));
  }
}

export class PostgresRbacPolicyRepository implements RbacPolicyRepository {
  private pool: PoolLike;
  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async listRolePermissions(): Promise<RbacRolePermissionRow[]> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT role, permission FROM rbac_role_permissions`
    );
    return r.rows.map((row) => ({
      role: row.role as string,
      permission: row.permission as string
    }));
  }

  async addRolePermission(row: RbacRolePermissionRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO rbac_role_permissions (role, permission)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [row.role, row.permission]
    );
  }

  async removeRolePermission(row: RbacRolePermissionRow): Promise<void> {
    await this.pool.query(
      `DELETE FROM rbac_role_permissions WHERE role = $1 AND permission = $2`,
      [row.role, row.permission]
    );
  }

  async setRolePermissions(
    role: string,
    permissions: string[]
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `DELETE FROM rbac_role_permissions WHERE role = $1`,
        [role]
      );
      for (const permission of new Set(permissions)) {
        await client.query(
          `INSERT INTO rbac_role_permissions (role, permission)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [role, permission]
        );
      }
    });
  }

  async listGrants(): Promise<RbacGrantRow[]> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM rbac_grants`
    );
    return r.rows.map((row) => rowFromDb<RbacGrantRow>(row));
  }

  async listGrantsForUser(userId: string): Promise<RbacGrantRow[]> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM rbac_grants WHERE user_id = $1`,
      [userId]
    );
    return r.rows.map((row) => rowFromDb<RbacGrantRow>(row));
  }

  async addGrant(row: RbacGrantRow): Promise<RbacGrantRow> {
    const r = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO rbac_grants (id, user_id, role, scope)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, role, scope) DO UPDATE SET role = EXCLUDED.role
       RETURNING *`,
      [row.id, row.userId, row.role, row.scope]
    );
    return rowFromDb<RbacGrantRow>(r.rows[0]);
  }

  async removeGrant(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM rbac_grants WHERE id = $1`, [id]);
  }
}

export class PostgresAuthSettingsRepository
  implements AuthSettingsRepository
{
  private pool: PoolLike;
  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async get(): Promise<AuthSettingsRow> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT signup_mode, default_role, updated_at FROM auth_settings WHERE id = true`
    );
    if (!r.rows[0]) {
      return {
        signupMode: "admin_only",
        defaultRole: "viewer",
        updatedAt: new Date(0).toISOString()
      };
    }
    return rowFromDb<AuthSettingsRow>(r.rows[0]);
  }

  async set(row: AuthSettingsRow): Promise<AuthSettingsRow> {
    const r = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO auth_settings (id, signup_mode, default_role, updated_at)
       VALUES (true, $1, $2, now())
       ON CONFLICT (id) DO UPDATE SET
         signup_mode = EXCLUDED.signup_mode,
         default_role = EXCLUDED.default_role,
         updated_at = now()
       RETURNING signup_mode, default_role, updated_at`,
      [row.signupMode, row.defaultRole ?? null]
    );
    return rowFromDb<AuthSettingsRow>(r.rows[0]);
  }
}
