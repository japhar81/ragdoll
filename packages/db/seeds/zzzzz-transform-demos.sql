-- Data-shaping demos for the `transform` and `xml_codec` plugins. Filename
-- `zzzzz-...` sorts AFTER `zzzz-codebase-ingest.sql` under the loader's
-- `localeCompare` ordering, so the 'tenant-local' tenant and its 'dev'
-- environment seeded earlier exist before these pipelines deploy.
--
-- Unlike the codebase-ingest demos, these run with NO setup:
--   - no /workspace mount  (they take their input from the run request)
--   - no secrets           (no embedder, vector store, or network calls)
--
-- HOW TO RUN
--
--   transform-demo  expects a run input shaped like:
--     { "payload": { "title": "Release 1.2", "items": [1,2,3], "tags": ["rag","docs"] } }
--   ...and emits `summary` ("Release 1.2 - 3 items") and `keywords` on two
--   independently-wired output nodes.
--
--   xml-codec-demo  expects a run input shaped like:
--     { "xml": "<feed><item><title>A</title></item><item><title>B</title></item></feed>" }
--   ...and emits the projected item titles.
--
-- Each pipeline_versions.spec JSON below is byte-identical to the parsed form
-- of its examples/pipelines/*.yaml and the checksum is its specChecksum (see
-- packages/pipeline-spec). Keep them in sync if the YAML changes.

-- ------------------------------ transform-demo ------------------------------
-- input -> transform (1 config-driven input port, 2 config-driven output
--   ports) -> { out_summary, out_keywords }.

INSERT INTO pipelines (id, slug, name, description) VALUES
  (
    '00000000-0000-0000-0000-0000000d5010',
    'transform-demo',
    'Transform Demo',
    'Reshapes a JSON payload with the transform plugin: one configurable input port fans out to two independently-wired output ports, each computed by its own JSONata expression. Runs with no external services.'
  )
ON CONFLICT (slug) DO NOTHING;

INSERT INTO pipeline_versions (id, pipeline_id, version, status, spec, checksum, published_at) VALUES
  (
    '00000000-0000-0000-0000-0000000d5011',
    '00000000-0000-0000-0000-0000000d5010',
    '1.0.0',
    'published',
    '{"apiVersion":"rag-platform/v1","kind":"Pipeline","metadata":{"name":"transform-demo","description":"Reshapes a JSON payload with the transform plugin. One configurable input port fans out to two independently-wired output ports, each computed by its own JSONata expression. Runs with no external services; supply a run input with a payload object holding title, items and tags.","stages":[{"id":"s_auto_1","label":"Stage 1"},{"id":"s_auto_2","label":"Stage 2"},{"id":"s_auto_3","label":"Stage 3"}]},"spec":{"nodes":[{"id":"input","type":"input","ui":{"position":{"x":13.015625,"y":110},"stageId":"s_auto_1"}},{"id":"derive","plugin":{"category":"transformer","id":"transform","version":"1.0.0"},"config":{"engine":"jsonata","inputs":["payload"],"outputs":{"summary":"payload.title & '' - '' & $string($count(payload.items)) & '' items''","keywords":"payload.tags"}},"ui":{"position":{"x":473.2109375,"y":110},"stageId":"s_auto_2"}},{"id":"out_summary","type":"output","ui":{"position":{"x":938.5625,"y":29},"stageId":"s_auto_3"}},{"id":"out_keywords","type":"output","ui":{"position":{"x":935.2109375,"y":191},"stageId":"s_auto_3"}}],"edges":[{"from":"input","to":"derive","fromPort":"payload","toPort":"payload"},{"from":"derive","to":"out_summary","fromPort":"summary","toPort":"result"},{"from":"derive","to":"out_keywords","fromPort":"keywords","toPort":"result"}]}}'::jsonb,
    '55f73fd8',
    now()
  )
ON CONFLICT (pipeline_id, version) DO NOTHING;

INSERT INTO pipeline_deployments (id, pipeline_id, pipeline_version_id, environment, tenant_id, status)
SELECT
  '00000000-0000-0000-0000-0000000d5012',
  '00000000-0000-0000-0000-0000000d5010',
  '00000000-0000-0000-0000-0000000d5011',
  'dev',
  t.id,
  'active'
FROM tenants t
WHERE t.slug = 'tenant-local'
ON CONFLICT (pipeline_id, environment, tenant_id) DO NOTHING;

-- ------------------------------ xml-codec-demo ------------------------------
-- input -> xml_codec (parse) -> transform (JSONata projection) -> output.

INSERT INTO pipelines (id, slug, name, description) VALUES
  (
    '00000000-0000-0000-0000-0000000d5020',
    'xml-codec-demo',
    'XML Codec Demo',
    'Parses an XML feed into JSON with xml_codec, then projects the item titles out with a transform (JSONata) node. Runs with no external services.'
  )
ON CONFLICT (slug) DO NOTHING;

INSERT INTO pipeline_versions (id, pipeline_id, version, status, spec, checksum, published_at) VALUES
  (
    '00000000-0000-0000-0000-0000000d5021',
    '00000000-0000-0000-0000-0000000d5020',
    '1.0.0',
    'published',
    '{"apiVersion":"rag-platform/v1","kind":"Pipeline","metadata":{"name":"xml-codec-demo","description":"Parses an XML feed into JSON with xml_codec, then projects the item titles out with a transform (JSONata) node. Runs with no external services; supply a run input with an xml string.","stages":[{"id":"s_auto_1","label":"Stage 1"},{"id":"s_auto_2","label":"Stage 2"},{"id":"s_auto_3","label":"Stage 3"},{"id":"s_auto_4","label":"Stage 4"}]},"spec":{"nodes":[{"id":"input","type":"input","ui":{"position":{"x":8.71875,"y":40},"stageId":"s_auto_1"}},{"id":"parse","plugin":{"category":"transformer","id":"xml_codec","version":"1.0.0"},"config":{"mode":"parse"},"ui":{"position":{"x":469,"y":40},"stageId":"s_auto_2"}},{"id":"titles","plugin":{"category":"transformer","id":"transform","version":"1.0.0"},"config":{"engine":"jsonata","inputs":["json"],"outputs":{"titles":"json.feed.item.title"}},"ui":{"position":{"x":931,"y":40},"stageId":"s_auto_3"}},{"id":"output","type":"output","ui":{"position":{"x":1391.28125,"y":40},"stageId":"s_auto_4"}}],"edges":[{"from":"input","to":"parse","fromPort":"xml","toPort":"xml"},{"from":"parse","to":"titles","fromPort":"json","toPort":"json"},{"from":"titles","to":"output","fromPort":"titles","toPort":"result"}]}}'::jsonb,
    '7ac6c05f',
    now()
  )
ON CONFLICT (pipeline_id, version) DO NOTHING;

INSERT INTO pipeline_deployments (id, pipeline_id, pipeline_version_id, environment, tenant_id, status)
SELECT
  '00000000-0000-0000-0000-0000000d5022',
  '00000000-0000-0000-0000-0000000d5020',
  '00000000-0000-0000-0000-0000000d5021',
  'dev',
  t.id,
  'active'
FROM tenants t
WHERE t.slug = 'tenant-local'
ON CONFLICT (pipeline_id, environment, tenant_id) DO NOTHING;
