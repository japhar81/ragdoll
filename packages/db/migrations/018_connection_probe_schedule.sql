-- ADR-0021 follow-through: schedule periodic probes of every external
-- connection so the Builder / admin UI surfaces red/green health
-- badges without a manual click. Worker job type `connection_probe_sweep`
-- (added alongside this migration) iterates the registry, runs each
-- driver's probe, and writes `last_probed_at`/`last_probe_ok`/
-- `last_probe_error` via ExternalConnectionRepository.recordProbe.
--
-- Cadence: every 10 minutes. Same shape + un-deletable system flag as
-- stale_exec_sweep / retention_sweep from migration 012. Operators can
-- edit the cron from the Scheduler screen; the row itself is
-- system=true so it can't be deleted out from under the platform.
--
-- Stable UUID so re-running migrations + cluster boot land on the same
-- row (matches the convention from migration 012).

INSERT INTO schedules
  (id, tenant_id, pipeline_id, environment, cron, timezone, input,
   enabled, job_type, system, name, params)
VALUES
  (
    '00000000-0000-0000-0000-00000000a003',
    NULL, NULL, NULL,
    '*/10 * * * *', 'UTC', '{}'::jsonb,
    true, 'connection_probe_sweep', true,
    'System: external connection probe sweep', '{}'::jsonb
  )
ON CONFLICT (id) DO NOTHING;
