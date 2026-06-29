/**
 * Postgres repositories — pipelines domain.
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


export class PostgresPipelineRepository
  extends PostgresCrudRepository<T.PipelineRow>
  implements T.PipelineRepository
{
  constructor(pool: PoolLike) {
    super(pool, "pipelines", "pipeline", ["labels"], ["createdBy"]);
  }
  async findBySlug(slug: string): Promise<T.PipelineRow | undefined> {
    return (
      await this.queryRows(`SELECT * FROM pipelines WHERE slug = $1`, [slug])
    )[0];
  }
  async setLatestVersion(
    pipelineId: UUID,
    versionId: UUID | null
  ): Promise<T.PipelineRow> {
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
  ): Promise<T.PipelineRow> {
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


export class PostgresPipelineVersionRepository
  extends PostgresCrudRepository<T.PipelineVersionRow>
  implements T.PipelineVersionRepository
{
  constructor(pool: PoolLike) {
    super(pool, "pipeline_versions", "pipeline_version", ["spec"], [
      "createdBy"
    ]);
  }
  async listByPipeline(pipelineId: UUID): Promise<T.PipelineVersionRow[]> {
    return this.queryRows(
      `SELECT * FROM pipeline_versions WHERE pipeline_id = $1 ORDER BY created_at`,
      [pipelineId]
    );
  }
  async findByVersion(
    pipelineId: UUID,
    version: string
  ): Promise<T.PipelineVersionRow | undefined> {
    return (
      await this.queryRows(
        `SELECT * FROM pipeline_versions WHERE pipeline_id = $1 AND version = $2`,
        [pipelineId, version]
      )
    )[0];
  }
}


export class PostgresPipelineDeploymentRepository
  extends PostgresCrudRepository<T.PipelineDeploymentRow>
  implements T.PipelineDeploymentRepository
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
  ): Promise<T.PipelineDeploymentRow | undefined> {
    return (
      await this.queryRows(
        // ORDER BY deployed_at DESC so that even if duplicate active
        // rows exist (pre-026 global deploys, or a row that races the
        // NULLS-NOT-DISTINCT constraint), we always resolve the MOST
        // RECENT deployment rather than an arbitrary one — the bug
        // behind issues-log #6. (See migration 026.)
        `SELECT * FROM pipeline_deployments
         WHERE pipeline_id = $1 AND environment = $2
           AND tenant_id IS NOT DISTINCT FROM $3
           AND status = 'active'
         ORDER BY deployed_at DESC, id DESC
         LIMIT 1`,
        [pipelineId, environment, tenantId ?? null]
      )
    )[0];
  }
  async listByPipeline(pipelineId: UUID): Promise<T.PipelineDeploymentRow[]> {
    return this.queryRows(
      `SELECT * FROM pipeline_deployments WHERE pipeline_id = $1`,
      [pipelineId]
    );
  }
  /**
   * Atomic upsert keyed on `(pipeline_id, environment, tenant_id)` — the
   * same triple the unique index protects. Re-deploying the same pipeline
   * to the same env/tenant swaps the active version in place; first deploy
   * inserts. Status is forced back to `active` so a previously-paused row
   * comes alive on redeploy. `deployed_by` is coerced through `toUuidOrNull`
   * so a dev principal id ("dev-user") becomes NULL instead of raising an
   * "invalid input syntax for type uuid" error.
   */
  async upsertActive(
    row: T.PipelineDeploymentRow
  ): Promise<T.PipelineDeploymentRow> {
    const deployedBy = toUuidOrNull(row.deployedBy);
    const result = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO pipeline_deployments
         (id, pipeline_id, pipeline_version_id, environment, tenant_id,
          status, deployed_by, deployed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (pipeline_id, environment, tenant_id)
       DO UPDATE SET
         pipeline_version_id = EXCLUDED.pipeline_version_id,
         status = 'active',
         deployed_by = EXCLUDED.deployed_by,
         deployed_at = EXCLUDED.deployed_at
       RETURNING *`,
      [
        row.id,
        row.pipelineId,
        row.pipelineVersionId,
        row.environment,
        row.tenantId ?? null,
        row.status ?? "active",
        deployedBy,
        row.deployedAt
      ]
    );
    return rowFromDb<T.PipelineDeploymentRow>(result.rows[0]);
  }
  async deleteByEnvironment(
    environment: string,
    tenantId?: UUID | null
  ): Promise<number> {
    // NULL-safe match — a global deployment (tenant_id IS NULL) vs a
    // per-tenant deployment for the same env name are distinct rows;
    // we only drop the ones that share BOTH dimensions with the
    // environment being removed.
    const result = await this.pool.query<Record<string, unknown>>(
      `DELETE FROM pipeline_deployments
       WHERE environment = $1
         AND tenant_id IS NOT DISTINCT FROM $2`,
      [environment, tenantId ?? null]
    );
    return result.rowCount ?? 0;
  }
}

/**
 * Postgres `T.TenantPipelineRepository` over the `tenant_pipelines` table
 * (composite PK tenant_id + pipeline_id + environment, from 001). It cannot
 * reuse the generic id-keyed CRUD repo, so it mirrors the in-memory contract
 * directly: `upsert` is an `ON CONFLICT` merge on the composite PK.
 */

export class PostgresPipelineFolderRepository
  extends PostgresCrudRepository<T.PipelineFolderRow>
  implements T.PipelineFolderRepository
{
  constructor(pool: PoolLike) {
    super(pool, "pipeline_folders", "pipeline_folder");
  }

  async rename(id: UUID, name: string): Promise<T.PipelineFolderRow> {
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

  async listChildren(parentId: UUID | null): Promise<T.PipelineFolderRow[]> {
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

  async tree(): Promise<T.PipelineFolderTreeNode[]> {
    const all = await this.list();
    const byParent = new Map<string, T.PipelineFolderRow[]>();
    for (const row of all) {
      const key = row.parentId ?? " root";
      const bucket = byParent.get(key) ?? [];
      bucket.push(row);
      byParent.set(key, bucket);
    }
    const build = (row: T.PipelineFolderRow): T.PipelineFolderTreeNode => ({
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
  extends PostgresCrudRepository<T.PipelineActivationRow>
  implements T.PipelineActivationRepository
{
  constructor(pool: PoolLike) {
    super(pool, "pipeline_activations", "pipeline_activation");
  }

  async listByTenantPipelineEnv(
    tenantId: UUID,
    pipelineId: UUID,
    environment: string
  ): Promise<T.PipelineActivationRow[]> {
    return this.queryRows(
      `SELECT * FROM pipeline_activations
       WHERE tenant_id = $1 AND pipeline_id = $2 AND environment = $3
       ORDER BY label`,
      [tenantId, pipelineId, environment]
    );
  }

  async listByTenant(tenantId: UUID): Promise<T.PipelineActivationRow[]> {
    return this.queryRows(
      `SELECT * FROM pipeline_activations WHERE tenant_id = $1`,
      [tenantId]
    );
  }

  async listByPipeline(pipelineId: UUID): Promise<T.PipelineActivationRow[]> {
    return this.queryRows(
      `SELECT * FROM pipeline_activations WHERE pipeline_id = $1`,
      [pipelineId]
    );
  }
}


/**
 * Postgres `T.TenantPipelineRepository` over the `tenant_pipelines` table
 * (composite PK tenant_id + pipeline_id + environment, from 001). It cannot
 * reuse the generic id-keyed CRUD repo, so it mirrors the in-memory contract
 * directly: `upsert` is an `ON CONFLICT` merge on the composite PK.
 */
export class PostgresTenantPipelineRepository
  implements T.TenantPipelineRepository
{
  private pool: PoolLike;

  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async upsert(row: T.TenantPipelineRow): Promise<T.TenantPipelineRow> {
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

  async get(key: T.TenantPipelineKey): Promise<T.TenantPipelineRow | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM tenant_pipelines
       WHERE tenant_id = $1 AND pipeline_id = $2 AND environment = $3`,
      [key.tenantId, key.pipelineId, key.environment]
    );
    return result.rows[0] ? mapTenantPipeline(result.rows[0]) : undefined;
  }

  async require(key: T.TenantPipelineKey): Promise<T.TenantPipelineRow> {
    const row = await this.get(key);
    if (!row) {
      throw new NotFoundError(
        "tenant_pipeline",
        `${key.tenantId}:${key.pipelineId}:${key.environment}`
      );
    }
    return row;
  }

  async delete(key: T.TenantPipelineKey): Promise<void> {
    await this.pool.query(
      `DELETE FROM tenant_pipelines
       WHERE tenant_id = $1 AND pipeline_id = $2 AND environment = $3`,
      [key.tenantId, key.pipelineId, key.environment]
    );
  }

  async listByTenant(tenantId: UUID): Promise<T.TenantPipelineRow[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM tenant_pipelines WHERE tenant_id = $1`,
      [tenantId]
    );
    return result.rows.map(mapTenantPipeline);
  }
}

function mapTenantPipeline(
  row: Record<string, unknown>
): T.TenantPipelineRow {
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


export class PostgresScheduleRepository
  extends PostgresCrudRepository<T.ScheduleRow>
  implements T.ScheduleRepository
{
  constructor(pool: PoolLike) {
    super(pool, "schedules", "schedule", ["input", "params"]);
  }

  async listEnabled(): Promise<T.ScheduleRow[]> {
    return this.queryRows(
      `SELECT * FROM schedules WHERE enabled = true ORDER BY next_run_at NULLS LAST`
    );
  }

  async listDue(nowIso: string): Promise<T.ScheduleRow[]> {
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
  ): Promise<T.ScheduleRow> {
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

