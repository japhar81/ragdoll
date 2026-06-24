-- 025_plugin_sources_host.sql
--
-- PLUGIN-ARCH-2: single source of truth for plugin sources.
--
-- A plugin source's CODE runs in one of two hosts:
--
--   'worker'   — the Node worker / API process. TS in-process plugins
--                loaded by the lifecycle in packages/plugin-loader
--                (the PLUGIN-ARCH-1 path). DEFAULT — every existing
--                row keeps its current behaviour.
--   'sidecar'  — the python-plugins sidecar. RAGdoll PUSHES these rows
--                to the sidecar's POST /admin/reload; the sidecar
--                clones + imports the Python handler(s) and serves
--                them. RAGdoll discovers the resulting plugins back via
--                the sidecar's GET /manifests and registers them as
--                external plugins (PLUGIN-ARCH-2).
--
-- This `host` column is what makes the `plugin_sources` table the
-- single source of truth: the Plugin Sources screen manages BOTH
-- families, and RAGdoll's refresh routes each row to the right host.
-- The sidecar no longer needs its own env-driven source list (though
-- RAGDOLL_PYTHON_PLUGIN_SOURCES still works as a fallback for an
-- air-gapped sidecar that RAGdoll can't reach).

ALTER TABLE plugin_sources
  ADD COLUMN IF NOT EXISTS host text NOT NULL DEFAULT 'worker';

ALTER TABLE plugin_sources
  DROP CONSTRAINT IF EXISTS plugin_sources_host_check;
ALTER TABLE plugin_sources
  ADD CONSTRAINT plugin_sources_host_check
  CHECK (host IN ('worker', 'sidecar'));

COMMENT ON COLUMN plugin_sources.host IS
  'PLUGIN-ARCH-2: where the source code runs. worker = TS in-process (default); sidecar = pushed to the python-plugins sidecar /admin/reload.';
