-- Tenant DELETE cascades.
--
-- The original schema (001) declared `audit_logs.tenant_id`,
-- `usage_records.tenant_id`, `executions.tenant_id`, plus matching
-- `pipeline_id` FKs WITHOUT `ON DELETE CASCADE`. DROP TENANT then fails
-- with `update or delete on table "tenants" violates foreign key constraint`
-- and the operator is stuck — there is no clean way to fully decommission
-- a tenant + everything that referenced it.
--
-- This migration swaps every tenant-rooted FK in those three tables to
-- ON DELETE CASCADE so `DELETE /api/tenants/:id` cleanly cascades through
-- the entire ownership tree. Same fix for the pipeline-rooted FKs since
-- deleting a pipeline (already CASCADE on tenants → pipelines) must also
-- cascade through its executions, audit, and usage rows.
--
-- The audit_logs.actor_id / executions.actor_id stay as plain FKs (no
-- CASCADE) because operators can be deleted independently of their work
-- log; SET NULL would be safer but actor_id rows are already NULLABLE
-- and the records survive a NULL actor.

ALTER TABLE audit_logs
  DROP CONSTRAINT IF EXISTS audit_logs_tenant_id_fkey,
  ADD CONSTRAINT audit_logs_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE audit_logs
  DROP CONSTRAINT IF EXISTS audit_logs_pipeline_id_fkey,
  ADD CONSTRAINT audit_logs_pipeline_id_fkey
    FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE;

ALTER TABLE usage_records
  DROP CONSTRAINT IF EXISTS usage_records_tenant_id_fkey,
  ADD CONSTRAINT usage_records_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE usage_records
  DROP CONSTRAINT IF EXISTS usage_records_pipeline_id_fkey,
  ADD CONSTRAINT usage_records_pipeline_id_fkey
    FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE;

ALTER TABLE executions
  DROP CONSTRAINT IF EXISTS executions_tenant_id_fkey,
  ADD CONSTRAINT executions_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE executions
  DROP CONSTRAINT IF EXISTS executions_pipeline_id_fkey,
  ADD CONSTRAINT executions_pipeline_id_fkey
    FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE;

ALTER TABLE executions
  DROP CONSTRAINT IF EXISTS executions_pipeline_version_id_fkey,
  ADD CONSTRAINT executions_pipeline_version_id_fkey
    FOREIGN KEY (pipeline_version_id) REFERENCES pipeline_versions(id) ON DELETE CASCADE;
