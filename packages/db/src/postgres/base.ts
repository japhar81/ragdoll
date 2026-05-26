import type { UUID } from "../../../core/src/index.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import type { PoolLike } from "../pool.ts";
import { withTransaction } from "../pool.ts";
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
  DatasetRepository,
  DatasetRow,
  DatasetVersionRepository,
  DatasetVersionRow,
  DatasetAliasRepository,
  DatasetAliasRow,
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
  RetentionSettingRow,
  RetentionSettingsRepository,
  ProviderModelRepository,
  ProviderModelRow,
  ProviderRepository,
  ProviderRow,
  TenantGitConfigRepository,
  TenantGitConfigRow,
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
  WebhookTriggerRepository,
  WebhookTriggerRow,
  VectorCollectionRepository,
  VectorCollectionRow
} from "../types.ts";

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

export function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function rowFromDb<T>(row: Record<string, unknown>): T {
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

