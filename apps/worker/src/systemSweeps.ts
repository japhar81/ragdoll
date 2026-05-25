/**
 * Postgres-backed adapter for the platform's un-deletable sweep jobs.
 *
 * Two operations:
 *   * `staleExec` — finds every execution still in `status = 'running'` past
 *     its effective timeout and transitions it to `failed`. The timeout per
 *     execution is the pipeline_version spec's `metadata.timeoutMs`, with
 *     the platform default falling in if the spec doesn't carry one.
 *   * `retention`  — reads `retention_settings` and deletes rows in
 *     `executions`, `usage_records`, and `audit_logs` that exceed any
 *     active `max_count` or `max_age_days` cap.
 *
 * Sized to run inside a single BullMQ job so the scheduler can call it on
 * cadence and the worker's concurrency pool absorbs it alongside live
 * pipeline runs.
 */
import type {
  StaleExecSweepResult,
  RetentionSweepResult,
  SystemSweeps
} from "./handlers.ts";

/** Subset of `pg.Pool` we depend on; declared locally so this module doesn't
 *  need to drag the pg type declarations into the worker bundle. */
interface PgPoolLike {
  query<R = unknown>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export function createPostgresSystemSweeps(pool: PgPoolLike): SystemSweeps {
  return {
    async staleExec({
      defaultTimeoutMs
    }: {
      defaultTimeoutMs: number;
    }): Promise<StaleExecSweepResult> {
      // Each running execution carries pipeline_version_id, which lets us
      // join into pipeline_versions to read `spec.metadata.timeoutMs`. The
      // COALESCE applies the platform default when the spec doesn't carry
      // one; the EXTRACT(EPOCH) math handles the running duration. Updating
      // in one statement keeps the sweep within a single round-trip and
      // avoids per-row Node↔Postgres latency.
      const result = await pool.query<{ execution_id: string }>(
        `UPDATE executions e
         SET status = 'failed',
             completed_at = now(),
             error = COALESCE(NULLIF(e.error, ''), 'aborted: stuck running past timeout (stale_exec_sweep)')
         FROM pipeline_versions pv
         WHERE e.status = 'running'
           AND e.pipeline_version_id = pv.id
           AND EXTRACT(EPOCH FROM (now() - e.started_at)) * 1000 >
               COALESCE((pv.spec #>> '{metadata,timeoutMs}')::numeric, $1)
         RETURNING e.execution_id`,
        [defaultTimeoutMs]
      );
      // Catch orphaned executions whose pipeline_version row has been
      // deleted — the JOIN above filters them out, but they're the
      // longest-lived stuck rows. Fall back to the platform default.
      const orphans = await pool.query<{ execution_id: string }>(
        `UPDATE executions e
         SET status = 'failed',
             completed_at = now(),
             error = COALESCE(NULLIF(e.error, ''), 'aborted: stuck running past timeout (stale_exec_sweep, orphan version)')
         WHERE e.status = 'running'
           AND NOT EXISTS (
             SELECT 1 FROM pipeline_versions pv WHERE pv.id = e.pipeline_version_id
           )
           AND EXTRACT(EPOCH FROM (now() - e.started_at)) * 1000 > $1
         RETURNING e.execution_id`,
        [defaultTimeoutMs]
      );
      return {
        swept: (result.rowCount ?? 0) + (orphans.rowCount ?? 0),
        defaultTimeoutMs
      };
    },

    async retention(): Promise<RetentionSweepResult> {
      // Pull the current settings into one map. Empty (no rows / all-NULL
      // columns) means "no limits"; in that case every per-resource block
      // below short-circuits.
      const settings = await pool.query<{
        resource: string;
        max_count: string | null;
        max_age_days: number | null;
      }>(`SELECT resource, max_count, max_age_days FROM retention_settings`);
      interface RetentionLimits {
        maxCount: number | null;
        maxAgeDays: number | null;
      }
      const byResource = new Map<string, RetentionLimits>(
        settings.rows.map((r) => [
          r.resource,
          {
            maxCount: r.max_count !== null ? Number(r.max_count) : null,
            maxAgeDays: r.max_age_days
          } satisfies RetentionLimits
        ])
      );

      const prune = async (
        resource: "executions" | "usage" | "audit"
      ): Promise<number> => {
        const cfg = byResource.get(resource);
        if (!cfg || (cfg.maxCount === null && cfg.maxAgeDays === null)) return 0;
        const { table, timestampCol, idCol } = (() => {
          if (resource === "executions")
            return { table: "executions", timestampCol: "started_at", idCol: "id" };
          if (resource === "usage")
            return { table: "usage_records", timestampCol: "created_at", idCol: "id" };
          return { table: "audit_logs", timestampCol: "created_at", idCol: "id" };
        })();
        let deleted = 0;
        if (cfg.maxAgeDays !== null) {
          const ageRes = await pool.query(
            `DELETE FROM ${table} WHERE ${timestampCol} < now() - ($1 || ' days')::interval`,
            [String(cfg.maxAgeDays)]
          );
          deleted += ageRes.rowCount ?? 0;
        }
        if (cfg.maxCount !== null) {
          // Delete rows beyond the keep-newest-N window. The CTE picks
          // the row ids ordered by timestamp DESC and the DELETE drops
          // everything not in the top N. Cheap on the indexed timestamp.
          const countRes = await pool.query(
            `DELETE FROM ${table}
             WHERE ${idCol} IN (
               SELECT ${idCol} FROM ${table}
               ORDER BY ${timestampCol} DESC
               OFFSET $1
             )`,
            [cfg.maxCount]
          );
          deleted += countRes.rowCount ?? 0;
        }
        return deleted;
      };

      const executionsDeleted = await prune("executions");
      const usageDeleted = await prune("usage");
      const auditDeleted = await prune("audit");
      return { executionsDeleted, usageDeleted, auditDeleted };
    }
  };
}
