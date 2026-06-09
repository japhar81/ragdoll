-- ADR-0021: External Connections Registry.
--
-- First-class named connections to non-Postgres external databases
-- (MongoDB, ClickHouse, HTTP-as-DB, etc). The Postgres-only `postgres-core`
-- module in plugins/builtin-rag stays as the back-compat path for nodes
-- whose pipelines were authored before this resource existed; new pipelines
-- reference connections by `slug` and the resolver walks the same
-- env → tenant → global cascade used by datasets (ADR-0016).
--
-- Resource shape mirrors `datasets`:
--   - Three scopes (global / tenant / environment) with the same
--     CHECK + unique-per-scope partial indexes.
--   - A `secret_ref_id` pointer into the existing managed-secrets table,
--     never a plaintext DSN/credential.
--   - `kind` is open-ended text (postgres / mongodb / clickhouse / http / …)
--     so adding a new family is a registry-only change, no schema migration.
--   - `options` (jsonb) is per-kind configuration that's not a secret —
--     max pool size, default schema/database, TLS verify mode, etc.
--   - `archived_at` for soft delete (same semantics as datasets).
--
-- Health probe state (last_probed_at, last_probe_ok, last_probe_error) is
-- tracked here so the Builder can render red/green badges without a
-- separate side-table. The probe job lives in the worker.

CREATE TABLE IF NOT EXISTS external_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('global', 'tenant', 'environment')),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  environment_id text,
  slug text NOT NULL,
  display_name text NOT NULL,
  description text,
  kind text NOT NULL,
  -- Reference to a row in `secrets`. The connection's credential
  -- (DSN, API key, mongo URI, …) lives there and is resolved through
  -- SecretProvider at execution time.
  secret_ref_id uuid,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Probe state — populated by the periodic worker job; nullable so a
  -- freshly-created connection isn't immediately red.
  last_probed_at timestamptz,
  last_probe_ok boolean,
  last_probe_error text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_connections_scope_shape CHECK (
    (scope = 'global'      AND tenant_id IS NULL     AND environment_id IS NULL) OR
    (scope = 'tenant'      AND tenant_id IS NOT NULL AND environment_id IS NULL) OR
    (scope = 'environment' AND tenant_id IS NOT NULL AND environment_id IS NOT NULL)
  )
);

-- Slug uniqueness within scope (same pattern as datasets — Postgres can't
-- express "tenant_id NULLS NOT DISTINCT" portably so three partial
-- indexes pin per-scope uniqueness).
CREATE UNIQUE INDEX IF NOT EXISTS external_connections_slug_global
  ON external_connections (slug) WHERE scope = 'global';
CREATE UNIQUE INDEX IF NOT EXISTS external_connections_slug_tenant
  ON external_connections (tenant_id, slug) WHERE scope = 'tenant';
CREATE UNIQUE INDEX IF NOT EXISTS external_connections_slug_environment
  ON external_connections (tenant_id, environment_id, slug)
  WHERE scope = 'environment';

CREATE INDEX IF NOT EXISTS idx_external_connections_tenant
  ON external_connections(tenant_id);
CREATE INDEX IF NOT EXISTS idx_external_connections_kind
  ON external_connections(kind);
CREATE INDEX IF NOT EXISTS idx_external_connections_archived
  ON external_connections(archived_at);
