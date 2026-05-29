-- Out-of-the-box codebase ingestion demos. Filename `zzzz-...` sorts AFTER
-- `zzz-crawl-demo.sql` under the loader's `localeCompare` ordering so the
-- 'tenant-local' tenant and its 'dev' environment seeded earlier are
-- guaranteed to exist by the time these pipelines pin their deployments.
--
-- NO PRE-FLIGHT REQUIRED. Both pipelines walk `rootPath: /app` (the
-- worker container's app code dir — present in every install). That
-- gives "Run All" a real corpus to ingest immediately. Point
-- `fs.rootPath` at a mounted volume (compose: bind-mount the host
-- repo; helm: add an emptyDir + git clone init container) to index
-- your own code instead.
--
-- The seeded specs below ship WITHOUT `secrets:` blocks so the demos run
-- cleanly against the in-stack Ollama embedder + dev Qdrant/OpenSearch
-- (no auth). If you switch the embedder/store to a paid provider, re-add
-- the secret refs via the Builder — the YAMLs under examples/pipelines/
-- document the expected shape.
--
-- Embedding dimensionality: the seeded `${config.embedding.*}` resolves
-- to ollama + nomic-embed-text (768d). codebase-ingest-docs's
-- opensearch_output explicitly pins `dimensions: 768` to match. If you
-- swap embedders, also adjust the OpenSearch KNN config to the new dim.
--
-- Each pipeline_versions.spec JSON below is byte-identical to the parsed
-- form of its examples/pipelines/*.yaml (with the secrets blocks stripped)
-- and the checksum is its specChecksum (see packages/pipeline-spec).

-- --------------------------- codebase-ingest-code ---------------------------
-- filesystem_source -> delta_filter -> { new+modified -> code_chunker ->
--   provider_embeddings -> qdrant_vector_store, deleted -> qdrant_delete }.

INSERT INTO pipelines (id, slug, name, description) VALUES
  (
    '00000000-0000-0000-0000-0000000d4010',
    'codebase-ingest-code',
    'Codebase Ingest (code)',
    'Symbol-aware ingestion of a polyglot codebase into Qdrant. Reads /app (the worker''s app code dir by default), chunks by language, embeds, upserts into the `codebase` Qdrant collection.'
  )
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description;

INSERT INTO pipeline_versions (id, pipeline_id, version, status, spec, checksum, published_at) VALUES
  (
    '00000000-0000-0000-0000-0000000d4011',
    '00000000-0000-0000-0000-0000000d4010',
    '1.0.0',
    'published',
    '{"apiVersion":"rag-platform/v1","kind":"Pipeline","metadata":{"name":"codebase-ingest-code","description":"Symbol-aware ingestion of a polyglot codebase into Qdrant. First pass embeds everything; subsequent passes touch only deltas (and delete rows for files removed on disk). Defaults to the api/worker image''s /app dir so it works out of the box on every install — point `fs.rootPath` at a mounted volume to index your own repo.","stages":[{"id":"s_auto_1","label":"Stage 1"},{"id":"s_auto_2","label":"Stage 2"},{"id":"s_auto_3","label":"Stage 3"},{"id":"s_auto_4","label":"Stage 4"},{"id":"s_auto_5","label":"Stage 5"},{"id":"s_auto_6","label":"Stage 6"}]},"spec":{"nodes":[{"id":"fs","plugin":{"category":"datasource","id":"filesystem_source","version":"1.0.0"},"config":{"rootPath":"/app","include":["**/*.{ts,tsx,js,jsx,py,go,rs,java,kt,c,h,cpp,cc,hpp,cs,rb,php,sh}"],"exclude":["docs/**","**/node_modules/**","**/dist/**","**/build/**","**/.next/**","**/.git/**","**/coverage/**"],"maxFileSize":524288,"computeHash":false},"ui":{"position":{"x":-4.924163818359375,"y":110},"stageId":"s_auto_1"}},{"id":"delta","plugin":{"category":"transformer","id":"delta_filter","version":"1.0.0"},"config":{"stateKey":"code","compareBy":"mtime"},"ui":{"position":{"x":452.82713317871094,"y":110},"stageId":"s_auto_2"}},{"id":"chunk","plugin":{"category":"chunker","id":"code_chunker","version":"1.0.0"},"config":{"maxChars":4000,"minChars":400},"ui":{"position":{"x":910.5723037719727,"y":29},"stageId":"s_auto_3"}},{"id":"embed","plugin":{"category":"embedder","id":"provider_embeddings","version":"1.0.0"},"config":{"provider":"${config.embedding.provider}","model":"${config.embedding.model}"},"ui":{"position":{"x":1369.381181716919,"y":110},"stageId":"s_auto_4"}},{"id":"write","plugin":{"category":"vector_store","id":"qdrant_vector_store","version":"1.0.0"},"dataset":{"slug":"codebase-ingest-code","alias":"stable"},"config":{"collection":"codebase"},"ui":{"position":{"x":1829.1748056411743,"y":110},"stageId":"s_auto_5"}},{"id":"delete","plugin":{"category":"sink","id":"qdrant_delete","version":"1.0.0"},"dataset":{"slug":"codebase-ingest-code","alias":"stable"},"config":{"collection":"codebase"},"ui":{"position":{"x":911.7939338684082,"y":191},"stageId":"s_auto_3"}},{"id":"out","type":"output","ui":{"position":{"x":2291.1748056411743,"y":110},"stageId":"s_auto_6"}}],"edges":[{"from":"fs","to":"delta","fromPort":"documents","toPort":"documents"},{"from":"delta","to":"chunk","fromPort":"new","toPort":"documents"},{"from":"delta","to":"chunk","fromPort":"modified","toPort":"documents"},{"from":"chunk","to":"embed","fromPort":"chunks","toPort":"chunks"},{"from":"chunk","to":"write","fromPort":"chunks","toPort":"chunks"},{"from":"embed","to":"write","fromPort":"vectors","toPort":"vectors"},{"from":"delta","to":"delete","fromPort":"deleted","toPort":"deleted"},{"from":"write","to":"out"},{"from":"delete","to":"out"}]}}'::jsonb,
    '6d7d3298',
    now()
  )
ON CONFLICT (pipeline_id, version) DO UPDATE
SET spec = EXCLUDED.spec,
    checksum = EXCLUDED.checksum,
    status = EXCLUDED.status;

INSERT INTO pipeline_deployments (id, pipeline_id, pipeline_version_id, environment, tenant_id, status)
SELECT
  '00000000-0000-0000-0000-0000000d4012',
  '00000000-0000-0000-0000-0000000d4010',
  '00000000-0000-0000-0000-0000000d4011',
  'dev',
  t.id,
  'active'
FROM tenants t
WHERE t.slug = 'tenant-local'
ON CONFLICT (pipeline_id, environment, tenant_id) DO NOTHING;

-- --------------------------- codebase-ingest-docs ---------------------------
-- filesystem_source -> delta_filter -> { new+modified -> basic_text_chunker ->
--   provider_embeddings -> opensearch_output, deleted -> opensearch_delete }.

INSERT INTO pipelines (id, slug, name, description) VALUES
  (
    '00000000-0000-0000-0000-0000000d4020',
    'codebase-ingest-docs',
    'Codebase Ingest (docs)',
    'Delta-aware ingestion of /app/docs into OpenSearch as a BM25 + kNN hybrid index. Independent state bucket from codebase-ingest-code.'
  )
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description;

INSERT INTO pipeline_versions (id, pipeline_id, version, status, spec, checksum, published_at) VALUES
  (
    '00000000-0000-0000-0000-0000000d4021',
    '00000000-0000-0000-0000-0000000d4020',
    '1.0.0',
    'published',
    '{"apiVersion":"rag-platform/v1","kind":"Pipeline","metadata":{"name":"codebase-ingest-docs","description":"Delta-aware ingestion of the docs/ tree into OpenSearch as a BM25 + kNN hybrid index. Independent state bucket from codebase-ingest-code. Defaults to the api/worker image''s /app/docs dir; point `fs.rootPath` at a mounted volume to index your own docs.","stages":[{"id":"s_auto_1","label":"Stage 1"},{"id":"s_auto_2","label":"Stage 2"},{"id":"s_auto_3","label":"Stage 3"},{"id":"s_auto_4","label":"Stage 4"},{"id":"s_auto_5","label":"Stage 5"},{"id":"s_auto_6","label":"Stage 6"}]},"spec":{"nodes":[{"id":"fs","plugin":{"category":"datasource","id":"filesystem_source","version":"1.0.0"},"config":{"rootPath":"/app","include":["docs/**/*.md","docs/**/*.mdx","**/README.md"],"maxFileSize":1048576,"computeHash":false,"exclude":["**/node_modules/**","**/dist/**","**/build/**","**/.next/**","**/.git/**"]},"ui":{"position":{"x":-4.924163818359375,"y":110},"stageId":"s_auto_1"}},{"id":"delta","plugin":{"category":"transformer","id":"delta_filter","version":"1.0.0"},"config":{"stateKey":"docs","compareBy":"mtime"},"ui":{"position":{"x":452.82713317871094,"y":110},"stageId":"s_auto_2"}},{"id":"chunk","plugin":{"category":"chunker","id":"basic_text_chunker","version":"1.0.0"},"config":{"chunkSize":1500,"overlap":150},"ui":{"position":{"x":910.5723037719727,"y":29},"stageId":"s_auto_3"}},{"id":"embed","plugin":{"category":"embedder","id":"provider_embeddings","version":"1.0.0"},"config":{"provider":"${config.embedding.provider}","model":"${config.embedding.model}"},"ui":{"position":{"x":1369.381181716919,"y":110},"stageId":"s_auto_4"}},{"id":"write","plugin":{"category":"sink","id":"opensearch_output","version":"1.0.0"},"dataset":{"slug":"codebase-ingest-docs","alias":"stable"},"config":{"index":"codebase-docs","vectorField":"embedding","dimensions":768,"createKnnIndex":true,"idField":"docId"},"ui":{"position":{"x":1829.1748056411743,"y":110},"stageId":"s_auto_5"}},{"id":"delete","plugin":{"category":"sink","id":"opensearch_delete","version":"1.0.0"},"dataset":{"slug":"codebase-ingest-docs","alias":"stable"},"config":{"index":"codebase-docs"},"ui":{"position":{"x":911.7939338684082,"y":191},"stageId":"s_auto_3"}},{"id":"out","type":"output","ui":{"position":{"x":2291.1748056411743,"y":110},"stageId":"s_auto_6"}}],"edges":[{"from":"fs","to":"delta","fromPort":"documents","toPort":"documents"},{"from":"delta","to":"chunk","fromPort":"new","toPort":"documents"},{"from":"delta","to":"chunk","fromPort":"modified","toPort":"documents"},{"from":"chunk","to":"embed","fromPort":"chunks","toPort":"chunks"},{"from":"chunk","to":"write","fromPort":"chunks","toPort":"chunks"},{"from":"embed","to":"write","fromPort":"vectors","toPort":"vectors"},{"from":"delta","to":"delete","fromPort":"deleted","toPort":"deleted"},{"from":"write","to":"out"},{"from":"delete","to":"out"}]}}'::jsonb,
    'e1e5d041',
    now()
  )
ON CONFLICT (pipeline_id, version) DO UPDATE
SET spec = EXCLUDED.spec,
    checksum = EXCLUDED.checksum,
    status = EXCLUDED.status;

INSERT INTO pipeline_deployments (id, pipeline_id, pipeline_version_id, environment, tenant_id, status)
SELECT
  '00000000-0000-0000-0000-0000000d4022',
  '00000000-0000-0000-0000-0000000d4020',
  '00000000-0000-0000-0000-0000000d4021',
  'dev',
  t.id,
  'active'
FROM tenants t
WHERE t.slug = 'tenant-local'
ON CONFLICT (pipeline_id, environment, tenant_id) DO NOTHING;

-- --------------------------- datasets --------------------------------------
-- Slugs pinned by the two pipelines above. Both seeded at global scope so
-- the spec's `node.dataset = { slug, alias: "stable" }` resolves cleanly on
-- a fresh stack with no tenant/env overrides. Each gets a v1 dataset_version
-- and a stable alias so the runtime can look up backend_collections without
-- the operator having to create a version first.

INSERT INTO datasets (id, scope, slug, display_name, description, embedding_profile, modalities, backends)
VALUES
  (
    '00000000-0000-0000-0000-0000000d40d1',
    'global',
    'codebase-ingest-code',
    'Codebase Ingest (code)',
    'Backing dataset for codebase-ingest-code — Qdrant vector index of polyglot source code chunks.',
    '{"provider":"ollama","model":"nomic-embed-text","dimensions":768,"distance":"cosine"}'::jsonb,
    ARRAY['vector'],
    '{"vector":{"provider":"qdrant"}}'::jsonb
  ),
  (
    '00000000-0000-0000-0000-0000000d40d2',
    'global',
    'codebase-ingest-docs',
    'Codebase Ingest (docs)',
    'Backing dataset for codebase-ingest-docs — OpenSearch BM25 + kNN index of doc text.',
    -- nomic-embed-text emits 768-d vectors; the opensearch_output's KNN
    -- index config (in the pipeline spec above) must match this. 1536
    -- was the legacy value from an earlier text-embedding-ada-002 default.
    '{"provider":"ollama","model":"nomic-embed-text","dimensions":768,"distance":"cosine"}'::jsonb,
    ARRAY['text', 'vector'],
    '{"text":{"provider":"opensearch"},"vector":{"provider":"opensearch"}}'::jsonb
  )
ON CONFLICT DO NOTHING;

INSERT INTO dataset_versions (id, dataset_id, version_label, schema_spec, backend_collections, status, ready_at)
VALUES
  (
    '00000000-0000-0000-0000-0000000d40e1',
    '00000000-0000-0000-0000-0000000d40d1',
    'v1',
    '{}'::jsonb,
    '{"vector":"codebase"}'::jsonb,
    'ready',
    now()
  ),
  (
    '00000000-0000-0000-0000-0000000d40e2',
    '00000000-0000-0000-0000-0000000d40d2',
    'v1',
    '{}'::jsonb,
    '{"text":"codebase-docs","vector":"codebase-docs"}'::jsonb,
    'ready',
    now()
  )
ON CONFLICT DO NOTHING;

UPDATE datasets SET current_version_id = '00000000-0000-0000-0000-0000000d40e1'
  WHERE id = '00000000-0000-0000-0000-0000000d40d1' AND current_version_id IS NULL;
UPDATE datasets SET current_version_id = '00000000-0000-0000-0000-0000000d40e2'
  WHERE id = '00000000-0000-0000-0000-0000000d40d2' AND current_version_id IS NULL;

INSERT INTO dataset_aliases (id, dataset_id, alias, version_id)
VALUES
  (
    '00000000-0000-0000-0000-0000000d40f1',
    '00000000-0000-0000-0000-0000000d40d1',
    'stable',
    '00000000-0000-0000-0000-0000000d40e1'
  ),
  (
    '00000000-0000-0000-0000-0000000d40f2',
    '00000000-0000-0000-0000-0000000d40d2',
    'stable',
    '00000000-0000-0000-0000-0000000d40e2'
  )
ON CONFLICT (dataset_id, alias) DO NOTHING;
