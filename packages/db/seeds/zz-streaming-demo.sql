-- Result-streaming demo (ADR-0037). Self-contained: two `transform` steps in
-- sequence, EACH marked `stream: true`, so its output is pushed to the live
-- execution stream the moment it completes — "primary" streams first,
-- "ancillary" next, and the final output arrives at the end. No external
-- services needed (pure JSONata reshaping), so it runs out of the box.
--
-- Try it: open the pipeline in the Builder and click "Stream" (watch the
-- "Streamed steps" panel), or `POST /api/pipelines/streaming-demo/run` and
-- watch `GET /api/executions/:id/stream`.
--
-- Filename `zz-...` sorts AFTER `demo.sql` (which seeds the 'tenant-local'
-- tenant + 'dev' environment this depends on). Every insert is idempotent.
-- The spec JSON matches examples/pipelines/streaming-demo.yaml; the checksum
-- is its specChecksum (packages/pipeline-spec). Keep them in sync.

INSERT INTO pipelines (id, slug, name, description) VALUES
  (
    '00000000-0000-0000-0000-0000000d6010',
    'streaming-demo',
    'Result Streaming Demo',
    'ADR-0037 per-step result streaming: two transform steps each stream their output mid-run (primary, then ancillary) before the final output. No external services.'
  )
ON CONFLICT (slug) DO NOTHING;

INSERT INTO pipeline_versions (id, pipeline_id, version, status, spec, checksum, published_at) VALUES
  (
    '00000000-0000-0000-0000-0000000d6011',
    '00000000-0000-0000-0000-0000000d6010',
    '1.0.0',
    'published',
    '{"apiVersion":"rag-platform/v1","kind":"Pipeline","metadata":{"name":"streaming-demo","description":"Demonstrates ADR-0037 per-step result streaming: two transformer steps each marked `stream: true` push their output to the live execution stream as they complete (primary first, then ancillary), before the final output. Runs with no external services.","stages":[{"id":"s_auto_1","label":"Stage 1"},{"id":"s_auto_2","label":"Stage 2"},{"id":"s_auto_3","label":"Stage 3"},{"id":"s_auto_4","label":"Stage 4"}]},"spec":{"nodes":[{"id":"input","type":"input","config":{"default":{"topic":"result streaming"}},"ui":{"position":{"x":16,"y":80},"stageId":"s_auto_1"}},{"id":"primary","plugin":{"category":"transformer","id":"transform","version":"1.0.0"},"stream":true,"streamAs":"primary","config":{"engine":"jsonata","inputs":["topic"],"outputs":{"primary":"''Primary result for: '' & topic","topic":"topic"}},"ui":{"position":{"x":470,"y":80},"stageId":"s_auto_2"}},{"id":"ancillary","plugin":{"category":"transformer","id":"transform","version":"1.0.0"},"stream":true,"streamAs":"ancillary","config":{"engine":"jsonata","inputs":["topic"],"outputs":{"ancillary":"''Ancillary detail for: '' & topic"}},"ui":{"position":{"x":924,"y":80},"stageId":"s_auto_3"}},{"id":"output","type":"output","ui":{"position":{"x":1378,"y":80},"stageId":"s_auto_4"}}],"edges":[{"from":"input","to":"primary","fromPort":"topic","toPort":"topic"},{"from":"primary","to":"ancillary","fromPort":"topic","toPort":"topic"},{"from":"ancillary","to":"output","fromPort":"ancillary","toPort":"result"}]}}'::jsonb,
    'bf2727c7',
    now()
  )
ON CONFLICT (pipeline_id, version) DO UPDATE
SET spec = EXCLUDED.spec, checksum = EXCLUDED.checksum, status = EXCLUDED.status;

-- Pin the published version to environment 'dev' for tenant 'tenant-local'.
INSERT INTO pipeline_deployments (id, pipeline_id, pipeline_version_id, environment, tenant_id, status)
SELECT
  '00000000-0000-0000-0000-0000000d6012',
  '00000000-0000-0000-0000-0000000d6010',
  '00000000-0000-0000-0000-0000000d6011',
  'dev',
  t.id,
  'active'
FROM tenants t
WHERE t.slug = 'tenant-local'
ON CONFLICT (pipeline_id, environment, tenant_id) DO NOTHING;
