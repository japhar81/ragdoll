-- System schedules + retention settings.
--
-- Adds two columns to schedules so the cron scheduler can carry jobs beyond
-- `run_pipeline`:
--   * job_type — discriminator that drives the worker's dispatch (existing
--     rows default to 'run_pipeline').
--   * system   — flag for un-deletable platform jobs. The Scheduler UI hides
--     the delete action on system rows; cadence remains editable.
--
-- Drops NOT NULL on tenant_id / pipeline_id so system schedules can be
-- platform-wide (no tenant, no pipeline). Existing pipeline schedules still
-- carry both columns.
--
-- Then seeds the two platform jobs:
--   * stale_exec_sweep — every 5 min, fails executions running past their
--     spec.metadata.timeoutMs (or the 60-min platform default).
--   * retention_sweep — hourly, prunes executions/usage/audit rows that
--     exceed any configured count/age limit on retention_settings.
--
-- retention_settings is a tiny global table (one row per resource type). We
-- intentionally use it instead of config_values: retention is a typed
-- structured config, easier to read/write as a single row than scattered
-- key/value pairs.

ALTER TABLE schedules
  ADD COLUMN IF NOT EXISTS job_type text NOT NULL DEFAULT 'run_pipeline',
  ADD COLUMN IF NOT EXISTS system boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS params jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE schedules
  ALTER COLUMN tenant_id DROP NOT NULL,
  ALTER COLUMN pipeline_id DROP NOT NULL,
  ALTER COLUMN environment DROP NOT NULL;

-- Constraint: pipeline schedules MUST have tenant/pipeline; system ones
-- MUST NOT.
ALTER TABLE schedules
  DROP CONSTRAINT IF EXISTS schedules_system_or_pipeline_check;
ALTER TABLE schedules
  ADD CONSTRAINT schedules_system_or_pipeline_check
  CHECK (
    (system = false AND tenant_id IS NOT NULL AND pipeline_id IS NOT NULL)
    OR
    (system = true AND tenant_id IS NULL AND pipeline_id IS NULL)
  );

CREATE INDEX IF NOT EXISTS idx_schedules_job_type ON schedules(job_type);

CREATE TABLE IF NOT EXISTS retention_settings (
  resource text PRIMARY KEY CHECK (resource IN ('executions', 'usage', 'audit')),
  -- All limits are optional; NULL means "no cap on this dimension". A row
  -- with all three columns NULL is the same as no row at all.
  max_count bigint,
  max_age_days integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

-- Seed sane defaults: keep 90 days OR 10k rows of executions; same for
-- usage; 180 days for audit (compliance posture).
INSERT INTO retention_settings (resource, max_count, max_age_days)
VALUES
  ('executions', 10000, 90),
  ('usage', 100000, 90),
  ('audit', NULL, 180)
ON CONFLICT (resource) DO NOTHING;

-- Seed the two system schedules. Stable UUIDs so re-running migrations and
-- the API both land on the same rows. The cadence is editable from the
-- Scheduler screen; the rows themselves are un-deletable (`system = true`).
INSERT INTO schedules
  (id, tenant_id, pipeline_id, environment, cron, timezone, input,
   enabled, job_type, system, name, params)
VALUES
  (
    '00000000-0000-0000-0000-00000000a001',
    NULL, NULL, NULL,
    '*/5 * * * *', 'UTC', '{}'::jsonb,
    true, 'stale_exec_sweep', true,
    'System: stale execution sweep', '{}'::jsonb
  ),
  (
    '00000000-0000-0000-0000-00000000a002',
    NULL, NULL, NULL,
    '0 * * * *', 'UTC', '{}'::jsonb,
    true, 'retention_sweep', true,
    'System: retention sweep', '{}'::jsonb
  )
ON CONFLICT (id) DO NOTHING;
