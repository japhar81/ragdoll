/**
 * Postgres repositories — config domain.
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


/**
 * Postgres `T.ConfigDefinitionRepository` over the `config_definitions` table.
 * The table is keyed by `key` (not `id`), so it cannot reuse the generic
 * `PostgresCrudRepository`; `upsert` performs an `ON CONFLICT (key)` merge.
 */
export class PostgresConfigDefinitionRepository
  implements T.ConfigDefinitionRepository
{
  private pool: PoolLike;

  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async upsert(row: T.ConfigDefinitionRow): Promise<T.ConfigDefinitionRow> {
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

  async get(key: string): Promise<T.ConfigDefinitionRow | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM config_definitions WHERE key = $1`,
      [key]
    );
    return result.rows[0] ? mapConfigDefinition(result.rows[0]) : undefined;
  }

  async require(key: string): Promise<T.ConfigDefinitionRow> {
    const row = await this.get(key);
    if (!row) throw new NotFoundError("config_definition", key);
    return row;
  }

  async delete(key: string): Promise<void> {
    await this.pool.query(`DELETE FROM config_definitions WHERE key = $1`, [
      key
    ]);
  }

  async list(): Promise<T.ConfigDefinitionRow[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM config_definitions`
    );
    return result.rows.map(mapConfigDefinition);
  }
}

function mapConfigDefinition(
  row: Record<string, unknown>
): T.ConfigDefinitionRow {
  return {
    key: row.key as string,
    type: row.type as T.ConfigDefinitionRow["type"],
    defaultValue: row.default_value,
    allowedScopes: (row.allowed_scopes ??
      []) as T.ConfigDefinitionRow["allowedScopes"],
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


export class PostgresConfigValueRepository implements T.ConfigValueRepository {
  private pool: PoolLike;

  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async upsert(
    input: Omit<T.ConfigValueRow, "id" | "createdAt" | "updatedAt"> &
      Partial<Pick<T.ConfigValueRow, "id" | "createdAt" | "updatedAt">>
  ): Promise<T.ConfigValueRow> {
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

  async get(id: UUID): Promise<T.ConfigValueRow | undefined> {
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
    filter: T.ConfigValueScopeFilter = {}
  ): Promise<T.ConfigValueRow[]> {
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

function mapConfigValue(row: Record<string, unknown>): T.ConfigValueRow {
  return {
    id: row.id as string,
    key: row.key as string,
    value: row.value,
    scope: row.scope as T.ConfigValueRow["scope"],
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

