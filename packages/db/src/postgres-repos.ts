import type { UUID } from "../../core/src/index.ts";
import { ConflictError, NotFoundError } from "./errors.ts";
import type { PoolLike } from "./pool.ts";
import type {
  ApiKeyRepository,
  ApiKeyRow,
  AuditLogRepository,
  AuditLogRow,
  ConfigValueRepository,
  ConfigValueRow,
  ConfigValueScopeFilter,
  PipelineDeploymentRepository,
  PipelineDeploymentRow,
  PipelineVersionRepository,
  PipelineVersionRow,
  TenantRepository,
  TenantRow,
  UsageRecordRepository,
  UsageRecordRow
} from "./types.ts";

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

  constructor(
    pool: PoolLike,
    table: string,
    entity: string,
    jsonColumns: string[] = []
  ) {
    this.pool = pool;
    this.table = table;
    this.entity = entity;
    this.jsonColumns = new Set(jsonColumns.map(camelToSnake));
  }

  private serialize(column: string, value: unknown): unknown {
    if (this.jsonColumns.has(column)) return JSON.stringify(value ?? null);
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

export class PostgresPipelineVersionRepository
  extends PostgresCrudRepository<PipelineVersionRow>
  implements PipelineVersionRepository
{
  constructor(pool: PoolLike) {
    super(pool, "pipeline_versions", "pipeline_version", ["spec"]);
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
    super(pool, "pipeline_deployments", "pipeline_deployment");
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
        input.createdBy ?? null
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
        row.actorId ?? null,
        row.tenantId ?? null,
        row.pipelineId ?? null,
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
