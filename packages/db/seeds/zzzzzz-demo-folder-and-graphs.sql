-- Demo Pipelines folder + graph-modality demos.
--
-- Filename prefix `zzzzzz` sorts AFTER every other seed so all the
-- demo pipeline rows are already in place when this runs and the
-- UPDATE below can move them by slug.
--
-- Two responsibilities:
--   1. Create a "Demo Pipelines" folder and reparent every bundled
--      demo into it, so a fresh stack opens the Builder with one
--      tidy folder instead of nine loose pipelines at the root.
--   2. Seed the two graph-modality demos (github-knowledge-graph +
--      crawl-knowledge-graph) along with the global datasets +
--      versions + aliases they pin. Pair them with tenant-local /
--      dev deployments so they show up as runnable out of the box.

-- ---- folder ---------------------------------------------------------------

INSERT INTO pipeline_folders (id, parent_id, name)
VALUES ('00000000-0000-0000-0000-0000000df010', NULL, 'Demo Pipelines')
ON CONFLICT (parent_id, name) DO NOTHING;

-- Move every shipped demo into the new folder. WHERE-by-slug is safe
-- because slugs are unique; ON CONFLICT isn't possible on UPDATE so we
-- list the slugs explicitly to avoid sweeping a user's own pipelines.
UPDATE pipelines
SET folder_id = '00000000-0000-0000-0000-0000000df010'
WHERE slug IN (
  'local-demo',
  'web-crawl-demo',
  'crawl-summarize-demo',
  'codebase-ingest-code',
  'codebase-ingest-docs',
  'transform-demo',
  'xml-codec-demo'
);

-- ---- github-knowledge-graph pipeline -------------------------------------

INSERT INTO pipelines (id, slug, name, description, folder_id) VALUES
  (
    '00000000-0000-0000-0000-0000000df020',
    'github-knowledge-graph',
    'GitHub Knowledge Graph',
    'Pulls a GitHub repo via github_source, chunks each file, and writes the chunks into a tenant-scoped Dgraph graph.',
    '00000000-0000-0000-0000-0000000df010'
  )
ON CONFLICT (slug) DO NOTHING;

INSERT INTO pipeline_versions (id, pipeline_id, version, status, spec, checksum, published_at) VALUES
  (
    '00000000-0000-0000-0000-0000000df021',
    '00000000-0000-0000-0000-0000000df020',
    '1.0.0',
    'published',
    '{"apiVersion":"rag-platform/v1","kind":"Pipeline","metadata":{"name":"github-knowledge-graph","description":"Pulls a GitHub repo, extracts entities + relations into a Dgraph graph. Pair with the github-kg-query pipeline to retrieve via DQL.","labels":{"demo":"graph"}},"spec":{"parameters":[{"key":"repo","type":"string","defaultValue":"octocat/Hello-World","allowedScopes":["pipeline","tenant_pipeline","runtime"],"runtimeOverridable":true,"description":"owner/name of the GitHub repository to ingest."}],"nodes":[{"id":"input","type":"input"},{"id":"github","plugin":{"category":"datasource","id":"github_source","version":"1.0.0"},"config":{"repo":"${config.repo}","ref":"main","include":["**/*.md","src/**/*.{ts,js,py}"],"computeHash":true},"secrets":{"token":{"scope":"tenant","key":"github.token"}}},{"id":"chunk","plugin":{"category":"chunker","id":"basic_text_chunker","version":"1.0.0"},"config":{"chunkSize":1500,"overlap":100}},{"id":"upsert","plugin":{"category":"sink","id":"dgraph_upsert","version":"1.0.0"},"dataset":{"slug":"github-knowledge-graph","alias":"stable"},"config":{"schema":"tenant_id: string @index(exact) . path: string @index(exact) . text: string @index(fulltext) . repo: string @index(exact) . chunk_of: uid @reverse . dgraph.type: [string] @index(exact) ."}},{"id":"output","type":"output"}],"edges":[{"from":"input","to":"github","fromPort":"question","toPort":"question"},{"from":"github","to":"chunk","fromPort":"documents","toPort":"documents"},{"from":"chunk","to":"upsert","fromPort":"chunks","toPort":"nodes"},{"from":"upsert","to":"output"}]}}'::jsonb,
    'c6f9912f',
    now()
  )
ON CONFLICT (pipeline_id, version) DO NOTHING;

INSERT INTO pipeline_deployments (id, pipeline_id, pipeline_version_id, environment, tenant_id, status)
SELECT
  '00000000-0000-0000-0000-0000000df022',
  '00000000-0000-0000-0000-0000000df020',
  '00000000-0000-0000-0000-0000000df021',
  'dev',
  t.id,
  'active'
FROM tenants t
WHERE t.slug = 'tenant-local'
ON CONFLICT (pipeline_id, environment, tenant_id) DO NOTHING;

-- ---- crawl-knowledge-graph pipeline --------------------------------------

INSERT INTO pipelines (id, slug, name, description, folder_id) VALUES
  (
    '00000000-0000-0000-0000-0000000df030',
    'crawl-knowledge-graph',
    'Crawl Knowledge Graph',
    'Crawls a public site, chunks each page, and writes the chunks into a tenant-scoped Dgraph graph keyed by URL.',
    '00000000-0000-0000-0000-0000000df010'
  )
ON CONFLICT (slug) DO NOTHING;

INSERT INTO pipeline_versions (id, pipeline_id, version, status, spec, checksum, published_at) VALUES
  (
    '00000000-0000-0000-0000-0000000df031',
    '00000000-0000-0000-0000-0000000df030',
    '1.0.0',
    'published',
    '{"apiVersion":"rag-platform/v1","kind":"Pipeline","metadata":{"name":"crawl-knowledge-graph","description":"Crawls a public site, chunks each page, and writes the chunks into a Dgraph knowledge graph keyed by URL + chunk index. Pair with dgraph_query to retrieve via DQL.","labels":{"demo":"graph"}},"spec":{"parameters":[{"key":"url","type":"string","defaultValue":"https://en.wikipedia.org/wiki/Knowledge_graph","allowedScopes":["pipeline","tenant_pipeline","runtime"],"runtimeOverridable":true,"description":"Seed URL the crawler starts from."},{"key":"maxPages","type":"integer","defaultValue":5,"allowedScopes":["pipeline","tenant_pipeline","runtime"],"runtimeOverridable":true,"description":"Hard cap on pages fetched (be polite)."}],"nodes":[{"id":"input","type":"input"},{"id":"crawl","plugin":{"category":"datasource","id":"crawl4ai_crawler","version":"1.0.0"},"config":{"url":"${config.url}","maxPages":"${config.maxPages}","maxDepth":1,"sameDomainOnly":true,"extract":"markdown","timeoutMs":60000}},{"id":"chunk","plugin":{"category":"chunker","id":"basic_text_chunker","version":"1.0.0"},"config":{"chunkSize":1200,"overlap":100}},{"id":"upsert","plugin":{"category":"sink","id":"dgraph_upsert","version":"1.0.0"},"dataset":{"slug":"crawl-knowledge-graph","alias":"stable"},"config":{"schema":"tenant_id: string @index(exact) . source_url: string @index(exact) . text: string @index(fulltext) . chunkIndex: int . dgraph.type: [string] @index(exact) ."}},{"id":"output","type":"output"}],"edges":[{"from":"input","to":"crawl","fromPort":"question","toPort":"question"},{"from":"crawl","to":"chunk","fromPort":"documents","toPort":"documents"},{"from":"chunk","to":"upsert","fromPort":"chunks","toPort":"nodes"},{"from":"upsert","to":"output"}]}}'::jsonb,
    'f57b2dd0',
    now()
  )
ON CONFLICT (pipeline_id, version) DO NOTHING;

INSERT INTO pipeline_deployments (id, pipeline_id, pipeline_version_id, environment, tenant_id, status)
SELECT
  '00000000-0000-0000-0000-0000000df032',
  '00000000-0000-0000-0000-0000000df030',
  '00000000-0000-0000-0000-0000000df031',
  'dev',
  t.id,
  'active'
FROM tenants t
WHERE t.slug = 'tenant-local'
ON CONFLICT (pipeline_id, environment, tenant_id) DO NOTHING;

-- ---- graph datasets ------------------------------------------------------
-- Two global datasets declaring the `graph` modality so the dgraph_upsert
-- node in each demo can pin its slug + alias. Backends point at the dgraph
-- service; per-tenant overrides land on the Datasets screen at deploy time.

INSERT INTO datasets (id, scope, slug, display_name, description, modalities, backends)
VALUES
  (
    '00000000-0000-0000-0000-0000000df040',
    'global',
    'github-knowledge-graph',
    'GitHub Knowledge Graph',
    'Tenant-scoped graph of code + docs chunks pulled from GitHub.',
    ARRAY['graph'],
    '{"graph":{"provider":"dgraph"}}'::jsonb
  ),
  (
    '00000000-0000-0000-0000-0000000df041',
    'global',
    'crawl-knowledge-graph',
    'Crawl Knowledge Graph',
    'Tenant-scoped graph of crawled page chunks keyed by source_url.',
    ARRAY['graph'],
    '{"graph":{"provider":"dgraph"}}'::jsonb
  )
ON CONFLICT DO NOTHING;

INSERT INTO dataset_versions (id, dataset_id, version_label, schema_spec, backend_collections, status, ready_at)
VALUES
  (
    '00000000-0000-0000-0000-0000000df050',
    '00000000-0000-0000-0000-0000000df040',
    'v1',
    '{}'::jsonb,
    '{"graph":"github-knowledge-graph"}'::jsonb,
    'ready',
    now()
  ),
  (
    '00000000-0000-0000-0000-0000000df051',
    '00000000-0000-0000-0000-0000000df041',
    'v1',
    '{}'::jsonb,
    '{"graph":"crawl-knowledge-graph"}'::jsonb,
    'ready',
    now()
  )
ON CONFLICT DO NOTHING;

UPDATE datasets SET current_version_id = '00000000-0000-0000-0000-0000000df050'
  WHERE id = '00000000-0000-0000-0000-0000000df040' AND current_version_id IS NULL;
UPDATE datasets SET current_version_id = '00000000-0000-0000-0000-0000000df051'
  WHERE id = '00000000-0000-0000-0000-0000000df041' AND current_version_id IS NULL;

INSERT INTO dataset_aliases (id, dataset_id, alias, version_id)
VALUES
  (
    '00000000-0000-0000-0000-0000000df060',
    '00000000-0000-0000-0000-0000000df040',
    'stable',
    '00000000-0000-0000-0000-0000000df050'
  ),
  (
    '00000000-0000-0000-0000-0000000df061',
    '00000000-0000-0000-0000-0000000df041',
    'stable',
    '00000000-0000-0000-0000-0000000df051'
  )
ON CONFLICT (dataset_id, alias) DO NOTHING;
