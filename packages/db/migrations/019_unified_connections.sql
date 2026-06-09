-- ADR-0023: Unified Connections Registry.
--
-- Collapses `datasource_connections` (ADR-0020-era per-tenant registry,
-- referenced by Dataset backends) and `external_connections` (ADR-0021,
-- referenced directly by pipeline nodes via node.connection.slug) into a
-- single `connections` table. The two tables exist for historical
-- reasons; both encode the same domain object (a named pointer to an
-- external DB with credentials) and the operator wants one mental model.
--
-- Schema rationale:
--   - `scope` is an explicit enum (global/tenant/environment) rather than
--     derived from nullability. Datasource_connections derived it from
--     `tenant_id IS NULL`; explicit is friendlier to constraint checks
--     and matches every other scoped resource (datasets, secrets, etc).
--   - `slug` (vs the old `name`) is the operator-facing handle for
--     resolution. Per-scope unique via three partial indexes.
--   - `kind` is open-ended text. The static "known kinds" map in code
--     goes away in ADR-0024 (connection drivers as plugins) — the
--     loader's catalog becomes the source of truth.
--   - `config` (jsonb) is per-kind non-secret config. Schema lives on
--     the driver plugin manifest (ADR-0024).
--   - `allowed_hosts` + `deny_private_networks` are per-connection
--     security policy preserved from datasource_connections (SSRF
--     guardrails). Orthogonal to kind; survive the rename.
--   - Probe state (last_probed_at/last_probe_ok/last_probe_error) is
--     populated by the existing `connection_probe_sweep` worker job
--     (migration 018). Carried verbatim from external_connections.
--   - `archived_at` for soft delete (slug references in pipeline specs
--     must resolve consistently even after archive — same pattern as
--     datasets).

CREATE TABLE IF NOT EXISTS connections (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope                   text NOT NULL CHECK (scope IN ('global', 'tenant', 'environment')),
  tenant_id               uuid REFERENCES tenants(id) ON DELETE CASCADE,
  environment_id          text,
  slug                    text NOT NULL,
  display_name            text NOT NULL,
  description             text,
  kind                    text NOT NULL,
  config                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_ref_id           uuid,
  allowed_hosts           text[] NOT NULL DEFAULT ARRAY[]::text[],
  deny_private_networks   boolean NOT NULL DEFAULT false,
  last_probed_at          timestamptz,
  last_probe_ok           boolean,
  last_probe_error        text,
  archived_at             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connections_scope_shape CHECK (
    (scope = 'global'      AND tenant_id IS NULL     AND environment_id IS NULL) OR
    (scope = 'tenant'      AND tenant_id IS NOT NULL AND environment_id IS NULL) OR
    (scope = 'environment' AND tenant_id IS NOT NULL AND environment_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS connections_slug_global
  ON connections (slug) WHERE scope = 'global';
CREATE UNIQUE INDEX IF NOT EXISTS connections_slug_tenant
  ON connections (tenant_id, slug) WHERE scope = 'tenant';
CREATE UNIQUE INDEX IF NOT EXISTS connections_slug_environment
  ON connections (tenant_id, environment_id, slug) WHERE scope = 'environment';

CREATE INDEX IF NOT EXISTS idx_connections_tenant   ON connections(tenant_id);
CREATE INDEX IF NOT EXISTS idx_connections_kind     ON connections(kind);
CREATE INDEX IF NOT EXISTS idx_connections_archived ON connections(archived_at);

-- ----------------------------------------------------------------------
-- Migrate datasource_connections → connections. Slugs are preserved
-- EXACTLY so existing Dataset specs that reference connections by name
-- (`backends.<modality>.connectionName: "qdrant-prod"`) keep resolving.
-- ----------------------------------------------------------------------
INSERT INTO connections
  (id, scope, tenant_id, environment_id, slug, display_name, description,
   kind, config, secret_ref_id, allowed_hosts, deny_private_networks,
   created_at, updated_at)
SELECT
  id,
  CASE
    WHEN tenant_id IS NULL                              THEN 'global'
    WHEN tenant_id IS NOT NULL AND environment_id IS NULL THEN 'tenant'
    ELSE 'environment'
  END AS scope,
  tenant_id,
  environment_id,
  name        AS slug,
  name        AS display_name,
  NULL        AS description,
  datasource_type AS kind,
  COALESCE(config_redacted, '{}'::jsonb) AS config,
  secret_ref_id,
  COALESCE(allowed_hosts, ARRAY[]::text[]),
  COALESCE(deny_private_networks, false),
  created_at,
  updated_at
FROM datasource_connections
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------
-- Migrate external_connections → connections. Per ADR-0023 §"Migration",
-- this table has zero adopters (the registry shipped less than 48h
-- before this migration) so we copy any rows that exist and drop the
-- table without back-compat hooks.
-- ----------------------------------------------------------------------
INSERT INTO connections
  (id, scope, tenant_id, environment_id, slug, display_name, description,
   kind, config, secret_ref_id, last_probed_at, last_probe_ok,
   last_probe_error, archived_at, created_at, updated_at)
SELECT
  id, scope, tenant_id, environment_id, slug, display_name, description,
  kind, COALESCE(options, '{}'::jsonb) AS config, secret_ref_id,
  last_probed_at, last_probe_ok, last_probe_error, archived_at,
  created_at, updated_at
FROM external_connections
ON CONFLICT (id) DO NOTHING;

-- Drop the old tables. datasource_connections data is preserved in
-- `connections`; external_connections had no production adopters.
DROP TABLE IF EXISTS external_connections;
DROP TABLE IF EXISTS datasource_connections;
