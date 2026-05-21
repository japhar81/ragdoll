-- 008: per-pipeline ingest state for delta-aware ingestion.
--
-- The `delta_filter` plugin uses this table to remember which source
-- documents it has already ingested for a given (tenant, pipeline,
-- state_key) so subsequent runs only emit new/modified/deleted documents.
--
-- - `state_key` lets a single pipeline maintain multiple independent
--   buckets (e.g. one for code, one for docs) without colliding.
-- - `sha256` is populated when `compareBy = hash` or `mtime+hash`.
-- - `mtime` is populated when `compareBy = mtime` or `mtime+hash`.
-- - `last_seen` is bumped every successful run so future maintenance can
--   prune entries that haven't been observed in a long time.

CREATE TABLE IF NOT EXISTS ingest_state (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  state_key   text NOT NULL,
  doc_id      text NOT NULL,
  sha256      text,
  mtime       timestamptz,
  last_seen   timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, pipeline_id, state_key, doc_id)
);

-- Common access pattern: list every row for one (tenant, pipeline,
-- state_key). The primary key already supports an efficient range scan,
-- but an explicit index helps the planner when state buckets are large.
CREATE INDEX IF NOT EXISTS ingest_state_bucket_idx
  ON ingest_state (tenant_id, pipeline_id, state_key);
