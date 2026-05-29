-- Global connection scope.
--
-- datasource_connections.tenant_id was NOT NULL — every connection
-- belonged to exactly one tenant. PR2 makes it nullable so an operator
-- can seed a single shared connection (e.g. "the prod opensearch
-- cluster") and let every tenant inherit it. Tenants override the
-- global default with their own per-tenant row, and a tenant can
-- further override per-env with the existing env_id column.
--
-- Resolution cascade (tenant T, env E, connection name N):
--   1. (tenant=T, env=E, name=N) → use
--   2. (tenant=T, env=NULL, name=N) → use (tenant-wide override)
--   3. (tenant=NULL, env=NULL, name=N) → use (global default)
--   4. → no match
--
-- Note: we intentionally skip a (tenant=NULL, env=E) tier. Global
-- connections are infrastructure-team shared resources — env-splitting
-- is a tenant concern that lives in tier 1 or 2. If a real use case
-- shows up (e.g. "the staging shared cluster"), it would slot between
-- tiers 2 and 3.

ALTER TABLE datasource_connections
  ALTER COLUMN tenant_id DROP NOT NULL;

-- The unique constraint added in 014 already uses NULLS NOT DISTINCT,
-- but the column-level NOT DISTINCT was on (tenant_id, environment_id,
-- name). Now that tenant_id is also nullable, two global rows with the
-- same name would collide because of the same NULLS NOT DISTINCT
-- semantics — which is exactly what we want (one global row per name).
-- No schema change here; the existing unique index already enforces it.
