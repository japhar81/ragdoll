-- Local CPU-Ollama demo. Filename is `zz-...` so it sorts AFTER `demo.sql`
-- under the loader's `localeCompare` ordering (a plain `20-` prefix would
-- sort BEFORE `demo.sql`), guaranteeing the environments ('dev'), tenants
-- ('tenant-local'), providers ('ollama') and config_definitions
-- ('llm.provider' / 'llm.model' / 'llm.base_url') it depends on already
-- exist. Every insert is idempotent.
--
-- The pipeline_versions.spec JSON below is byte-identical to the parsed form
-- of examples/pipelines/local-demo.yaml and the checksum is its specChecksum
-- (see packages/pipeline-spec). Keep them in sync if the YAML changes.

INSERT INTO pipelines (id, slug, name, description) VALUES
  (
    '00000000-0000-0000-0000-0000000d3010',
    'local-demo',
    'Local Demo',
    'CPU Ollama RAG-less demo: input -> prompt -> llm -> output.'
  )
ON CONFLICT (slug) DO NOTHING;

INSERT INTO pipeline_versions (id, pipeline_id, version, status, spec, checksum, published_at) VALUES
  (
    '00000000-0000-0000-0000-0000000d3011',
    '00000000-0000-0000-0000-0000000d3010',
    '1.0.0',
    'published',
    '{"apiVersion":"rag-platform/v1","kind":"Pipeline","metadata":{"name":"local-demo"},"spec":{"nodes":[{"id":"input","type":"input"},{"id":"prompt","plugin":{"category":"prompt_template","id":"basic_rag_prompt","version":"1.0.0"}},{"id":"llm","plugin":{"category":"llm","id":"provider_chat","version":"1.0.0"},"config":{"provider":"${config.llm.provider}","model":"${config.llm.model}","baseUrl":"${config.llm.base_url}"}},{"id":"output","type":"output"}],"edges":[{"from":"input","to":"prompt"},{"from":"prompt","to":"llm"},{"from":"llm","to":"output"}]}}'::jsonb,
    '1ce895ad',
    now()
  )
ON CONFLICT (pipeline_id, version) DO NOTHING;

-- Pin the published version to environment 'dev' for tenant 'tenant-local'.
INSERT INTO pipeline_deployments (id, pipeline_id, pipeline_version_id, environment, tenant_id, status)
SELECT
  '00000000-0000-0000-0000-0000000d3012',
  '00000000-0000-0000-0000-0000000d3010',
  '00000000-0000-0000-0000-0000000d3011',
  'dev',
  t.id,
  'active'
FROM tenants t
WHERE t.slug = 'tenant-local'
ON CONFLICT (pipeline_id, environment, tenant_id) DO NOTHING;

-- Tenant-scoped config so the resolver yields the local Ollama profile for
-- this pipeline/tenant: provider=ollama, model=qwen2.5:0.5b,
-- base_url=http://ollama:11434.
INSERT INTO config_values (key, value, scope, scope_id, locked)
SELECT 'llm.provider', '"ollama"'::jsonb, 'tenant', t.id::text, false
FROM tenants t WHERE t.slug = 'tenant-local'
ON CONFLICT (key, scope, scope_id) DO NOTHING;

INSERT INTO config_values (key, value, scope, scope_id, locked)
SELECT 'llm.model', '"qwen2.5:0.5b"'::jsonb, 'tenant', t.id::text, false
FROM tenants t WHERE t.slug = 'tenant-local'
ON CONFLICT (key, scope, scope_id) DO NOTHING;

INSERT INTO config_values (key, value, scope, scope_id, locked)
SELECT 'llm.base_url', '"http://ollama:11434"'::jsonb, 'tenant', t.id::text, false
FROM tenants t WHERE t.slug = 'tenant-local'
ON CONFLICT (key, scope, scope_id) DO NOTHING;
