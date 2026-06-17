-- 023_plugin_sources.sql
--
-- PLUGIN-ARCH-1: Repo-source registry.
--
-- The runtime previously loaded plugins exclusively from a hardcoded
-- `PLUGIN_MODULES` array in packages/plugin-loader/src/index.ts —
-- adding a new plugin meant a code change + deploy. This table makes
-- the source list editable at runtime: each row names a git repo,
-- a ref (branch/tag/commit), a subpath inside that repo, and an
-- enable flag. The loader's startup pass + the admin refresh
-- endpoint iterate THIS list and dynamically import each source's TS
-- modules, scanning the same `isInProcessPlugin` / connection-driver
-- duck-types the static path used.
--
-- The first-party / built-in plugins (plugins/builtin-rag,
-- plugins/sample-text) load as a `local` source descriptor handled
-- entirely in code — they have no row in this table and never go
-- through a git fetch. New built-in modules added to the repo
-- still appear automatically; this table is exclusively for
-- EXTERNAL (internal/trusted) repo-hosted plugins.
--
-- Provenance: plugins loaded from a row here get
-- `RegisteredPlugin.source = { repoId, gitUrl, ref, commitSha,
-- subpath }` so /api/plugins can tell the operator where each
-- plugin came from + which commit is live. Trust policy
-- (signing/allowlist/sandbox) is deliberately NOT enforced here —
-- the seam (provenance + per-source status) is what a future
-- trust tier attaches to.
--
-- Cardinality: tiny (single-digit rows in practice — one per
-- vendor/team that ships plugins into this RAGdoll). No tenant
-- scoping yet — plugin sources are GLOBAL, matching the
-- pluginRegistry's process-wide scope. Tenant-scoped sources are a
-- follow-on if/when the trust policy lands.

CREATE TABLE IF NOT EXISTS plugin_sources (
  -- Logical id used by operators (e.g. "bulwark-plugins"). Stable
  -- across refresh — provenance on emitted plugins references this id.
  id              text PRIMARY KEY,
  -- Git URL the loader clones. https:// or ssh:// — the runtime shells
  -- out to `git`; auth is whatever the host machine / sidecar has
  -- configured (SSH agent, git credential helper, etc.). Internal
  -- mirror URLs are the expected shape.
  git_url         text NOT NULL,
  -- Branch / tag / commit. Resolved → sha at fetch time so the cache
  -- path is content-addressed (a new commit = a new path = a fresh
  -- ESM module URL = no stale-cache hacks).
  ref             text NOT NULL DEFAULT 'main',
  -- Subpath inside the repo where the loader scans for plugin
  -- exports. Empty string ('' / NULL coalesced) = repo root.
  subpath         text NOT NULL DEFAULT '',
  -- Human-facing label for the admin UI; defaults to the id.
  display_name    text,
  description     text,
  -- Disabled rows are kept (history) but skipped by the loader. The
  -- existing plugins remain registered from whatever the last enabled
  -- refresh produced; bulk-disabling a vendor doesn't crater the
  -- pipeline catalog until the next refresh proves it's intentional.
  enabled         boolean NOT NULL DEFAULT true,
  -- Last-known-good fetch state — surfaced on /api/plugins for the
  -- operator to see where each source is. NULL until first refresh.
  last_commit_sha text,
  last_fetched_at timestamp with time zone,
  last_load_ok    boolean,
  last_load_error text,
  created_at      timestamp with time zone NOT NULL DEFAULT now(),
  updated_at      timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plugin_sources_enabled_idx
  ON plugin_sources (enabled);

COMMENT ON TABLE plugin_sources IS
  'PLUGIN-ARCH-1: external repo-hosted plugin sources. Built-in plugins/* load via an in-code local source descriptor — they do NOT appear here.';
