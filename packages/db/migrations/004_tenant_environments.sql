-- 004_tenant_environments.sql
-- Environments become per-tenant. A row is identified by its uuid `id` (the
-- PK); `name` is no longer globally unique, so two tenants can each define
-- their own "staging". The codebase already treats `environment` as free
-- text everywhere (run/deploy/scheduler/config-resolver/worker) — the FKs to
-- environments(name) were the only thing pinning it to a fixed dev/prod set,
-- so they are dropped. The environments table is now the per-tenant catalog
-- that the tenant screen manages and every environment picker reads from.

ALTER TABLE environments
  ADD COLUMN IF NOT EXISTS tenant_id uuid
    REFERENCES tenants(id) ON DELETE CASCADE;

-- Dropping the global UNIQUE(name) CASCADEs to the five FKs that referenced
-- environments(name): pipeline_deployments, tenant_pipelines, secret_refs,
-- rate_limit_policies, vector_collections. Those columns remain free text.
ALTER TABLE environments DROP CONSTRAINT IF EXISTS environments_name_key CASCADE;

-- Legacy global rows (no owning tenant) are obsolete; per-tenant rows are
-- seeded by packages/db/seeds/demo.sql, which runs after migrations.
DELETE FROM environments WHERE tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_environments_tenant ON environments (tenant_id);
