/**
 * Postgres repositories — observability domain.
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


export class PostgresAuditLogRepository implements T.AuditLogRepository {
  private pool: PoolLike;

  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async append(row: Omit<T.AuditLogRow, "id">): Promise<T.AuditLogRow> {
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
  ): Promise<T.AuditLogRow[]> {
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

  /** Cursor-paginated list. Mirror of executions: indexes on (created_at, id)
   *  so tuple-comparison stays cheap; fetch limit+1 to detect more pages. */
  async listPage(args: {
    tenantId?: UUID;
    limit: number;
    cursor?: string;
  }): Promise<{ rows: T.AuditLogRow[]; nextCursor: string | null; total: number }> {
    const parsed = parseCursorRaw(args.cursor);
    const filterConditions: string[] = [];
    const filterParams: unknown[] = [];
    if (args.tenantId !== undefined) {
      filterParams.push(args.tenantId);
      filterConditions.push(`tenant_id = $${filterParams.length}`);
    }
    const countWhere = filterConditions.length
      ? `WHERE ${filterConditions.join(" AND ")}`
      : "";
    // Page query carries the same filter PLUS the cursor predicate.
    const pageConditions = [...filterConditions];
    const pageParams = [...filterParams];
    if (parsed) {
      pageParams.push(parsed.timestamp);
      pageParams.push(parsed.id);
      pageConditions.push(
        `(created_at, id) < ($${pageParams.length - 1}::timestamptz, $${pageParams.length}::uuid)`
      );
    }
    const pageWhere = pageConditions.length
      ? `WHERE ${pageConditions.join(" AND ")}`
      : "";
    pageParams.push(args.limit + 1);
    // Issue the page + count in parallel — the COUNT(*) uses the filter
    // WITHOUT the cursor predicate so the footer reflects the entire
    // result set, not just the slice past the current cursor.
    const [result, countResult] = await Promise.all([
      this.pool.query<Record<string, unknown>>(
        `SELECT * FROM audit_logs ${pageWhere} ORDER BY created_at DESC, id DESC LIMIT $${pageParams.length}`,
        pageParams
      ),
      this.pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM audit_logs ${countWhere}`,
        filterParams
      )
    ]);
    const allRows = result.rows.map(mapAuditLog);
    const overflow = allRows.length > args.limit;
    const rows = overflow ? allRows.slice(0, args.limit) : allRows;
    const nextCursor =
      overflow && rows.length > 0
        ? encodeCursorRaw(rows[rows.length - 1].createdAt, rows[rows.length - 1].id)
        : null;
    return {
      rows,
      nextCursor,
      total: Number(countResult.rows[0]?.total ?? 0)
    };
  }
}

/** Cursor codec — kept local so audit/usage repos don't have to depend on
 *  the same `postgres.ts` helper from a different package boundary. */
function parseCursorRaw(
  raw: string | undefined
): { timestamp: string; id: string } | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    const parsed = JSON.parse(decoded) as { t?: unknown; i?: unknown };
    if (typeof parsed.t === "string" && typeof parsed.i === "string") {
      return { timestamp: parsed.t, id: parsed.i };
    }
    return null;
  } catch {
    return null;
  }
}
function encodeCursorRaw(timestamp: string, id: string): string {
  return Buffer.from(JSON.stringify({ t: timestamp, i: id })).toString("base64url");
}

function mapAuditLog(row: Record<string, unknown>): T.AuditLogRow {
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


export class PostgresUsageRecordRepository implements T.UsageRecordRepository {
  private pool: PoolLike;

  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async append(
    row: Omit<T.UsageRecordRow, "id" | "createdAt">
  ): Promise<T.UsageRecordRow> {
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

  async listPage(args: {
    tenantId?: UUID;
    limit: number;
    cursor?: string;
  }): Promise<{ rows: T.UsageRecordRow[]; nextCursor: string | null; total: number }> {
    const parsed = parseCursorRaw(args.cursor);
    const filterConditions: string[] = [];
    const filterParams: unknown[] = [];
    if (args.tenantId !== undefined) {
      filterParams.push(args.tenantId);
      filterConditions.push(`tenant_id = $${filterParams.length}`);
    }
    const countWhere = filterConditions.length
      ? `WHERE ${filterConditions.join(" AND ")}`
      : "";
    const pageConditions = [...filterConditions];
    const pageParams = [...filterParams];
    if (parsed) {
      pageParams.push(parsed.timestamp);
      pageParams.push(parsed.id);
      pageConditions.push(
        `(created_at, id) < ($${pageParams.length - 1}::timestamptz, $${pageParams.length}::uuid)`
      );
    }
    const pageWhere = pageConditions.length
      ? `WHERE ${pageConditions.join(" AND ")}`
      : "";
    pageParams.push(args.limit + 1);
    const [result, countResult] = await Promise.all([
      this.pool.query<Record<string, unknown>>(
        `SELECT * FROM usage_records ${pageWhere} ORDER BY created_at DESC, id DESC LIMIT $${pageParams.length}`,
        pageParams
      ),
      this.pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM usage_records ${countWhere}`,
        filterParams
      )
    ]);
    const allRows = result.rows.map(mapUsageRecord);
    const overflow = allRows.length > args.limit;
    const rows = overflow ? allRows.slice(0, args.limit) : allRows;
    const nextCursor =
      overflow && rows.length > 0
        ? encodeCursorRaw(rows[rows.length - 1].createdAt, rows[rows.length - 1].id)
        : null;
    return {
      rows,
      nextCursor,
      total: Number(countResult.rows[0]?.total ?? 0)
    };
  }

  async list(
    filter: { tenantId?: UUID; executionId?: string } = {}
  ): Promise<T.UsageRecordRow[]> {
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

function mapUsageRecord(row: Record<string, unknown>): T.UsageRecordRow {
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


export class PostgresRetentionSettingsRepository
  implements T.RetentionSettingsRepository
{
  private pool: PoolLike;
  constructor(pool: PoolLike) {
    this.pool = pool;
  }
  async list(): Promise<T.RetentionSettingRow[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT resource, max_count, max_age_days, updated_at, updated_by
       FROM retention_settings ORDER BY resource`
    );
    return result.rows.map(mapRetentionRow);
  }
  async upsert(input: {
    resource: T.RetentionSettingRow["resource"];
    maxCount: number | null;
    maxAgeDays: number | null;
    updatedBy?: string;
  }): Promise<T.RetentionSettingRow> {
    const result = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO retention_settings (resource, max_count, max_age_days, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (resource) DO UPDATE SET
         max_count = EXCLUDED.max_count,
         max_age_days = EXCLUDED.max_age_days,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING resource, max_count, max_age_days, updated_at, updated_by`,
      [
        input.resource,
        input.maxCount,
        input.maxAgeDays,
        toUuidOrNull(input.updatedBy)
      ]
    );
    return mapRetentionRow(result.rows[0]);
  }
}

function mapRetentionRow(row: Record<string, unknown>): T.RetentionSettingRow {
  return {
    resource: row.resource as T.RetentionSettingRow["resource"],
    maxCount: row.max_count !== null ? Number(row.max_count) : null,
    maxAgeDays: row.max_age_days as number | null,
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : (row.updated_at as string),
    updatedBy: (row.updated_by as string | null) ?? null
  };
}


/**
 * Postgres-backed `IngestStateRepository`. Each row is one source document
 * the `delta_filter` plugin has previously ingested for the named
 * (tenant, pipeline, stateKey) bucket. The plugin computes new/modified/
 * deleted in memory and hands the full new set to `replaceAll`, which we
 * apply transactionally so a partial failure can't leave the bucket
 * half-updated.
 */
export class PostgresIngestStateRepository {
  private pool: PoolLike;

  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async list(args: {
    tenantId: string;
    pipelineId: string;
    stateKey: string;
  }): Promise<Array<{ docId: string; sha256?: string; mtime?: string; lastSeen: string }>> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT doc_id, sha256, mtime, last_seen
         FROM ingest_state
        WHERE tenant_id = $1 AND pipeline_id = $2 AND state_key = $3`,
      [args.tenantId, args.pipelineId, args.stateKey]
    );
    return r.rows.map((row) => ({
      docId: String(row.doc_id),
      sha256: row.sha256 === null || row.sha256 === undefined ? undefined : String(row.sha256),
      mtime:
        row.mtime === null || row.mtime === undefined
          ? undefined
          : new Date(row.mtime as string).toISOString(),
      lastSeen: new Date(row.last_seen as string).toISOString()
    }));
  }

  async replaceAll(args: {
    tenantId: string;
    pipelineId: string;
    stateKey: string;
    entries: Array<{ docId: string; sha256?: string; mtime?: string; lastSeen: string }>;
  }): Promise<void> {
    await withTransaction(this.pool, async (tx) => {
      await tx.query(
        `DELETE FROM ingest_state
          WHERE tenant_id = $1 AND pipeline_id = $2 AND state_key = $3`,
        [args.tenantId, args.pipelineId, args.stateKey]
      );
      for (const entry of args.entries) {
        await tx.query(
          `INSERT INTO ingest_state
             (tenant_id, pipeline_id, state_key, doc_id, sha256, mtime, last_seen)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            args.tenantId,
            args.pipelineId,
            args.stateKey,
            entry.docId,
            entry.sha256 ?? null,
            entry.mtime ?? null,
            entry.lastSeen
          ]
        );
      }
    });
  }
}

