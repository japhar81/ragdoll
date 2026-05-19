INSERT INTO roles (name, description) VALUES
  ('platform_admin', 'Full platform administration'),
  ('tenant_admin', 'Tenant administration'),
  ('pipeline_editor', 'Pipeline editing'),
  ('auditor', 'Audit read-only')
ON CONFLICT (name) DO NOTHING;

INSERT INTO tenants (slug, name) VALUES
  ('tenant-a', 'Tenant A'),
  ('tenant-b', 'Tenant B'),
  ('tenant-local', 'Tenant Local Ollama')
ON CONFLICT (slug) DO NOTHING;

-- Per-tenant environments. The environments table is keyed by id (no unique
-- constraint on (tenant_id, name)), so re-runnability uses a NOT EXISTS
-- guard rather than ON CONFLICT. Every demo tenant starts with dev + prod.
INSERT INTO environments (tenant_id, name, description, is_production)
SELECT t.id, e.name, e.description, e.is_production
FROM tenants t
CROSS JOIN (VALUES
  ('dev',  'Local development', false),
  ('prod', 'Production',        true)
) AS e(name, description, is_production)
WHERE NOT EXISTS (
  SELECT 1 FROM environments x
  WHERE x.tenant_id = t.id AND x.name = e.name
);

INSERT INTO providers (provider_id, display_name) VALUES
  ('openai', 'OpenAI'),
  ('anthropic', 'Anthropic'),
  ('ollama', 'Ollama-compatible')
ON CONFLICT (provider_id) DO NOTHING;

INSERT INTO config_definitions (
  key, type, default_value, allowed_scopes, tenant_overridable, runtime_overridable, secret, sensitive, description
) VALUES
  ('llm.provider', 'string', '"openai"', ARRAY['global','environment','pipeline','pipeline_version','tenant','tenant_pipeline','runtime'], true, true, false, false, 'Default chat provider'),
  ('llm.model', 'string', '"gpt-4o-mini"', ARRAY['global','environment','pipeline','pipeline_version','tenant','tenant_pipeline','runtime'], true, true, false, false, 'Default chat model'),
  ('llm.temperature', 'number', '0.2', ARRAY['global','pipeline','tenant_pipeline','runtime'], true, true, false, false, 'Sampling temperature'),
  ('llm.api_key', 'secret_ref', NULL, ARRAY['tenant','tenant_pipeline'], true, false, true, true, 'Tenant provider API key reference'),
  ('llm.base_url', 'string', NULL, ARRAY['tenant','tenant_pipeline'], true, false, false, false, 'Ollama-compatible base URL'),
  ('retrieval.top_k', 'integer', '5', ARRAY['global','pipeline','tenant_pipeline','runtime'], true, true, false, false, 'Retriever top K'),
  ('chunking.chunk_size', 'integer', '1000', ARRAY['global','pipeline'], false, false, false, false, 'Locked chunk size'),
  ('vector.isolation.mode', 'string', '"collection_per_tenant_pipeline"', ARRAY['global','environment','pipeline'], false, false, false, false, 'Vector isolation mode')
ON CONFLICT (key) DO NOTHING;
