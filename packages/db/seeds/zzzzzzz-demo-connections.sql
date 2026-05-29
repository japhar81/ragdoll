-- Demo Connections — wires every bundled demo dataset to a named
-- datasource_connection so the new (PR1-4) dataset → connection →
-- plugin cascade is actually exercised. Without this seed the
-- demos still RUN, but only because the plugin's legacy env-var
-- fallback resolves them — the UI's "Resolved connections" panel
-- on each Dataset detail would stay empty and the operator never
-- sees the connection model in action.
--
-- Filename `zzzzzzz-...` sorts AFTER every other demo seed under
-- the loader's localeCompare ordering, so the datasets / tenants /
-- environments these reference are guaranteed to exist.
--
-- HOSTNAME CONVENTION: helm names (`ragdoll-qdrant`, `ragdoll-
-- bundledopensearch`, `ragdoll-dgraph`). docker-compose adds
-- network aliases for the same names, so a single connection row
-- resolves cleanly in BOTH installs without per-env overrides.

-- ---- Connections (all at tenant-wide scope; per-env overrides
--     are an operator-driven action via the Connections screen).

INSERT INTO datasource_connections
  (id, tenant_id, environment_id, name, datasource_type, secret_ref_id, config_redacted, allowed_hosts, deny_private_networks)
SELECT
  '00000000-0000-0000-0000-0000000c0001'::uuid,
  t.id,
  NULL,
  'qdrant',
  'qdrant',
  NULL,
  '{"host":"ragdoll-qdrant","port":6333,"scheme":"http"}'::jsonb,
  '{}',
  false
FROM tenants t WHERE t.slug = 'tenant-local'
ON CONFLICT (tenant_id, environment_id, name) DO UPDATE
  SET config_redacted = EXCLUDED.config_redacted,
      datasource_type = EXCLUDED.datasource_type,
      updated_at = now();

INSERT INTO datasource_connections
  (id, tenant_id, environment_id, name, datasource_type, secret_ref_id, config_redacted, allowed_hosts, deny_private_networks)
SELECT
  '00000000-0000-0000-0000-0000000c0002'::uuid,
  t.id,
  NULL,
  'opensearch',
  'opensearch',
  NULL,
  '{"host":"ragdoll-bundledopensearch","port":9200,"scheme":"http"}'::jsonb,
  '{}',
  false
FROM tenants t WHERE t.slug = 'tenant-local'
ON CONFLICT (tenant_id, environment_id, name) DO UPDATE
  SET config_redacted = EXCLUDED.config_redacted,
      datasource_type = EXCLUDED.datasource_type,
      updated_at = now();

INSERT INTO datasource_connections
  (id, tenant_id, environment_id, name, datasource_type, secret_ref_id, config_redacted, allowed_hosts, deny_private_networks)
SELECT
  '00000000-0000-0000-0000-0000000c0003'::uuid,
  t.id,
  NULL,
  'dgraph',
  'dgraph',
  NULL,
  '{"host":"ragdoll-dgraph","port":8080,"scheme":"http"}'::jsonb,
  '{}',
  false
FROM tenants t WHERE t.slug = 'tenant-local'
ON CONFLICT (tenant_id, environment_id, name) DO UPDATE
  SET config_redacted = EXCLUDED.config_redacted,
      datasource_type = EXCLUDED.datasource_type,
      updated_at = now();

-- ---- Bind datasets to connections.
-- jsonb_set merges a `connectionName` field into the per-modality
-- block without disturbing any other key (provider/index/collection/
-- etc.). Each UPDATE is idempotent — re-running just resets the
-- connection name to the same value.

-- codebase-ingest-code's vector backend → qdrant connection.
UPDATE datasets
SET backends = jsonb_set(
  backends,
  '{vector,connectionName}',
  '"qdrant"'::jsonb,
  true
)
WHERE slug = 'codebase-ingest-code';

-- codebase-ingest-docs's text backend → opensearch connection.
-- (The plugin reads `backends.text.connection` per PR3's helper.)
UPDATE datasets
SET backends = jsonb_set(
  backends,
  '{text,connectionName}',
  '"opensearch"'::jsonb,
  true
)
WHERE slug = 'codebase-ingest-docs';

-- github + crawl KG datasets → dgraph connection.
UPDATE datasets
SET backends = jsonb_set(
  backends,
  '{graph,connectionName}',
  '"dgraph"'::jsonb,
  true
)
WHERE slug IN ('github-knowledge-graph', 'crawl-knowledge-graph');
