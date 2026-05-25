-- Phase 4 of the dataset/RBAC/retrieval refactor: introduce Datasets as a
-- first-class resource. A Dataset is a named, schema'd, RBAC'd container
-- of vector + keyword + structured data; pipelines reference Datasets
-- rather than directly naming a Qdrant collection / OpenSearch index, so
-- multiple pipelines can ingest into and retrieve from the same logical
-- corpus and the platform can choose / change the physical backend.
--
-- Three tables, joined by foreign keys:
--   datasets           — the logical resource (one row per Dataset).
--   dataset_versions   — immutable snapshots of a Dataset's schema + the
--                        concrete backend collection names it lives in.
--   dataset_aliases    — moveable pointers (`stable`, `staging`) into the
--                        version timeline so pipelines pin to an alias
--                        and the platform swaps the underlying version
--                        atomically.
--
-- A pipeline_versions row tracks which datasets it references in its
-- spec (`spec.datasets`, populated by the migration script in Phase 4d);
-- the join is structural, not a separate refs table — keeping it inside
-- the immutable spec means a pipeline version's dataset coupling is
-- frozen at publish time, which matches how config/secrets work.

CREATE TABLE IF NOT EXISTS datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- "global" | "tenant" | "environment". global = platform-wide reference
  -- corpus readable by all tenants; tenant = readable/writable across all
  -- envs in the tenant; environment = pinned to one env in one tenant.
  scope text NOT NULL CHECK (scope IN ('global', 'tenant', 'environment')),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  -- Free-text env name matching environments.name. NULL except when
  -- scope = 'environment'. (Mirrors api_keys.environment_id which is also
  -- a name reference, not a FK — consistent with the existing schema.)
  environment_id text,
  slug text NOT NULL,
  display_name text NOT NULL,
  description text,
  -- Snapshot of embedding profile (provider/model/dimensions/distance) —
  -- determines vector compatibility. Changing it requires a new version
  -- (full re-ingest), per the Phase 4 design.
  embedding_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- JSON-schema-like shape every chunk written to the dataset must
  -- conform to. Validation is the platform's job, not the plugin's.
  chunk_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- ["vector"], ["keyword"], or both. Drives which backends are
  -- provisioned and which retrieval modes are usable.
  modalities text[] NOT NULL DEFAULT ARRAY['vector']::text[],
  -- { vector: { provider: "qdrant", config: {...} }, keyword: {...} }
  -- Single-vector-backend in Phase 4; multi-backend (pgvector / OpenSearch
  -- side-by-side) lands in Phase 6.
  backends jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The dataset's currently-ready version id (FK installed below). Aliases
  -- can point at older versions for staging / canary; this column is the
  -- "freshest ready version" pointer the UI displays as default.
  current_version_id uuid,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Slug uniqueness within scope; the same slug may appear at global,
  -- tenant, and per-tenant env — resolution at reference time walks
  -- env -> tenant -> global, first match wins.
  CONSTRAINT datasets_scope_shape CHECK (
    (scope = 'global'      AND tenant_id IS NULL     AND environment_id IS NULL) OR
    (scope = 'tenant'      AND tenant_id IS NOT NULL AND environment_id IS NULL) OR
    (scope = 'environment' AND tenant_id IS NOT NULL AND environment_id IS NOT NULL)
  )
);

-- A separate index per scope; Postgres can't express "tenant_id NULLS NOT
-- DISTINCT" portably so we use three partial indexes instead. Each one
-- pins slug uniqueness within its scope.
CREATE UNIQUE INDEX IF NOT EXISTS datasets_slug_global
  ON datasets (slug) WHERE scope = 'global';
CREATE UNIQUE INDEX IF NOT EXISTS datasets_slug_tenant
  ON datasets (tenant_id, slug) WHERE scope = 'tenant';
CREATE UNIQUE INDEX IF NOT EXISTS datasets_slug_environment
  ON datasets (tenant_id, environment_id, slug) WHERE scope = 'environment';

CREATE INDEX IF NOT EXISTS idx_datasets_tenant ON datasets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_datasets_archived ON datasets(archived_at);

CREATE TABLE IF NOT EXISTS dataset_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  -- Monotonically-numbered label per dataset. Generated server-side at
  -- version creation; format is "v1", "v2", etc.
  version_label text NOT NULL,
  schema_spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Resolved physical backend collection / index names per modality:
  -- { vector: "rag_acme_prod_supportkb_v2", keyword: "rag_acme_prod_supportkb_v2_bm25" }
  -- Pipelines never see these; the runtime resolves the dataset reference
  -- + the alias / version pin to one of these names.
  backend_collections jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'building'
    CHECK (status IN ('building', 'ready', 'archived')),
  doc_count bigint NOT NULL DEFAULT 0,
  size_bytes bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  UNIQUE (dataset_id, version_label)
);

CREATE INDEX IF NOT EXISTS idx_dataset_versions_dataset ON dataset_versions(dataset_id);

-- Install the FK from datasets.current_version_id now that
-- dataset_versions exists. ON DELETE SET NULL: archiving a version
-- (which CASCADE-deletes its row in Phase 4+) should drop the
-- "current" pointer rather than break the dataset row.
ALTER TABLE datasets
  ADD CONSTRAINT datasets_current_version_fk
  FOREIGN KEY (current_version_id)
  REFERENCES dataset_versions(id)
  ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS dataset_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  -- "stable", "staging", "canary" — free-form. Pipelines pin to an alias
  -- so the platform can swap the underlying version atomically.
  alias text NOT NULL,
  version_id uuid NOT NULL REFERENCES dataset_versions(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  UNIQUE (dataset_id, alias)
);

CREATE INDEX IF NOT EXISTS idx_dataset_aliases_version ON dataset_aliases(version_id);

-- Seed the role catalog with dataset permissions. New rows are
-- idempotent via ON CONFLICT DO NOTHING (mirrors how 005_rbac_identity
-- seeds its roles). Roles match the existing Role union in
-- packages/authz/src/index.ts.
INSERT INTO rbac_role_permissions (role, permission)
VALUES
  ('platform_admin',    'dataset:read'),
  ('platform_admin',    'dataset:write'),
  ('platform_admin',    'dataset:admin'),
  ('tenant_admin',      'dataset:read'),
  ('tenant_admin',      'dataset:write'),
  ('tenant_admin',      'dataset:admin'),
  ('environment_admin', 'dataset:read'),
  ('environment_admin', 'dataset:write'),
  ('pipeline_admin',    'dataset:read'),
  ('pipeline_admin',    'dataset:write'),
  ('pipeline_admin',    'dataset:admin'),
  ('pipeline_editor',   'dataset:read'),
  ('pipeline_editor',   'dataset:write'),
  ('tenant_operator',   'dataset:read'),
  ('viewer',            'dataset:read'),
  ('auditor',           'dataset:read')
ON CONFLICT (role, permission) DO NOTHING;
