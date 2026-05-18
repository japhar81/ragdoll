CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text
);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  tenant_id uuid,
  environment text,
  pipeline_id uuid,
  PRIMARY KEY (user_id, role_id, tenant_id, environment, pipeline_id)
);

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  is_production boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pipelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  labels jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pipeline_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  version text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  spec jsonb NOT NULL,
  checksum text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (pipeline_id, version)
);

CREATE TABLE pipeline_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  pipeline_version_id uuid NOT NULL REFERENCES pipeline_versions(id),
  environment text NOT NULL REFERENCES environments(name),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active',
  deployed_by uuid REFERENCES users(id),
  deployed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pipeline_id, environment, tenant_id)
);

CREATE TABLE tenant_pipelines (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  environment text NOT NULL REFERENCES environments(name),
  enabled boolean NOT NULL DEFAULT true,
  vector_isolation jsonb NOT NULL DEFAULT '{"mode":"collection_per_tenant_pipeline"}',
  provider_policy jsonb NOT NULL DEFAULT '{}',
  rate_limit_policy jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, pipeline_id, environment)
);

CREATE TABLE plugins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id text NOT NULL,
  category text NOT NULL,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plugin_id, category)
);

CREATE TABLE plugin_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  version text NOT NULL,
  manifest jsonb NOT NULL,
  mode text NOT NULL CHECK (mode IN ('in_process', 'external')),
  endpoint jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plugin_id, version)
);

CREATE TABLE providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL UNIQUE,
  display_name text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id text NOT NULL,
  display_name text,
  context_window integer,
  input_cost_per_1m numeric,
  output_cost_per_1m numeric,
  supports_streaming boolean NOT NULL DEFAULT false,
  supports_tools boolean NOT NULL DEFAULT false,
  supports_embeddings boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}',
  UNIQUE (provider_id, model_id)
);

CREATE TABLE config_definitions (
  key text PRIMARY KEY,
  type text NOT NULL,
  default_value jsonb,
  allowed_scopes text[] NOT NULL,
  required boolean NOT NULL DEFAULT false,
  secret boolean NOT NULL DEFAULT false,
  sensitive boolean NOT NULL DEFAULT false,
  overridable boolean NOT NULL DEFAULT true,
  inherited boolean NOT NULL DEFAULT true,
  nullable boolean NOT NULL DEFAULT false,
  tenant_overridable boolean NOT NULL DEFAULT false,
  runtime_overridable boolean NOT NULL DEFAULT false,
  validation jsonb NOT NULL DEFAULT '{}',
  description text
);

CREATE TABLE config_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL REFERENCES config_definitions(key) ON DELETE CASCADE,
  value jsonb NOT NULL,
  scope text NOT NULL,
  scope_id text,
  locked boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key, scope, scope_id)
);

CREATE TABLE secret_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  logical_key text NOT NULL,
  scope text NOT NULL,
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  environment text REFERENCES environments(name),
  provider text NOT NULL DEFAULT 'database_encrypted',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (logical_key, scope, tenant_id, environment)
);

CREATE TABLE encrypted_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  secret_ref_id uuid NOT NULL REFERENCES secret_refs(id) ON DELETE CASCADE,
  version integer NOT NULL,
  key_id text NOT NULL,
  ciphertext text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  UNIQUE (secret_ref_id, version)
);

CREATE TABLE tenant_provider_credentials (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL,
  secret_ref_id uuid NOT NULL REFERENCES secret_refs(id),
  enabled boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider)
);

CREATE TABLE executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  pipeline_id uuid NOT NULL REFERENCES pipelines(id),
  pipeline_version_id uuid NOT NULL REFERENCES pipeline_versions(id),
  environment text NOT NULL,
  status text NOT NULL,
  request_id text,
  actor_id uuid REFERENCES users(id),
  input_redacted jsonb,
  output_redacted jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE execution_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id text NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  node_id text NOT NULL,
  status text NOT NULL,
  input_redacted jsonb,
  output_redacted jsonb,
  error text,
  latency_ms numeric,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE execution_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id text NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  node_id text,
  event_type text NOT NULL,
  payload_redacted jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES users(id),
  tenant_id uuid REFERENCES tenants(id),
  pipeline_id uuid REFERENCES pipelines(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  before_redacted jsonb,
  after_redacted jsonb,
  request_id text,
  source_ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  pipeline_id uuid REFERENCES pipelines(id),
  execution_id text REFERENCES executions(execution_id),
  provider text,
  model text,
  input_tokens integer DEFAULT 0,
  output_tokens integer DEFAULT 0,
  embedding_tokens integer DEFAULT 0,
  estimated_cost_usd numeric DEFAULT 0,
  latency_ms numeric,
  success boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rate_limit_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  pipeline_id uuid REFERENCES pipelines(id) ON DELETE CASCADE,
  environment text REFERENCES environments(name),
  policy jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE datasource_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  datasource_type text NOT NULL,
  secret_ref_id uuid REFERENCES secret_refs(id),
  config_redacted jsonb NOT NULL DEFAULT '{}',
  allowed_hosts text[] NOT NULL DEFAULT '{}',
  deny_private_networks boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vector_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  environment text NOT NULL REFERENCES environments(name),
  collection_name text NOT NULL UNIQUE,
  isolation_mode text NOT NULL,
  embedding_profile jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id),
  pipeline_id uuid NOT NULL REFERENCES pipelines(id),
  pipeline_version_id uuid NOT NULL REFERENCES pipeline_versions(id),
  execution_id text REFERENCES executions(execution_id),
  evaluator_plugin text NOT NULL,
  score numeric,
  passed boolean,
  result jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pipeline_versions_pipeline_id ON pipeline_versions(pipeline_id);
CREATE INDEX idx_pipeline_deployments_pipeline_env ON pipeline_deployments(pipeline_id, environment);
CREATE INDEX idx_pipeline_deployments_tenant ON pipeline_deployments(tenant_id);
CREATE INDEX idx_config_values_scope ON config_values(scope, scope_id);
CREATE INDEX idx_executions_tenant_created ON executions(tenant_id, started_at DESC);
CREATE INDEX idx_executions_pipeline_version ON executions(pipeline_id, pipeline_version_id);
CREATE INDEX idx_execution_nodes_execution ON execution_nodes(execution_id);
CREATE INDEX idx_audit_actor_action_time ON audit_logs(actor_id, action, created_at DESC);
CREATE INDEX idx_audit_tenant_time ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX idx_usage_tenant_time ON usage_records(tenant_id, created_at DESC);
CREATE INDEX idx_usage_provider_model ON usage_records(provider, model);
CREATE INDEX idx_vector_collections_tenant_pipeline ON vector_collections(tenant_id, pipeline_id, environment);
