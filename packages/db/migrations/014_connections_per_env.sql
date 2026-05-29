-- datasource_connections gains per-environment scoping.
--
-- Why: today a connection is `(tenant, name)` — there is no way to say
-- "tenant B uses os-dev.example.com in dev and os-prod.example.com in
-- prod". Adding a nullable `environment_id text` column lets a single
-- connection name resolve differently per environment, with a fall-
-- through to the tenant-wide row when no env-specific override exists.
--
-- Cascade semantics (env→tenant, single-tenant boundary):
--   resolve(name, tenant=T, env=E):
--     1. row with (tenant_id=T, environment_id=E,    name) → use
--     2. row with (tenant_id=T, environment_id=NULL, name) → use
--     3. → not found
--
-- We intentionally do NOT add a global-tenant tier in this migration —
-- every connection still belongs to a tenant. The env_id is nullable
-- because most installs (single-tenant, single-env demos) won't bother
-- splitting per env, and the existing rows should continue to apply
-- across every env until an operator deliberately splits them.

ALTER TABLE datasource_connections
  ADD COLUMN IF NOT EXISTS environment_id text NULL;

-- The original schema had no explicit unique on (tenant_id, name); the
-- API path now needs idempotency on (tenant, env, name), and that's
-- the natural identity for cascade lookups too. NULLS NOT DISTINCT
-- (Postgres 15+) treats two rows with env=NULL as colliding the way
-- we want — "only one tenant-wide row per name".
DROP INDEX IF EXISTS datasource_connections_tenant_id_environment_id_name_key;
CREATE UNIQUE INDEX datasource_connections_tenant_id_environment_id_name_key
  ON datasource_connections (tenant_id, environment_id, name) NULLS NOT DISTINCT;

-- Lookup index for the cascade resolver. Covers the env-specific hit
-- AND the env=NULL fall-through path (Postgres can use a single index
-- for both `= 'dev'` and `IS NULL` when both are valid).
CREATE INDEX IF NOT EXISTS datasource_connections_tenant_env_lookup
  ON datasource_connections (tenant_id, name, environment_id);
