-- Demo Connections — wires every bundled demo dataset to a named
-- datasource_connection so the new (PR1-6) dataset → connection →
-- plugin cascade is actually exercised. Without this seed the
-- demos hard-fail since PR3 dropped the legacy env-var fallback.
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
-- SCOPE (PR6): all three rows are GLOBAL (tenant_id NULL,
-- environment_id NULL). Every tenant inherits them via the
-- env→tenant→global cascade, so a new tenant-local-style fork
-- doesn't need its own connection rows to run the demos. Operators
-- override per-tenant or per-env via the Connections screen when
-- they want to point a specific tenant at a different host.
--
-- Demo datasets carry `namespace: by-tenant` (see codebase-ingest /
-- KG seeds), so even though the connection is shared, the
-- collection / predicate names are per-tenant — no cross-tenant
-- data leakage from the shared host.

INSERT INTO datasource_connections
  (id, tenant_id, environment_id, name, datasource_type, secret_ref_id, config_redacted, allowed_hosts, deny_private_networks)
VALUES
  (
    '00000000-0000-0000-0000-0000000c0001'::uuid,
    NULL, NULL, 'qdrant', 'qdrant', NULL,
    '{"host":"ragdoll-qdrant","port":6333,"scheme":"http"}'::jsonb,
    '{}', false
  ),
  (
    '00000000-0000-0000-0000-0000000c0002'::uuid,
    NULL, NULL, 'opensearch', 'opensearch', NULL,
    '{"host":"ragdoll-bundledopensearch","port":9200,"scheme":"http"}'::jsonb,
    '{}', false
  ),
  (
    '00000000-0000-0000-0000-0000000c0003'::uuid,
    NULL, NULL, 'dgraph', 'dgraph', NULL,
    '{"host":"ragdoll-dgraph","port":8080,"scheme":"http"}'::jsonb,
    '{}', false
  )
ON CONFLICT (id) DO UPDATE
  SET tenant_id      = EXCLUDED.tenant_id,
      environment_id = EXCLUDED.environment_id,
      name           = EXCLUDED.name,
      datasource_type = EXCLUDED.datasource_type,
      config_redacted = EXCLUDED.config_redacted,
      updated_at = now();

-- Note: dataset → connection binding now lives directly on the
-- `backends.<modality>.connectionName` field in each dataset seed
-- (see codebase-ingest + KG seeds). No follow-up UPDATE needed.
