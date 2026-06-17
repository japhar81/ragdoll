/**
 * PLUGIN-ARCH-1: plugin source types + persistence.
 *
 * A "plugin source" is anywhere RAGdoll's loader can find plugin code:
 *
 *   - `local` — code shipped with the worker image (the in-tree
 *               `plugins/builtin-rag` + `plugins/sample-text` modules).
 *               No fetch step; the import target is a fixed in-image
 *               path.
 *   - `git`   — code in an external (internal/trusted) repo. The
 *               loader clones at a pinned commit, dynamic-imports the
 *               TS modules, and scans the same duck-types the local
 *               path uses.
 *
 * Trust policy is deliberately deferred — the seam (provenance +
 * per-source status) lives in this file; signing/allowlist/sandbox
 * is a future tier that attaches to it.
 */

import type { PoolLike } from "../../db/src/pool.ts";

/** Logical id reserved for the in-tree built-in modules.
 *
 *  Plugins from `plugins/builtin-rag` use this id (not "builtin-rag",
 *  because that's an npm-package name shape — the source id needs to
 *  be stable across renames of the package). */
export const BUILTIN_SOURCE_ID = "builtin";

/** Logical id reserved for the in-tree `sample-text` plugin module —
 *  kept distinct so the catalog can hide samples in production
 *  deployments via a separate enable knob in the future. */
export const SAMPLE_TEXT_SOURCE_ID = "sample-text";

/** PLUGIN-ARCH-1 source descriptor — what the loader iterates. */
export interface PluginSource {
  id: string;
  kind: "local" | "git";
  /** Operator-facing label; defaults to `id` when absent. */
  displayName?: string;
  description?: string;
  /** Enabled rows are loaded by startup + refresh; disabled rows are
   *  skipped (kept for history). */
  enabled: boolean;
  /** Required for `kind: git`; absent for `local`. */
  gitUrl?: string;
  /** Required for `kind: git` — branch / tag / commit-ish. Resolved
   *  to a sha at fetch. Defaults to `main` when absent on a git row. */
  ref?: string;
  /** Subpath inside the repo to scan; empty string = repo root. */
  subpath?: string;
  /** Last-known-good fetch state. NULL for sources that haven't
   *  loaded yet. */
  lastCommitSha?: string;
  lastFetchedAt?: string;
  lastLoadOk?: boolean;
  lastLoadError?: string;
}

/**
 * Persistence boundary. Implementations: `DbPluginSourceStore` reads
 * the `plugin_sources` table; `InMemoryPluginSourceStore` is used by
 * the test harness so the loader's lifecycle can be exercised without
 * spinning up Postgres.
 */
export interface PluginSourceStore {
  /** List every source row that the loader should iterate (`enabled`
   *  filter is the caller's choice — the loader filters to
   *  `enabled = true` but the admin catalog wants everything). */
  list(opts?: { enabledOnly?: boolean }): Promise<PluginSource[]>;
  /** Update the last-known-good state after a fetch / load attempt.
   *  Called by `refreshPluginRegistry` per-source so the operator sees
   *  the current commit + load outcome on the catalog. */
  markLoadResult(args: {
    id: string;
    commitSha?: string | null;
    fetchedAt: string;
    ok: boolean;
    error?: string | null;
  }): Promise<void>;
}

/** Always-on virtual sources for the in-tree built-in modules.
 *
 *  These are returned by every store implementation so the loader's
 *  iteration produces the SAME plugin set the legacy hardcoded
 *  `PLUGIN_MODULES` array did. Without them, an empty DB would load
 *  zero plugins on startup — the regression we explicitly forbid.
 *  Kept in code (not in the DB) because:
 *
 *    - They map to fixed in-tree paths; there's nothing for an
 *      operator to edit.
 *    - A bad DB / a fresh install must still produce a working
 *      registry. The built-ins are the safety net.
 *
 *  External (`git`) sources are layered ON TOP of these via the DB
 *  store. */
export const BUILTIN_SOURCES: readonly PluginSource[] = Object.freeze([
  {
    id: BUILTIN_SOURCE_ID,
    kind: "local",
    displayName: "Built-in plugins",
    description:
      "First-party plugin modules shipped with RAGdoll — the wazuh / k8s / cartography / cloudquery / dgraph / opensearch / qdrant / etc. families. Loaded from the in-tree plugins/builtin-rag namespace; not editable, never fails.",
    enabled: true,
    subpath: "plugins/builtin-rag"
  },
  {
    id: SAMPLE_TEXT_SOURCE_ID,
    kind: "local",
    displayName: "Sample text plugins",
    description:
      "Built-in sample plugins used by the demo pipelines. Loaded from plugins/sample-text.",
    enabled: true,
    subpath: "plugins/sample-text"
  }
] as PluginSource[]);

/** DB-backed source store — reads `plugin_sources` rows. */
export class DbPluginSourceStore implements PluginSourceStore {
  private readonly pool: PoolLike;
  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async list(opts: { enabledOnly?: boolean } = {}): Promise<PluginSource[]> {
    const where = opts.enabledOnly ? "WHERE enabled = TRUE" : "";
    const result = await this.pool.query<DbRow>(
      `SELECT
         id, git_url, ref, subpath, display_name, description, enabled,
         last_commit_sha, last_fetched_at, last_load_ok, last_load_error
       FROM plugin_sources
       ${where}
       ORDER BY id ASC`
    );
    return result.rows.map(rowToSource);
  }

  async markLoadResult(args: {
    id: string;
    commitSha?: string | null;
    fetchedAt: string;
    ok: boolean;
    error?: string | null;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE plugin_sources
         SET last_commit_sha = COALESCE($2, last_commit_sha),
             last_fetched_at = $3::timestamptz,
             last_load_ok    = $4,
             last_load_error = $5,
             updated_at      = now()
       WHERE id = $1`,
      [args.id, args.commitSha ?? null, args.fetchedAt, args.ok, args.error ?? null]
    );
  }
}

/** Test-only in-memory store. Pre-seeded by tests with a fixed list. */
export class InMemoryPluginSourceStore implements PluginSourceStore {
  private sources: PluginSource[];
  constructor(sources: PluginSource[] = []) {
    this.sources = sources;
  }
  async list(opts: { enabledOnly?: boolean } = {}): Promise<PluginSource[]> {
    const all = this.sources.map((s) => ({ ...s }));
    return opts.enabledOnly ? all.filter((s) => s.enabled) : all;
  }
  async markLoadResult(args: {
    id: string;
    commitSha?: string | null;
    fetchedAt: string;
    ok: boolean;
    error?: string | null;
  }): Promise<void> {
    const row = this.sources.find((s) => s.id === args.id);
    if (!row) return;
    if (args.commitSha) row.lastCommitSha = args.commitSha;
    row.lastFetchedAt = args.fetchedAt;
    row.lastLoadOk = args.ok;
    row.lastLoadError = args.error ?? undefined;
  }
  setSources(next: PluginSource[]): void {
    this.sources = next;
  }
}

interface DbRow {
  id: string;
  git_url: string;
  ref: string;
  subpath: string;
  display_name: string | null;
  description: string | null;
  enabled: boolean;
  last_commit_sha: string | null;
  last_fetched_at: string | null;
  last_load_ok: boolean | null;
  last_load_error: string | null;
}

function rowToSource(row: DbRow): PluginSource {
  return {
    id: row.id,
    kind: "git",
    displayName: row.display_name ?? undefined,
    description: row.description ?? undefined,
    enabled: row.enabled,
    gitUrl: row.git_url,
    ref: row.ref,
    subpath: row.subpath || undefined,
    lastCommitSha: row.last_commit_sha ?? undefined,
    lastFetchedAt: row.last_fetched_at ?? undefined,
    lastLoadOk: row.last_load_ok ?? undefined,
    lastLoadError: row.last_load_error ?? undefined
  };
}
