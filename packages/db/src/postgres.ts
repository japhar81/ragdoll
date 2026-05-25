import type { SecretRef, UsageRecord } from "../../core/src/index.ts";
import type {
  ExecutionNodeRecord,
  ExecutionRecord,
  ExecutionStore
} from "../../runtime/src/index.ts";
import type { SecretRecord, SecretRepository } from "../../secrets/src/index.ts";
import { secretRefKey } from "../../secrets/src/index.ts";
import type { PoolLike } from "./pool.ts";

/**
 * Postgres `ExecutionStore` writing to executions / execution_nodes /
 * usage_records. Implements the exact runtime contract; the runtime package
 * owns the in-memory variant.
 *
 * `tenantId` / `pipelineId` / `pipelineVersionId` on the runtime records are
 * the canonical uuids of the corresponding rows.
 */
export class PostgresExecutionStore implements ExecutionStore {
  private pool: PoolLike;

  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async start(record: ExecutionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO executions
         (execution_id, tenant_id, pipeline_id, pipeline_version_id, environment, status, input_redacted, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (execution_id) DO UPDATE SET
         status = EXCLUDED.status,
         input_redacted = EXCLUDED.input_redacted`,
      [
        record.executionId,
        record.tenantId,
        record.pipelineId,
        record.pipelineVersionId,
        // ExecutionRecord has no environment field; default to the value the
        // executions table requires. Callers that need a real environment can
        // patch the row directly.
        "unknown",
        record.status,
        record.input === undefined ? null : JSON.stringify(record.input),
        record.startedAt
      ]
    );
  }

  async complete(record: ExecutionRecord): Promise<void> {
    await this.pool.query(
      `UPDATE executions SET
         status = $2,
         output_redacted = $3,
         error = $4,
         completed_at = $5
       WHERE execution_id = $1`,
      [
        record.executionId,
        record.status,
        record.output === undefined ? null : JSON.stringify(record.output),
        record.error ?? null,
        record.completedAt ?? new Date().toISOString()
      ]
    );
  }

  async startNode(record: ExecutionNodeRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO execution_nodes
         (execution_id, node_id, status, input_redacted, started_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        record.executionId,
        record.nodeId,
        record.status,
        record.input === undefined ? null : JSON.stringify(record.input),
        record.startedAt
      ]
    );
  }

  async completeNode(record: ExecutionNodeRecord): Promise<void> {
    await this.pool.query(
      `UPDATE execution_nodes SET
         status = $3,
         output_redacted = $4,
         error = $5,
         latency_ms = $6,
         completed_at = $7
       WHERE execution_id = $1 AND node_id = $2`,
      [
        record.executionId,
        record.nodeId,
        record.status,
        record.output === undefined ? null : JSON.stringify(record.output),
        record.error ?? null,
        record.latencyMs ?? null,
        record.completedAt ?? new Date().toISOString()
      ]
    );
  }

  async recordUsage(record: UsageRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO usage_records
         (tenant_id, pipeline_id, execution_id, provider, model,
          input_tokens, output_tokens, embedding_tokens, estimated_cost_usd,
          latency_ms, success)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        record.tenantId,
        record.pipelineId ?? null,
        record.executionId ?? null,
        record.provider ?? null,
        record.model ?? null,
        record.inputTokens ?? 0,
        record.outputTokens ?? 0,
        record.embeddingTokens ?? 0,
        record.estimatedCostUsd ?? 0,
        record.latencyMs ?? null,
        record.success
      ]
    );
  }

  // ---- read path (control-plane ReadableExecutionStore) -----------------
  async listExecutions(tenantId?: string): Promise<ExecutionRecord[]> {
    const result =
      tenantId === undefined
        ? await this.pool.query<Record<string, unknown>>(
            `SELECT * FROM executions ORDER BY started_at DESC`
          )
        : await this.pool.query<Record<string, unknown>>(
            `SELECT * FROM executions WHERE tenant_id = $1 ORDER BY started_at DESC`,
            [tenantId]
          );
    return result.rows.map(rowToExecutionRecord);
  }

  /**
   * Cursor-paginated executions list ordered by (started_at DESC, id DESC).
   * Cursor decodes to a `{timestamp, id}` from the last row of the previous
   * page; the WHERE clause selects rows strictly older than that anchor.
   * `limit` is clamped 1..200 by the caller (the API route).
   */
  async listExecutionsPage(args: {
    tenantId?: string;
    limit: number;
    cursor?: string;
  }): Promise<{ rows: ExecutionRecord[]; nextCursor: string | null; total: number }> {
    const parsed = parseCursor(args.cursor);
    const filterClauses: string[] = [];
    const filterParams: unknown[] = [];
    if (args.tenantId !== undefined) {
      filterParams.push(args.tenantId);
      filterClauses.push(`tenant_id = $${filterParams.length}`);
    }
    const countWhere = filterClauses.length
      ? `WHERE ${filterClauses.join(" AND ")}`
      : "";
    // Page query layers the cursor predicate on top of the filter.
    const pageClauses = [...filterClauses];
    const pageParams = [...filterParams];
    if (parsed) {
      pageParams.push(parsed.timestamp);
      pageParams.push(parsed.id);
      pageClauses.push(
        `(started_at, id) < ($${pageParams.length - 1}::timestamptz, $${pageParams.length}::uuid)`
      );
    }
    const pageWhere = pageClauses.length
      ? `WHERE ${pageClauses.join(" AND ")}`
      : "";
    pageParams.push(args.limit + 1);
    // Total uses the filter WITHOUT the cursor predicate so the UI
    // footer reflects the whole result set across all pages.
    const [result, countResult] = await Promise.all([
      this.pool.query<Record<string, unknown>>(
        `SELECT * FROM executions ${pageWhere}
         ORDER BY started_at DESC, id DESC
         LIMIT $${pageParams.length}`,
        pageParams
      ),
      this.pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM executions ${countWhere}`,
        filterParams
      )
    ]);
    const allRows = result.rows.map(rowToExecutionRecord);
    const overflow = allRows.length > args.limit;
    const rows = overflow ? allRows.slice(0, args.limit) : allRows;
    let nextCursor: string | null = null;
    if (overflow && rows.length > 0) {
      const last = rows[rows.length - 1];
      const lastRow = result.rows[args.limit - 1];
      nextCursor = encodeCursorRaw(
        last.startedAt,
        String(lastRow.id ?? lastRow.execution_id)
      );
    }
    return {
      rows,
      nextCursor,
      total: Number(countResult.rows[0]?.total ?? 0)
    };
  }

  async getExecution(
    executionId: string
  ): Promise<ExecutionRecord | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM executions WHERE execution_id = $1`,
      [executionId]
    );
    return result.rows[0]
      ? rowToExecutionRecord(result.rows[0])
      : undefined;
  }

  async listNodes(executionId: string): Promise<ExecutionNodeRecord[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM execution_nodes WHERE execution_id = $1 ORDER BY started_at`,
      [executionId]
    );
    return result.rows.map(rowToExecutionNodeRecord);
  }
}

function toIso(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : undefined;
}

/** Decode an opaque {timestamp, id} cursor token; returns null when the
 *  caller passed nothing or the token was malformed. Mirror of the
 *  encode helper below so server-side pagination cursors round-trip. */
export function parseCursor(
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

/** Encode a `(timestamp, id)` tuple into the opaque base64url token the
 *  next page request echoes back. */
export function encodeCursorRaw(timestamp: string, id: string): string {
  return Buffer.from(JSON.stringify({ t: timestamp, i: id })).toString("base64url");
}

function rowToExecutionRecord(
  row: Record<string, unknown>
): ExecutionRecord {
  return {
    executionId: row.execution_id as string,
    tenantId: row.tenant_id as string,
    pipelineId: row.pipeline_id as string,
    pipelineVersionId: row.pipeline_version_id as string,
    status: row.status as ExecutionRecord["status"],
    startedAt: toIso(row.started_at) ?? new Date(0).toISOString(),
    completedAt: toIso(row.completed_at),
    input: row.input_redacted ?? undefined,
    output: row.output_redacted ?? undefined,
    error: (row.error as string | null) ?? undefined
  };
}

function rowToExecutionNodeRecord(
  row: Record<string, unknown>
): ExecutionNodeRecord {
  return {
    executionId: row.execution_id as string,
    nodeId: row.node_id as string,
    status: row.status as ExecutionNodeRecord["status"],
    startedAt: toIso(row.started_at) ?? new Date(0).toISOString(),
    completedAt: toIso(row.completed_at),
    latencyMs:
      row.latency_ms === null || row.latency_ms === undefined
        ? undefined
        : Number(row.latency_ms),
    input: row.input_redacted ?? undefined,
    output: row.output_redacted ?? undefined,
    error: (row.error as string | null) ?? undefined
  };
}

interface SecretJoinRow {
  ref_id: string;
  logical_key: string;
  scope: string;
  tenant_id: string | null;
  environment: string | null;
  provider: string;
  ref_metadata: Record<string, unknown>;
  ref_created_at: string;
  version: number | null;
  key_id: string | null;
  ciphertext: string | null;
  secret_metadata: Record<string, unknown> | null;
  secret_created_at: string | null;
}

const SECRET_SELECT = `
  SELECT
    r.id AS ref_id,
    r.logical_key,
    r.scope,
    r.tenant_id,
    r.environment,
    r.provider,
    r.metadata AS ref_metadata,
    r.created_at AS ref_created_at,
    s.version,
    s.key_id,
    s.ciphertext,
    s.metadata AS secret_metadata,
    s.created_at AS secret_created_at
  FROM secret_refs r
  LEFT JOIN LATERAL (
    SELECT * FROM encrypted_secrets e
    WHERE e.secret_ref_id = r.id
    ORDER BY e.version DESC
    LIMIT 1
  ) s ON true`;

function rowToSecretRecord(row: SecretJoinRow): SecretRecord {
  const ref: SecretRef = {
    provider: row.provider as SecretRef["provider"],
    scope: row.scope as SecretRef["scope"],
    tenantId: row.tenant_id ?? undefined,
    environment: row.environment ?? undefined,
    key: row.logical_key
  };
  return {
    id: row.ref_id,
    provider: row.provider as SecretRecord["provider"],
    ref,
    ciphertext: row.ciphertext ?? "",
    version: String(row.version ?? 0),
    keyId: row.key_id ?? "",
    createdAt: row.secret_created_at ?? row.ref_created_at,
    updatedAt: row.secret_created_at ?? row.ref_created_at,
    metadata: (row.secret_metadata ?? row.ref_metadata) as Record<string, unknown>
  };
}

/**
 * Postgres `SecretRepository` over secret_refs + encrypted_secrets. Implements
 * the exact secrets-package contract; the secrets package owns the in-memory
 * variant.
 */
export class PostgresSecretRepository implements SecretRepository {
  private pool: PoolLike;

  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async upsert(record: SecretRecord): Promise<SecretRecord> {
    const ref = record.ref;
    const refResult = await this.pool.query<{ id: string }>(
      `INSERT INTO secret_refs (logical_key, scope, tenant_id, environment, provider, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (logical_key, scope, tenant_id, environment) DO UPDATE SET
         provider = EXCLUDED.provider,
         metadata = EXCLUDED.metadata
       RETURNING id`,
      [
        ref.key,
        ref.scope,
        ref.tenantId ?? null,
        ref.environment ?? null,
        record.provider,
        JSON.stringify(record.metadata ?? {})
      ]
    );
    const secretRefId = refResult.rows[0].id;
    await this.pool.query(
      `INSERT INTO encrypted_secrets (secret_ref_id, version, key_id, ciphertext, metadata)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (secret_ref_id, version) DO UPDATE SET
         key_id = EXCLUDED.key_id,
         ciphertext = EXCLUDED.ciphertext,
         metadata = EXCLUDED.metadata,
         rotated_at = now()`,
      [
        secretRefId,
        Number(record.version),
        record.keyId,
        record.ciphertext,
        JSON.stringify(record.metadata ?? {})
      ]
    );
    return { ...record, id: secretRefId };
  }

  async find(ref: SecretRef): Promise<SecretRecord | undefined> {
    const result = await this.pool.query<SecretJoinRow>(
      `${SECRET_SELECT}
       WHERE r.logical_key = $1 AND r.scope = $2
         AND r.tenant_id IS NOT DISTINCT FROM $3
         AND r.environment IS NOT DISTINCT FROM $4
       LIMIT 1`,
      [ref.key, ref.scope, ref.tenantId ?? null, ref.environment ?? null]
    );
    const row = result.rows[0];
    return row ? rowToSecretRecord(row) : undefined;
  }

  async delete(ref: SecretRef): Promise<void> {
    await this.pool.query(
      `DELETE FROM secret_refs
       WHERE logical_key = $1 AND scope = $2
         AND tenant_id IS NOT DISTINCT FROM $3
         AND environment IS NOT DISTINCT FROM $4`,
      [ref.key, ref.scope, ref.tenantId ?? null, ref.environment ?? null]
    );
  }

  async list(scope: Partial<SecretRef>): Promise<SecretRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (scope.key !== undefined) {
      params.push(scope.key);
      conditions.push(`r.logical_key = $${params.length}`);
    }
    if (scope.scope !== undefined) {
      params.push(scope.scope);
      conditions.push(`r.scope = $${params.length}`);
    }
    if (scope.tenantId !== undefined) {
      params.push(scope.tenantId);
      conditions.push(`r.tenant_id = $${params.length}`);
    }
    if (scope.environment !== undefined) {
      params.push(scope.environment);
      conditions.push(`r.environment = $${params.length}`);
    }
    if (scope.provider !== undefined) {
      params.push(scope.provider);
      conditions.push(`r.provider = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query<SecretJoinRow>(
      `${SECRET_SELECT} ${where}`,
      params
    );
    return result.rows.map(rowToSecretRecord);
  }
}

export { secretRefKey };
