-- Out-of-the-box codebase ingestion demos. Filename `zzzz-...` sorts AFTER
-- `zzz-crawl-demo.sql` under the loader's `localeCompare` ordering so the
-- 'tenant-local' tenant and its 'dev' environment seeded earlier are
-- guaranteed to exist by the time these pipelines pin their deployments.
--
-- TWO REQUIREMENTS BEFORE THESE PIPELINES RUN CLEANLY:
--
-- 1. /workspace mount. Both pipelines walk `rootPath: /workspace`. The
--    worker container doesn't mount your repo there by default. Add a
--    volume to `infra/docker/docker-compose.yml` under the worker service
--    (read-only is fine):
--
--        services:
--          worker:
--            volumes:
--              - /Users/you/path/to/your-codebase:/workspace:ro
--
--    Without this the pipeline will fail at the `fs` node with an empty
--    document list (or ENOENT depending on the host path).
--
-- 2. Secrets. Both YAMLs reference these per-tenant secret refs:
--
--      - embedding.api_key       (provider_embeddings + delete sinks)
--      - qdrant.api_key          (codebase-ingest-code)
--      - opensearch.username     (codebase-ingest-docs)
--      - opensearch.password     (codebase-ingest-docs)
--
--    For the in-stack Ollama embedder + dev Qdrant/OpenSearch (no auth)
--    these are unused at runtime — but secret resolution still fires, so
--    set them to placeholders before the first run:
--
--        curl -X PUT http://localhost:3001/api/secrets ... (per secret)
--
--    Or edit the spec in the builder to drop the secret refs entirely.
--
-- Each pipeline_versions.spec JSON below is byte-identical to the parsed
-- form of its examples/pipelines/*.yaml and the checksum is its
-- specChecksum (see packages/pipeline-spec). Keep them in sync if the YAML
-- changes (tests/e2e/codebase-ingest.e2e.test.ts would guard this; add one
-- following the crawl-demos.e2e pattern if you start editing).

-- --------------------------- codebase-ingest-code ---------------------------
-- filesystem_source -> delta_filter -> { new+modified -> code_chunker ->
--   provider_embeddings -> qdrant_vector_store, deleted -> qdrant_delete }.

INSERT INTO pipelines (id, slug, name, description) VALUES
  (
    '00000000-0000-0000-0000-0000000d4010',
    'codebase-ingest-code',
    'Codebase Ingest (code)',
    'Symbol-aware ingestion of a polyglot codebase into Qdrant. Reads /workspace, chunks by language, embeds, upserts into the `codebase` Qdrant collection.'
  )
ON CONFLICT (slug) DO NOTHING;

INSERT INTO pipeline_versions (id, pipeline_id, version, status, spec, checksum, published_at) VALUES
  (
    '00000000-0000-0000-0000-0000000d4011',
    '00000000-0000-0000-0000-0000000d4010',
    '1.0.0',
    'published',
    '{"apiVersion":"rag-platform/v1","kind":"Pipeline","metadata":{"name":"codebase-ingest-code","description":"Symbol-aware ingestion of a polyglot codebase into Qdrant. First pass embeds everything; subsequent passes touch only deltas (and delete rows for files removed on disk)."},"spec":{"nodes":[{"id":"fs","plugin":{"category":"datasource","id":"filesystem_source","version":"1.0.0"},"config":{"rootPath":"/workspace","include":["**/*.{ts,tsx,js,jsx,py,go,rs,java,kt,c,h,cpp,cc,hpp,cs,rb,php,sh}"],"exclude":["docs/**"],"maxFileSize":524288,"computeHash":false},"ui":{"position":{"x":-4.924163818359375,"y":110}}},{"id":"delta","plugin":{"category":"transformer","id":"delta_filter","version":"1.0.0"},"config":{"stateKey":"code","compareBy":"mtime"},"ui":{"position":{"x":452.82713317871094,"y":110}}},{"id":"chunk","plugin":{"category":"chunker","id":"code_chunker","version":"1.0.0"},"config":{"maxChars":4000,"minChars":400},"ui":{"position":{"x":910.5723037719727,"y":29}}},{"id":"embed","plugin":{"category":"embedder","id":"provider_embeddings","version":"1.0.0"},"config":{"provider":"${config.embedding.provider}","model":"${config.embedding.model}"},"secrets":{"apiKey":{"scope":"tenant","key":"embedding.api_key"}},"ui":{"position":{"x":1369.381181716919,"y":110}}},{"id":"write","plugin":{"category":"vector_store","id":"qdrant_vector_store","version":"1.0.0"},"config":{"collection":"codebase"},"secrets":{"apiKey":{"scope":"tenant","key":"qdrant.api_key"}},"ui":{"position":{"x":1829.1748056411743,"y":110}}},{"id":"delete","plugin":{"category":"sink","id":"qdrant_delete","version":"1.0.0"},"config":{"collection":"codebase"},"secrets":{"apiKey":{"scope":"tenant","key":"qdrant.api_key"}},"ui":{"position":{"x":911.7939338684082,"y":191}}},{"id":"out","type":"output","ui":{"position":{"x":2291.1748056411743,"y":110}}}],"edges":[{"from":"fs","to":"delta","fromPort":"documents","toPort":"documents"},{"from":"delta","to":"chunk","fromPort":"new","toPort":"documents"},{"from":"delta","to":"chunk","fromPort":"modified","toPort":"documents"},{"from":"chunk","to":"embed","fromPort":"chunks","toPort":"chunks"},{"from":"chunk","to":"write","fromPort":"chunks","toPort":"chunks"},{"from":"embed","to":"write","fromPort":"vectors","toPort":"vectors"},{"from":"delta","to":"delete","fromPort":"deleted","toPort":"deleted"},{"from":"write","to":"out"},{"from":"delete","to":"out"}]}}'::jsonb,
    'd39929bb',
    now()
  )
ON CONFLICT (pipeline_id, version) DO NOTHING;

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
    'Delta-aware ingestion of the docs/ tree into OpenSearch as a BM25 + kNN hybrid index. Independent state bucket from codebase-ingest-code.'
  )
ON CONFLICT (slug) DO NOTHING;

INSERT INTO pipeline_versions (id, pipeline_id, version, status, spec, checksum, published_at) VALUES
  (
    '00000000-0000-0000-0000-0000000d4021',
    '00000000-0000-0000-0000-0000000d4020',
    '1.0.0',
    'published',
    '{"apiVersion":"rag-platform/v1","kind":"Pipeline","metadata":{"name":"codebase-ingest-docs","description":"Delta-aware ingestion of the docs/ tree into OpenSearch as a BM25 + kNN hybrid index. Independent state bucket from codebase-ingest-code."},"spec":{"nodes":[{"id":"fs","plugin":{"category":"datasource","id":"filesystem_source","version":"1.0.0"},"config":{"rootPath":"/workspace","include":["docs/**/*.md","docs/**/*.mdx","**/README.md"],"maxFileSize":1048576,"computeHash":false},"ui":{"position":{"x":-4.924163818359375,"y":110}}},{"id":"delta","plugin":{"category":"transformer","id":"delta_filter","version":"1.0.0"},"config":{"stateKey":"docs","compareBy":"mtime"},"ui":{"position":{"x":452.82713317871094,"y":110}}},{"id":"chunk","plugin":{"category":"chunker","id":"basic_text_chunker","version":"1.0.0"},"config":{"chunkSize":1500,"overlap":150},"ui":{"position":{"x":910.5723037719727,"y":29}}},{"id":"embed","plugin":{"category":"embedder","id":"provider_embeddings","version":"1.0.0"},"config":{"provider":"${config.embedding.provider}","model":"${config.embedding.model}"},"secrets":{"apiKey":{"scope":"tenant","key":"embedding.api_key"}},"ui":{"position":{"x":1369.381181716919,"y":110}}},{"id":"write","plugin":{"category":"sink","id":"opensearch_output","version":"1.0.0"},"config":{"index":"codebase-docs","vectorField":"embedding","dimensions":1536,"createKnnIndex":true,"idField":"docId"},"secrets":{"username":{"scope":"tenant","key":"opensearch.username"},"password":{"scope":"tenant","key":"opensearch.password"}},"ui":{"position":{"x":1829.1748056411743,"y":110}}},{"id":"delete","plugin":{"category":"sink","id":"opensearch_delete","version":"1.0.0"},"config":{"index":"codebase-docs"},"secrets":{"username":{"scope":"tenant","key":"opensearch.username"},"password":{"scope":"tenant","key":"opensearch.password"}},"ui":{"position":{"x":911.7939338684082,"y":191}}},{"id":"out","type":"output","ui":{"position":{"x":2291.1748056411743,"y":110}}}],"edges":[{"from":"fs","to":"delta","fromPort":"documents","toPort":"documents"},{"from":"delta","to":"chunk","fromPort":"new","toPort":"documents"},{"from":"delta","to":"chunk","fromPort":"modified","toPort":"documents"},{"from":"chunk","to":"embed","fromPort":"chunks","toPort":"chunks"},{"from":"chunk","to":"write","fromPort":"chunks","toPort":"chunks"},{"from":"embed","to":"write","fromPort":"vectors","toPort":"vectors"},{"from":"delta","to":"delete","fromPort":"deleted","toPort":"deleted"},{"from":"write","to":"out"},{"from":"delete","to":"out"}]}}'::jsonb,
    '1e77302f',
    now()
  )
ON CONFLICT (pipeline_id, version) DO NOTHING;

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
