-- Per-(pipeline, tenant, env) dataset binding overrides.
--
-- The pipeline spec says `dataset: {slug: "docs", alias: "stable"}`.
-- Today the runtime walks env → tenant → global to find the matching
-- dataset row for that slug. PR3 adds a per-(pipeline, tenant, env)
-- override on top: an operator can pin a specific dataset row for one
-- pipeline under one tenant/env without touching the spec or the
-- global dataset list.
--
-- Resolution order at execute time, given (pipeline P, tenant T, env E, slug S):
--   1. row WHERE pipeline_id=P AND tenant_id=T AND env_id=E AND source_slug=S
--      → use target_dataset_id
--   2. row WHERE pipeline_id=P AND tenant_id=T AND env_id IS NULL AND source_slug=S
--      → use target_dataset_id (per-pipeline-per-tenant override, all envs)
--   3. → fall through to the existing datasets.resolveSlug(S, T, E) cascade
--
-- We don't add a global-pipeline-binding tier — the slug cascade
-- already handles "this slug means dataset X across all tenants"
-- via a global-scope dataset row with the same slug.

CREATE TABLE pipeline_dataset_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment_id text NULL,
  source_slug text NOT NULL,
  target_dataset_id uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One binding per (pipeline, tenant, env, source_slug). NULLS NOT
-- DISTINCT so a tenant-wide override (env=NULL) is a single row,
-- not "one per env=NULL collision".
CREATE UNIQUE INDEX pipeline_dataset_bindings_pkey_natural
  ON pipeline_dataset_bindings (pipeline_id, tenant_id, environment_id, source_slug)
  NULLS NOT DISTINCT;

-- Hot lookup path: the resolver hits this on every node execute.
-- Covers both (env=specific) and (env IS NULL) lookups for the
-- same composite key.
CREATE INDEX pipeline_dataset_bindings_lookup
  ON pipeline_dataset_bindings (pipeline_id, tenant_id, source_slug);
