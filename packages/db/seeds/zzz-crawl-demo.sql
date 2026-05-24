-- Out-of-the-box demo pipelines exercising the external Python crawler
-- (`crawl4ai_crawler`). Filename is `zzz-...` so it sorts AFTER
-- `zz-local-demo.sql` under the loader's `localeCompare` ordering (note:
-- `zz-crawl-demo` would sort BEFORE `zz-local-demo`), guaranteeing the
-- environment ('dev'), tenant ('tenant-local') and its Ollama config
-- (llm.provider=ollama, llm.model=qwen2.5:0.5b,
-- llm.base_url=http://ollama:11434) created by zz-local-demo.sql already
-- exist. crawl-summarize-demo reuses that tenant-local Ollama config exactly
-- like local-demo; web-crawl-demo has no llm node so it needs none. Every
-- insert is idempotent.
--
-- Each pipeline_versions.spec JSON below is byte-identical to the parsed form
-- of its examples/pipelines/*.yaml and the checksum is its specChecksum (see
-- packages/pipeline-spec). Keep them in sync if the YAML changes
-- (tests/e2e/crawl-demos.e2e.test.ts guards this).

-- ----------------------------- web-crawl-demo -----------------------------
-- input -> crawl (crawl4ai_crawler) -> output. Proves the external crawler
-- end-to-end; the output is the crawled documents.

INSERT INTO pipelines (id, slug, name, description) VALUES
  (
    '00000000-0000-0000-0000-0000000d3020',
    'web-crawl-demo',
    'Web Crawl Demo',
    'External Crawl4AI crawler demo: input -> crawl -> output.'
  )
ON CONFLICT (slug) DO NOTHING;

INSERT INTO pipeline_versions (id, pipeline_id, version, status, spec, checksum, published_at) VALUES
  (
    '00000000-0000-0000-0000-0000000d3021',
    '00000000-0000-0000-0000-0000000d3020',
    '1.0.0',
    'published',
    '{"apiVersion":"rag-platform/v1","kind":"Pipeline","metadata":{"name":"web-crawl-demo","stages":[{"id":"s_auto_1","label":"Stage 1"},{"id":"s_auto_2","label":"Stage 2"},{"id":"s_auto_3","label":"Stage 3"}]},"spec":{"nodes":[{"id":"input","type":"input","ui":{"position":{"x":18.6875,"y":40},"stageId":"s_auto_1"}},{"id":"crawl","plugin":{"category":"datasource","id":"crawl4ai_crawler","version":"1.0.0"},"config":{"url":"https://www.cnn.com","maxPages":5,"maxDepth":1,"sameDomainOnly":true,"extract":"markdown","timeoutMs":60000},"ui":{"position":{"x":479.65625,"y":40},"stageId":"s_auto_2"}},{"id":"output","type":"output","ui":{"position":{"x":941.65625,"y":40},"stageId":"s_auto_3"}}],"edges":[{"from":"input","to":"crawl"},{"from":"crawl","to":"output","fromPort":"documents","toPort":"documents"}]}}'::jsonb,
    '738a8ce4',
    now()
  )
ON CONFLICT (pipeline_id, version) DO NOTHING;

-- Pin the published version to environment 'dev' for tenant 'tenant-local'.
INSERT INTO pipeline_deployments (id, pipeline_id, pipeline_version_id, environment, tenant_id, status)
SELECT
  '00000000-0000-0000-0000-0000000d3022',
  '00000000-0000-0000-0000-0000000d3020',
  '00000000-0000-0000-0000-0000000d3021',
  'dev',
  t.id,
  'active'
FROM tenants t
WHERE t.slug = 'tenant-local'
ON CONFLICT (pipeline_id, environment, tenant_id) DO NOTHING;

-- -------------------------- crawl-summarize-demo --------------------------
-- input -> retrieve (crawl4ai_crawler) -> prompt (basic_rag_prompt) ->
-- llm (provider_chat) -> output. Explicit port wiring:
--   input.question -> prompt.question (user question fans into the template)
--   retrieve.documents -> prompt.documents (crawled pages become context)
--   prompt.messages -> llm.messages (chat-style prompt for the model)
-- Reuses tenant-local's seeded Ollama config from zz-local-demo.sql (no new
-- config_values needed).

INSERT INTO pipelines (id, slug, name, description) VALUES
  (
    '00000000-0000-0000-0000-0000000d3030',
    'crawl-summarize-demo',
    'Crawl & Summarize Demo',
    'Crawl4AI -> basic_rag_prompt -> Ollama LLM RAG demo: input -> retrieve -> prompt -> llm -> output.'
  )
ON CONFLICT (slug) DO NOTHING;

INSERT INTO pipeline_versions (id, pipeline_id, version, status, spec, checksum, published_at) VALUES
  (
    '00000000-0000-0000-0000-0000000d3031',
    '00000000-0000-0000-0000-0000000d3030',
    '1.0.0',
    'published',
    '{"apiVersion":"rag-platform/v1","kind":"Pipeline","metadata":{"name":"crawl-summarize-demo","stages":[{"id":"s_auto_1","label":"Stage 1"},{"id":"s_auto_2","label":"Stage 2"},{"id":"s_auto_3","label":"Stage 3"},{"id":"s_auto_4","label":"Stage 4"},{"id":"s_auto_5","label":"Stage 5"}]},"spec":{"nodes":[{"id":"input","type":"input","ui":{"position":{"x":1.091796875,"y":40},"stageId":"s_auto_1"}},{"id":"retrieve","plugin":{"category":"datasource","id":"crawl4ai_crawler","version":"1.0.0"},"config":{"url":"https://www.cnn.com","maxPages":5,"maxDepth":1,"sameDomainOnly":true,"extract":"markdown","timeoutMs":60000},"ui":{"position":{"x":459.57373046875,"y":40},"stageId":"s_auto_2"}},{"id":"prompt","plugin":{"category":"prompt_template","id":"basic_rag_prompt","version":"1.0.0"},"ui":{"position":{"x":918.72705078125,"y":40},"stageId":"s_auto_3"}},{"id":"llm","plugin":{"category":"llm","id":"provider_chat","version":"1.0.0"},"config":{"provider":"${config.llm.provider}","model":"${config.llm.model}","baseUrl":"${config.llm.base_url}"},"ui":{"position":{"x":1379.3037109375,"y":40},"stageId":"s_auto_4"}},{"id":"output","type":"output","ui":{"position":{"x":1841.3037109375,"y":40},"stageId":"s_auto_5"}}],"edges":[{"from":"input","to":"prompt","fromPort":"question","toPort":"question"},{"from":"input","to":"retrieve"},{"from":"retrieve","to":"prompt","fromPort":"documents","toPort":"documents"},{"from":"prompt","to":"llm","fromPort":"messages","toPort":"messages"},{"from":"llm","to":"output"}]}}'::jsonb,
    'cb1d9fd6',
    now()
  )
ON CONFLICT (pipeline_id, version) DO NOTHING;

-- Pin the published version to environment 'dev' for tenant 'tenant-local'.
INSERT INTO pipeline_deployments (id, pipeline_id, pipeline_version_id, environment, tenant_id, status)
SELECT
  '00000000-0000-0000-0000-0000000d3032',
  '00000000-0000-0000-0000-0000000d3030',
  '00000000-0000-0000-0000-0000000d3031',
  'dev',
  t.id,
  'active'
FROM tenants t
WHERE t.slug = 'tenant-local'
ON CONFLICT (pipeline_id, environment, tenant_id) DO NOTHING;
