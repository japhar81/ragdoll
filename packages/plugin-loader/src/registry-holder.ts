/**
 * PLUGIN-ARCH-1: registry holder + builder + refresh orchestrator.
 *
 * The holder owns the CURRENT `PluginRegistry` reference. Refresh
 * builds a fresh registry off-line then atomically swaps the holder's
 * pointer. The swap is a single reference assignment so it's atomic
 * by construction in JS — in-flight executions that already
 * destructured `pluginRegistry` from `deps` continue against the old
 * snapshot; new executions read the new one. No mid-execution
 * mutation.
 *
 * The previous load path returned a bare `PluginRegistry`. The holder
 * is a backward-compatible drop-in for callers that just need the
 * registry — for tests + the API refresh endpoint it also exposes
 * the per-source statuses and a `refresh()` entry point.
 */

import {
  PluginRegistry,
  type RegisteredPlugin
} from "../../plugin-sdk/src/index.ts";
import type { PluginCategory, PluginRef } from "../../core/src/index.ts";
import { loadSource, type LoadOpts, type SourceLoadStatus } from "./lifecycle.ts";
import {
  BUILTIN_SOURCES,
  type PluginSource,
  type PluginSourceStore
} from "./sources.ts";

/**
 * What `refresh()` returns — operator-facing summary of the rebuild.
 * The diff is computed by `pluginKey` (category:id:version) so the
 * UI can show "added X, removed Y, updated Z" without a separate
 * server lookup.
 */
export interface RefreshReport {
  /** Per-source status after this refresh. */
  sources: SourceLoadStatus[];
  /** Plugin-key diff between the previous and the newly-built
   *  registry. */
  diff: {
    added: string[];
    removed: string[];
    /** Same plugin key, different source provenance (typically a
     *  new commitSha on an existing repo source). */
    updated: string[];
  };
  /** Total registered plugins in the new registry. */
  pluginCount: number;
}

/**
 * Builds a `PluginRegistry` from a sources iterable.
 *
 * - Built-in sources are merged BEFORE the store's sources so a
 *   registry without any DB rows still contains the in-tree
 *   plugins (the safety net the legacy load relied on).
 * - Sources are processed sequentially so registration order is
 *   deterministic (the legacy `PluginRegistry` is a Map and last-
 *   write-wins; this preserves the historical "built-ins first,
 *   external overrides later" semantics).
 * - Per-source failure is isolated — `loadSource` returns a `failed`
 *   status; we collect it and keep going.
 */
export async function buildPluginRegistry(args: {
  store: PluginSourceStore;
  loadOpts?: LoadOpts;
  /** PLUGIN-ARCH-1: invoked AFTER every source has been walked.
   *  Used by the API + worker startup paths to re-layer the external
   *  PYTHON_PLUGIN_URL plugins on top of every (build / refresh)
   *  pass — those plugins are env-driven, not source-driven, so
   *  they don't belong in the source store but they DO need to be
   *  present in the new registry after a swap. */
  postRegister?: (registry: PluginRegistry) => void | Promise<void>;
}): Promise<{ registry: PluginRegistry; statuses: SourceLoadStatus[] }> {
  const registry = new PluginRegistry();
  const statuses: SourceLoadStatus[] = [];
  const dbSources = await args.store.list({ enabledOnly: false });
  const all: PluginSource[] = [
    ...BUILTIN_SOURCES.map((s) => ({ ...s })),
    ...dbSources
  ];
  for (const source of all) {
    const status = await loadSource(source, registry, args.loadOpts ?? {});
    statuses.push(status);
    // Mark the result on the store ONLY for git sources — the
    // built-in rows aren't in the DB.
    if (source.kind === "git") {
      try {
        await args.store.markLoadResult({
          id: source.id,
          commitSha: status.commitSha ?? null,
          fetchedAt: status.loadedAt,
          ok: status.status === "loaded",
          error: status.error ?? null
        });
      } catch {
        // Marking is a courtesy for the catalog — never fail the
        // load because a follow-up UPDATE failed.
      }
    }
  }
  if (args.postRegister) {
    await args.postRegister(registry);
  }
  return { registry, statuses };
}

/** Drop-in replacement for the legacy `PluginRegistry` exported by
 *  `loadPluginRegistry()`. Methods proxy to the current registry,
 *  which is replaced atomically by `swap()`.
 *
 *  Extends the base class so it satisfies the existing
 *  `PluginRegistry` parameter type at every callsite. The inherited
 *  `plugins` Map is unused; every method override delegates to
 *  `current`. */
export class PluginRegistryHolder extends PluginRegistry {
  private current: PluginRegistry;
  private latestStatuses: SourceLoadStatus[];

  constructor(initial: PluginRegistry, statuses: SourceLoadStatus[]) {
    super();
    this.current = initial;
    this.latestStatuses = statuses;
  }

  override register(plugin: RegisteredPlugin): void {
    this.current.register(plugin);
  }
  override get(ref: PluginRef): RegisteredPlugin | undefined {
    return this.current.get(ref);
  }
  override require(ref: PluginRef): RegisteredPlugin {
    return this.current.require(ref);
  }
  override list(category?: PluginCategory): RegisteredPlugin[] {
    return this.current.list(category);
  }

  /** Read-only handle on the current registry — used by the diff
   *  computation and by tests. */
  snapshot(): PluginRegistry {
    return this.current;
  }

  /** Per-source statuses from the most recent (build or refresh). */
  statuses(): SourceLoadStatus[] {
    return this.latestStatuses.map((s) => ({ ...s }));
  }

  /** Atomic swap. The old registry is left intact for any in-flight
   *  execution that already resolved against it. */
  swap(next: PluginRegistry, statuses: SourceLoadStatus[]): void {
    this.current = next;
    this.latestStatuses = statuses;
  }
}

/**
 * Rebuild the registry from a sources store + atomically swap the
 * holder's pointer. Returns a diff between the old and new registries
 * for the operator to inspect.
 *
 * Per-source isolation: a single failed source surfaces in the
 * returned `sources` array but does NOT abort the refresh — the
 * other sources still load. Same contract `buildPluginRegistry`
 * upholds; this function chains it with the swap + diff.
 */
export async function refreshPluginRegistry(args: {
  holder: PluginRegistryHolder;
  store: PluginSourceStore;
  loadOpts?: LoadOpts;
  postRegister?: (registry: PluginRegistry) => void | Promise<void>;
}): Promise<RefreshReport> {
  const before = snapshotKeys(args.holder.snapshot());
  const { registry, statuses } = await buildPluginRegistry({
    store: args.store,
    loadOpts: args.loadOpts,
    postRegister: args.postRegister
  });
  const after = snapshotKeys(registry);
  args.holder.swap(registry, statuses);
  return {
    sources: statuses,
    pluginCount: after.size,
    diff: computeDiff(before, after)
  };
}

function snapshotKeys(
  registry: PluginRegistry
): Map<string, RegisteredPlugin> {
  const map = new Map<string, RegisteredPlugin>();
  for (const p of registry.list()) {
    map.set(pluginKey(p), p);
  }
  return map;
}

function pluginKey(p: RegisteredPlugin): string {
  return `${p.manifest.category}:${p.manifest.id}:${p.manifest.version}`;
}

function computeDiff(
  before: Map<string, RegisteredPlugin>,
  after: Map<string, RegisteredPlugin>
): RefreshReport["diff"] {
  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];
  for (const [key, plugin] of after) {
    const prior = before.get(key);
    if (!prior) {
      added.push(key);
    } else if (provenanceChanged(prior, plugin)) {
      updated.push(key);
    }
  }
  for (const key of before.keys()) {
    if (!after.has(key)) removed.push(key);
  }
  added.sort();
  removed.sort();
  updated.sort();
  return { added, removed, updated };
}

function provenanceChanged(
  a: RegisteredPlugin,
  b: RegisteredPlugin
): boolean {
  const sa = a.source;
  const sb = b.source;
  if (!sa && !sb) return false;
  if (!sa || !sb) return true;
  return sa.repoId !== sb.repoId || sa.commitSha !== sb.commitSha;
}
