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
/** PLUGIN-ARCH-2: where a source's code runs.
 *  - `worker`  — TS in-process (the PLUGIN-ARCH-1 lifecycle). Default.
 *  - `sidecar` — pushed to the python-plugins sidecar's /admin/reload;
 *                discovered back via /manifests. */
export type PluginSourceHost = "worker" | "sidecar";

export interface PluginSource {
  id: string;
  kind: "local" | "git";
  /** PLUGIN-ARCH-2: which host runs this source's code. Defaults to
   *  `worker` (TS in-process). Built-in/local sources are always
   *  `worker`. */
  host?: PluginSourceHost;
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
  /** PLUGIN-ARCH-1 close-out: when true, the lifecycle's `verify`
   *  stage runs `git verify-commit` against `allowedSigners` and
   *  refuses to load on a bad / missing / untrusted signature.
   *  Opt-in per source so existing rows keep working unchanged. */
  requireSignature?: boolean;
  /** PLUGIN-ARCH-1 close-out: SSH allowed-signers file content.
   *  Opaque text — format is whatever
   *  `gpg.ssh.allowedSignersFile` expects. Used only when
   *  `requireSignature` is true. */
  allowedSigners?: string;
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
/** Input shape for create / update — same shape both consume. */
export interface PluginSourceUpsert {
  id: string;
  gitUrl: string;
  ref?: string;
  subpath?: string;
  displayName?: string;
  description?: string;
  enabled?: boolean;
  host?: PluginSourceHost;
  requireSignature?: boolean;
  allowedSigners?: string;
}

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
  /** PLUGIN-ARCH-1 close-out: CRUD for the admin UI's "Plugin
   *  Sources" screen. The store-level methods are gated by the
   *  `plugin:manage` permission at the route layer (see
   *  `apps/api/src/app/routes/plugins-providers.ts`). */
  create?(source: PluginSourceUpsert): Promise<PluginSource>;
  update?(id: string, patch: Partial<PluginSourceUpsert>): Promise<PluginSource>;
  remove?(id: string): Promise<void>;
  get?(id: string): Promise<PluginSource | undefined>;
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
         id, host, git_url, ref, subpath, display_name, description, enabled,
         require_signature, allowed_signers,
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

  async create(source: PluginSourceUpsert): Promise<PluginSource> {
    await this.pool.query(
      `INSERT INTO plugin_sources
         (id, host, git_url, ref, subpath, display_name, description, enabled,
          require_signature, allowed_signers)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        source.id,
        source.host ?? "worker",
        source.gitUrl,
        source.ref ?? "main",
        source.subpath ?? "",
        source.displayName ?? null,
        source.description ?? null,
        source.enabled ?? true,
        source.requireSignature ?? false,
        source.allowedSigners ?? null
      ]
    );
    const created = await this.get(source.id);
    if (!created) {
      throw new Error(`DbPluginSourceStore.create: row ${source.id} disappeared`);
    }
    return created;
  }

  async update(
    id: string,
    patch: Partial<PluginSourceUpsert>
  ): Promise<PluginSource> {
    // Build a UPDATE only for fields the caller actually sent. Keep
    // the SQL small + the diff visible to anyone reading the row's
    // audit log.
    const sets: string[] = [];
    const args: unknown[] = [id];
    const set = (col: string, val: unknown) => {
      args.push(val);
      sets.push(`${col} = $${args.length}`);
    };
    if (patch.gitUrl !== undefined) set("git_url", patch.gitUrl);
    if (patch.ref !== undefined) set("ref", patch.ref);
    if (patch.subpath !== undefined) set("subpath", patch.subpath);
    if (patch.displayName !== undefined) set("display_name", patch.displayName);
    if (patch.description !== undefined) set("description", patch.description);
    if (patch.enabled !== undefined) set("enabled", patch.enabled);
    if (patch.host !== undefined) set("host", patch.host);
    if (patch.requireSignature !== undefined)
      set("require_signature", patch.requireSignature);
    if (patch.allowedSigners !== undefined)
      set("allowed_signers", patch.allowedSigners);
    if (sets.length === 0) {
      const existing = await this.get(id);
      if (!existing) throw new Error(`plugin_sources row ${id} not found`);
      return existing;
    }
    sets.push("updated_at = now()");
    await this.pool.query(
      `UPDATE plugin_sources SET ${sets.join(", ")} WHERE id = $1`,
      args
    );
    const updated = await this.get(id);
    if (!updated) throw new Error(`plugin_sources row ${id} not found after update`);
    return updated;
  }

  async remove(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM plugin_sources WHERE id = $1`, [id]);
  }

  async get(id: string): Promise<PluginSource | undefined> {
    const result = await this.pool.query<DbRow>(
      `SELECT
         id, host, git_url, ref, subpath, display_name, description, enabled,
         require_signature, allowed_signers,
         last_commit_sha, last_fetched_at, last_load_ok, last_load_error
       FROM plugin_sources WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? rowToSource(result.rows[0]) : undefined;
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
  async create(source: PluginSourceUpsert): Promise<PluginSource> {
    if (this.sources.some((s) => s.id === source.id)) {
      throw new Error(`plugin source ${source.id} already exists`);
    }
    const row: PluginSource = {
      id: source.id,
      kind: "git",
      host: source.host ?? "worker",
      enabled: source.enabled ?? true,
      gitUrl: source.gitUrl,
      ref: source.ref ?? "main",
      subpath: source.subpath,
      displayName: source.displayName,
      description: source.description,
      requireSignature: source.requireSignature ?? false,
      allowedSigners: source.allowedSigners
    };
    this.sources.push(row);
    return { ...row };
  }
  async update(
    id: string,
    patch: Partial<PluginSourceUpsert>
  ): Promise<PluginSource> {
    const row = this.sources.find((s) => s.id === id);
    if (!row) throw new Error(`plugin source ${id} not found`);
    if (patch.gitUrl !== undefined) row.gitUrl = patch.gitUrl;
    if (patch.ref !== undefined) row.ref = patch.ref;
    if (patch.subpath !== undefined) row.subpath = patch.subpath || undefined;
    if (patch.displayName !== undefined) row.displayName = patch.displayName;
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    if (patch.host !== undefined) row.host = patch.host;
    if (patch.requireSignature !== undefined)
      row.requireSignature = patch.requireSignature;
    if (patch.allowedSigners !== undefined) row.allowedSigners = patch.allowedSigners;
    return { ...row };
  }
  async remove(id: string): Promise<void> {
    this.sources = this.sources.filter((s) => s.id !== id);
  }
  async get(id: string): Promise<PluginSource | undefined> {
    const row = this.sources.find((s) => s.id === id);
    return row ? { ...row } : undefined;
  }
}

interface DbRow {
  id: string;
  host: string | null;
  git_url: string;
  ref: string;
  subpath: string;
  display_name: string | null;
  description: string | null;
  enabled: boolean;
  require_signature: boolean | null;
  allowed_signers: string | null;
  last_commit_sha: string | null;
  last_fetched_at: string | null;
  last_load_ok: boolean | null;
  last_load_error: string | null;
}

function rowToSource(row: DbRow): PluginSource {
  return {
    id: row.id,
    kind: "git",
    host: (row.host === "sidecar" ? "sidecar" : "worker"),
    displayName: row.display_name ?? undefined,
    description: row.description ?? undefined,
    enabled: row.enabled,
    gitUrl: row.git_url,
    ref: row.ref,
    subpath: row.subpath || undefined,
    requireSignature: row.require_signature ?? false,
    allowedSigners: row.allowed_signers ?? undefined,
    lastCommitSha: row.last_commit_sha ?? undefined,
    lastFetchedAt: row.last_fetched_at ?? undefined,
    lastLoadOk: row.last_load_ok ?? undefined,
    lastLoadError: row.last_load_error ?? undefined
  };
}
