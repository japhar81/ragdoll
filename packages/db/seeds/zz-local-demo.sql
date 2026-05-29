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
    '{"apiVersion":"rag-platform/v1","kind":"Pipeline","metadata":{"name":"local-demo","stages":[{"id":"s_auto_1","label":"Stage 1"},{"id":"s_auto_2","label":"Stage 2"},{"id":"s_auto_3","label":"Stage 3"},{"id":"s_auto_4","label":"Stage 4"}]},"spec":{"nodes":[{"id":"input","type":"input","ui":{"position":{"x":8.71875,"y":40},"stageId":"s_auto_1"}},{"id":"prompt","plugin":{"category":"prompt_template","id":"basic_rag_prompt","version":"1.0.0"},"ui":{"position":{"x":469,"y":40},"stageId":"s_auto_2"}},{"id":"llm","plugin":{"category":"llm","id":"provider_chat","version":"1.0.0"},"config":{"provider":"${config.llm.provider}","model":"${config.llm.model}","baseUrl":"${config.llm.base_url}"},"ui":{"position":{"x":931,"y":40},"stageId":"s_auto_3"}},{"id":"output","type":"output","ui":{"position":{"x":1391.28125,"y":40},"stageId":"s_auto_4"}}],"edges":[{"from":"input","to":"prompt","fromPort":"question","toPort":"question"},{"from":"prompt","to":"llm","fromPort":"messages","toPort":"messages"},{"from":"llm","to":"output"}]}}'::jsonb,
    'f97a7610',
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
-- this pipeline/tenant. We intentionally DO NOT pin `llm.base_url` /
-- `embedding.base_url` here — leaving them unset lets the runtime fall
-- through to the `OLLAMA_BASE_URL` env (`http://ollama:11434` in compose,
-- `http://ragdoll-ollama:11434` in helm), so the same seed works in
-- both deploy modes without per-env overrides.
INSERT INTO config_values (key, value, scope, scope_id, locked)
SELECT 'llm.provider', '"ollama"'::jsonb, 'tenant', t.id::text, false
FROM tenants t WHERE t.slug = 'tenant-local'
ON CONFLICT (key, scope, scope_id) DO UPDATE SET value = EXCLUDED.value;

INSERT INTO config_values (key, value, scope, scope_id, locked)
SELECT 'llm.model', '"qwen2.5:0.5b"'::jsonb, 'tenant', t.id::text, false
FROM tenants t WHERE t.slug = 'tenant-local'
ON CONFLICT (key, scope, scope_id) DO UPDATE SET value = EXCLUDED.value;

-- Match the bundled-Ollama embedder so codebase-ingest pipelines pick
-- nomic-embed-text out of the box. Operators who BYO a different
-- embedder override at tenant scope on the Settings screen.
INSERT INTO config_values (key, value, scope, scope_id, locked)
SELECT 'embedding.provider', '"ollama"'::jsonb, 'tenant', t.id::text, false
FROM tenants t WHERE t.slug = 'tenant-local'
ON CONFLICT (key, scope, scope_id) DO UPDATE SET value = EXCLUDED.value;

INSERT INTO config_values (key, value, scope, scope_id, locked)
SELECT 'embedding.model', '"nomic-embed-text"'::jsonb, 'tenant', t.id::text, false
FROM tenants t WHERE t.slug = 'tenant-local'
ON CONFLICT (key, scope, scope_id) DO UPDATE SET value = EXCLUDED.value;

INSERT INTO config_values (key, value, scope, scope_id, locked)
SELECT 'embedding.dimensions', '768'::jsonb, 'tenant', t.id::text, false
FROM tenants t WHERE t.slug = 'tenant-local'
ON CONFLICT (key, scope, scope_id) DO UPDATE SET value = EXCLUDED.value;

-- Old installs may have a stale `llm.base_url = "http://ollama:11434"`
-- (the compose-specific hostname) which would override OLLAMA_BASE_URL
-- on a helm install. Clear it so the env always wins.
DELETE FROM config_values
WHERE key = 'llm.base_url'
  AND scope = 'tenant'
  AND scope_id IN (SELECT id::text FROM tenants WHERE slug = 'tenant-local');
