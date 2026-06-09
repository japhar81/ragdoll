-- Demo Connections — wires every bundled demo dataset to a named
-- connection so the new (PR1-6 + ADR-0023) dataset → connection →
-- plugin cascade is actually exercised.
--
-- Migration 019 collapsed `datasource_connections` + `external_connections`
-- into a single `connections` table. The fields rename:
--   name             → slug
--   datasource_type  → kind
--   config_redacted  → config
-- plus the new `scope` enum + explicit `display_name`. ADR-0023.
--
-- Filename `zzzzzzz-...` sorts AFTER every other demo seed under
-- the loader's localeCompare ordering, so the datasets / tenants /
-- environments these reference are guaranteed to exist.
--
-- HOSTNAME CONVENTION: helm names (`ragdoll-qdrant`, `ragdoll-
-- bundledopensearch`, `ragdoll-dgraph`). docker-compose adds
-- network aliases for the same names, so a single connection row
-- resolves cleanly in BOTH installs without per-env overrides.
--
-- SCOPE: all three rows are GLOBAL (tenant_id NULL, environment_id
-- NULL). Every tenant inherits them via the env→tenant→global
-- cascade, so a new tenant-local-style fork doesn't need its own
-- connection rows to run the demos. Operators override per-tenant
-- or per-env via the Connections screen when they want to point a
-- specific tenant at a different host.
--
-- Demo datasets carry `namespace: by-tenant` (see codebase-ingest /
-- KG seeds), so even though the connection is shared, the
-- collection / predicate names are per-tenant — no cross-tenant
-- data leakage from the shared host.

INSERT INTO connections
  (id, scope, tenant_id, environment_id, slug, display_name,
   kind, secret_ref_id, config, allowed_hosts, deny_private_networks)
VALUES
  (
    '00000000-0000-0000-0000-0000000c0001'::uuid,
    'global', NULL, NULL, 'qdrant', 'Qdrant (bundled)',
    'qdrant', NULL,
    '{"host":"ragdoll-qdrant","port":6333,"scheme":"http"}'::jsonb,
    '{}', false
  ),
  (
    '00000000-0000-0000-0000-0000000c0002'::uuid,
    'global', NULL, NULL, 'opensearch', 'OpenSearch (bundled)',
    'opensearch', NULL,
    '{"host":"ragdoll-bundledopensearch","port":9200,"scheme":"http"}'::jsonb,
    '{}', false
  ),
  (
    '00000000-0000-0000-0000-0000000c0003'::uuid,
    'global', NULL, NULL, 'dgraph', 'Dgraph (bundled)',
    'dgraph', NULL,
    '{"host":"ragdoll-dgraph","port":8080,"scheme":"http"}'::jsonb,
    '{}', false
  )
ON CONFLICT (id) DO UPDATE
  SET scope          = EXCLUDED.scope,
      tenant_id      = EXCLUDED.tenant_id,
      environment_id = EXCLUDED.environment_id,
      slug           = EXCLUDED.slug,
      display_name   = EXCLUDED.display_name,
      kind           = EXCLUDED.kind,
      config         = EXCLUDED.config,
      updated_at     = now();

-- Note: dataset → connection binding still uses the
-- `backends.<modality>.connectionName` field in each dataset seed
-- — slug preservation by migration 019 means those references
-- resolve into the unified `connections` table untouched.
