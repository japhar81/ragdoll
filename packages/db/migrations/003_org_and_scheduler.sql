-- Organization (pipeline folders), concurrent pipeline versioning, and the
-- scheduler data layer. Additive only: existing tables/migrations/seeds and
-- pipeline_deployments are untouched.

-- Folder tree for organizing pipelines. parent_id is RESTRICT so a non-empty
-- folder cannot be deleted out from under its children.
CREATE TABLE pipeline_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid REFERENCES pipeline_folders(id) ON DELETE RESTRICT,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_id, name)
);

-- A pipeline can live in a folder and track a "latest" version pointer used
-- by activations with track_latest = true.
ALTER TABLE pipelines
  ADD COLUMN folder_id uuid REFERENCES pipeline_folders(id) ON DELETE SET NULL,
  ADD COLUMN latest_version_id uuid REFERENCES pipeline_versions(id) ON DELETE SET NULL;

-- Version lineage: a version may be derived from a parent version.
ALTER TABLE pipeline_versions
  ADD COLUMN parent_version_id uuid REFERENCES pipeline_versions(id) ON DELETE SET NULL;

-- tenant_pipelines already has `enabled` (see 001_initial_schema.sql), so no
-- ALTER is required here.

-- 1..N concurrent labeled version bindings per tenant + pipeline + environment.
-- A binding either pins a specific pipeline_version_id or follows the
-- pipeline's latest_version_id when track_latest is true.
CREATE TABLE pipeline_activations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  environment text NOT NULL,
  label text NOT NULL,
  pipeline_version_id uuid REFERENCES pipeline_versions(id) ON DELETE SET NULL,
  track_latest boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, pipeline_id, environment, label)
);

-- Cron schedules that fire a pipeline (optionally targeting an activation
-- label) for a tenant + environment.
CREATE TABLE schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  environment text NOT NULL,
  activation_label text,
  cron text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  next_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pipeline_folders_parent ON pipeline_folders(parent_id);
CREATE INDEX idx_pipelines_folder ON pipelines(folder_id);
CREATE INDEX idx_pipeline_activations_tenant ON pipeline_activations(tenant_id);
CREATE INDEX idx_pipeline_activations_pipeline ON pipeline_activations(pipeline_id);
CREATE INDEX idx_pipeline_activations_tenant_pipeline_env
  ON pipeline_activations(tenant_id, pipeline_id, environment);
CREATE INDEX idx_schedules_tenant ON schedules(tenant_id);
CREATE INDEX idx_schedules_pipeline ON schedules(pipeline_id);
CREATE INDEX idx_schedules_due ON schedules(enabled, next_run_at);
