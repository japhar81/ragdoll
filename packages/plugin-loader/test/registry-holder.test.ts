/**
 * PLUGIN-ARCH-1: holder + refresh orchestration.
 *
 * These tests pin the architectural contract refresh promises:
 *
 *   - holder.swap() is atomic-by-construction in JS: a captured
 *     pre-swap reference still resolves against the old registry,
 *     while a fresh `.list()` call against the SAME holder sees
 *     the new one
 *   - per-source failures NEVER crash a refresh — they surface in
 *     the per-source statuses, the rest load
 *   - the diff (added/removed/updated by `category:id:version` key)
 *     accurately reflects two consecutive registry builds
 *   - the `postRegister` hook fires AFTER every build so the
 *     PYTHON_PLUGIN_URL plugins survive a refresh
 *   - unchanged-sha re-fetches are no-ops (cache hit)
 *   - the holder also satisfies the legacy `PluginRegistry` contract
 *     (extends + delegates) so callers don't have to type-cast
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PluginRegistryHolder,
  buildPluginRegistry,
  refreshPluginRegistry,
  InMemoryPluginSourceStore,
  __clearPluginCacheForTests,
  type PluginSource
} from "../src/index.ts";
import { PluginRegistry } from "../../plugin-sdk/src/index.ts";

function makeStubPlugin(id: string, version = "1.0.0"): unknown {
  return {
    manifest: {
      id,
      name: `Stub ${id}`,
      version,
      category: "datasource",
      description: "test"
    },
    execute: async () => ({ outputs: {} })
  };
}

const fixedSha = (n: string): string => n.repeat(40);

function importerFor(modules: Record<string, Record<string, unknown>>): (s: string) => Promise<Record<string, unknown>> {
  return async (specifier: string) => {
    if (!(specifier in modules)) throw new Error(`no module for ${specifier}`);
    return modules[specifier];
  };
}

const gitSrc = (id: string, ref: string, plugins: string[]): {
  source: PluginSource;
  modules: Record<string, Record<string, unknown>>;
} => {
  const exports: Record<string, unknown> = {};
  for (const p of plugins) exports[p] = makeStubPlugin(p);
  return {
    source: {
      id,
      kind: "git",
      enabled: true,
      gitUrl: `https://example.invalid/${id}.git`,
      ref
    },
    modules: { [`__memory__/${id}/${ref}/`]: exports }
  };
};

// ---------------------------------------------------------------------------
// build (the underlying primitive refresh layers on)
// ---------------------------------------------------------------------------

test("buildPluginRegistry: built-in sources are loaded BEFORE store sources (order-deterministic registration)", async () => {
  __clearPluginCacheForTests();
  // Empty store so only the built-ins load. We override resolveBuiltinPath
  // to point at our fake modules.
  const store = new InMemoryPluginSourceStore([]);
  const { statuses } = await buildPluginRegistry({
    store,
    loadOpts: {
      importFn: importerFor({
        "__memory__/builtin/local/": { p: makeStubPlugin("builtin_plug") },
        "__memory__/sample-text/local/": { p: makeStubPlugin("sample_plug") }
      }),
      resolveBuiltinPath: (s) => `__memory__/${s.id}/local/`
    }
  });
  // Built-ins come first, in `BUILTIN_SOURCES` order.
  assert.equal(statuses[0].id, "builtin");
  assert.equal(statuses[1].id, "sample-text");
});

test("buildPluginRegistry: per-source failures do NOT abort other sources", async () => {
  __clearPluginCacheForTests();
  const goodSha = fixedSha("a");
  const { source: good, modules } = gitSrc("ext-good", goodSha, ["good_plug"]);
  const bad: PluginSource = {
    id: "ext-bad",
    kind: "git",
    enabled: true,
    gitUrl: undefined, // missing url → verify-stage failure
    ref: fixedSha("b")
  };
  const store = new InMemoryPluginSourceStore([good, bad]);
  const { registry, statuses } = await buildPluginRegistry({
    store,
    loadOpts: {
      skipFetch: true,
      importFn: importerFor({
        ...modules,
        "__memory__/builtin/local/": {},
        "__memory__/sample-text/local/": {}
      }),
      resolveBuiltinPath: (s) => `__memory__/${s.id}/local/`
    }
  });
  const byId = Object.fromEntries(statuses.map((s) => [s.id, s]));
  assert.equal(byId["ext-good"].status, "loaded");
  assert.equal(byId["ext-good"].pluginCount, 1);
  assert.equal(byId["ext-bad"].status, "failed");
  assert.equal(byId["ext-bad"].errorStage, "verify");
  // The good source's plugin made it into the registry despite the
  // bad source failing.
  assert.ok(
    registry.get({ category: "datasource", id: "good_plug", version: "1.0.0" })
  );
});

test("buildPluginRegistry: `postRegister` fires AFTER source iteration", async () => {
  __clearPluginCacheForTests();
  const order: string[] = [];
  const store = new InMemoryPluginSourceStore([]);
  await buildPluginRegistry({
    store,
    postRegister: (r) => {
      order.push("postRegister");
      r.register({
        mode: "in_process",
        manifest: {
          id: "post_plug",
          name: "Post",
          version: "1.0.0",
          category: "datasource",
          description: "post-register"
        },
        implementation: makeStubPlugin("post_plug") as never
      });
    },
    loadOpts: {
      resolveBuiltinPath: (s) => `__memory__/${s.id}/local/`,
      importFn: async (s) => {
        order.push(`import:${s}`);
        return {};
      }
    }
  });
  // postRegister runs last — after every source has been walked.
  const post = order.lastIndexOf("postRegister");
  const lastImport = Math.max(...order.map((s, i) => (s.startsWith("import:") ? i : -1)));
  assert.ok(post > lastImport, "postRegister must run after all source imports");
});

test("buildPluginRegistry: store.markLoadResult IS called for git sources, NOT for local built-ins", async () => {
  __clearPluginCacheForTests();
  const sha = fixedSha("c");
  const { source: ext, modules } = gitSrc("ext-marked", sha, ["m_plug"]);
  const store = new InMemoryPluginSourceStore([ext]);
  const seen: string[] = [];
  const wrapped = {
    list: store.list.bind(store),
    markLoadResult: async (args: { id: string }) => {
      seen.push(args.id);
      return store.markLoadResult(args as never);
    }
  };
  await buildPluginRegistry({
    store: wrapped,
    loadOpts: {
      skipFetch: true,
      importFn: importerFor({
        ...modules,
        "__memory__/builtin/local/": {},
        "__memory__/sample-text/local/": {}
      }),
      resolveBuiltinPath: (s) => `__memory__/${s.id}/local/`
    }
  });
  // Only the git source was marked — built-ins never go through
  // markLoadResult (they aren't in the DB).
  assert.deepEqual(seen, ["ext-marked"]);
});

// ---------------------------------------------------------------------------
// holder swap atomicity
// ---------------------------------------------------------------------------

test("PluginRegistryHolder.swap(): a pre-swap snapshot reference still resolves against the OLD registry", () => {
  const r1 = new PluginRegistry();
  r1.register({
    mode: "in_process",
    manifest: {
      id: "old",
      name: "Old",
      version: "1.0.0",
      category: "datasource",
      description: ""
    }
  });
  const holder = new PluginRegistryHolder(r1, []);
  // Capture a snapshot — this is what an in-flight execution would
  // hold after destructuring `pluginRegistry` from `deps`.
  const preSwapSnapshot = holder.snapshot();
  const r2 = new PluginRegistry();
  r2.register({
    mode: "in_process",
    manifest: {
      id: "new",
      name: "New",
      version: "1.0.0",
      category: "datasource",
      description: ""
    }
  });
  holder.swap(r2, []);
  // Captured snapshot still sees the old plugin set.
  assert.equal(preSwapSnapshot.list().length, 1);
  assert.equal(preSwapSnapshot.list()[0].manifest.id, "old");
  // A fresh `list()` call against the SAME holder reads the new set.
  assert.equal(holder.list().length, 1);
  assert.equal(holder.list()[0].manifest.id, "new");
});

test("PluginRegistryHolder: extends PluginRegistry so legacy `PluginRegistry`-typed callers work unchanged", () => {
  const r = new PluginRegistry();
  const holder = new PluginRegistryHolder(r, []);
  // Type-system contract: assigning to a PluginRegistry-typed slot
  // must compile. (Runtime check just confirms the prototype chain.)
  const slot: PluginRegistry = holder;
  assert.ok(slot instanceof PluginRegistry);
  // Method delegation works for register/get/list/require.
  slot.register({
    mode: "in_process",
    manifest: {
      id: "delegate",
      name: "Delegate",
      version: "1.0.0",
      category: "datasource",
      description: ""
    }
  });
  assert.ok(
    slot.get({ category: "datasource", id: "delegate", version: "1.0.0" })
  );
});

// ---------------------------------------------------------------------------
// refresh: diff computation + per-source isolation
// ---------------------------------------------------------------------------

test("refreshPluginRegistry: diff reports added / removed / updated by category:id:version", async () => {
  __clearPluginCacheForTests();
  // Round 1: ext-a contributes `plug_a`.
  const r1 = gitSrc("ext-a", fixedSha("1"), ["plug_a"]);
  const store = new InMemoryPluginSourceStore([r1.source]);
  const importer1 = importerFor({
    ...r1.modules,
    "__memory__/builtin/local/": {},
    "__memory__/sample-text/local/": {}
  });
  const { registry: initial, statuses: initialStatuses } = await buildPluginRegistry({
    store,
    loadOpts: {
      skipFetch: true,
      importFn: importer1,
      resolveBuiltinPath: (s) => `__memory__/${s.id}/local/`
    }
  });
  const holder = new PluginRegistryHolder(initial, initialStatuses);

  // Round 2: ext-a is gone, ext-b shows up with `plug_b`. Same store
  // mutated to swap the source list.
  const r2 = gitSrc("ext-b", fixedSha("2"), ["plug_b"]);
  store.setSources([r2.source]);
  __clearPluginCacheForTests();
  const report = await refreshPluginRegistry({
    holder,
    store,
    loadOpts: {
      skipFetch: true,
      importFn: importerFor({
        ...r2.modules,
        "__memory__/builtin/local/": {},
        "__memory__/sample-text/local/": {}
      }),
      resolveBuiltinPath: (s) => `__memory__/${s.id}/local/`
    }
  });
  assert.deepEqual(report.diff.added, ["datasource:plug_b:1.0.0"]);
  assert.deepEqual(report.diff.removed, ["datasource:plug_a:1.0.0"]);
  assert.deepEqual(report.diff.updated, []);
  assert.equal(report.pluginCount, 1);
});

test("refreshPluginRegistry: unchanged-sha second pass is a no-op (cache hit) — same plugins, no diff", async () => {
  __clearPluginCacheForTests();
  const sha = fixedSha("4");
  const r = gitSrc("ext-cached", sha, ["nochange_plug"]);
  const store = new InMemoryPluginSourceStore([r.source]);
  let imports = 0;
  const importer = async (specifier: string) => {
    imports += 1;
    if (specifier in r.modules) return r.modules[specifier];
    return {};
  };
  const { registry: initial, statuses } = await buildPluginRegistry({
    store,
    loadOpts: {
      skipFetch: true,
      importFn: importer,
      resolveBuiltinPath: (s) => `__memory__/${s.id}/local/`
    }
  });
  const holder = new PluginRegistryHolder(initial, statuses);
  const beforeImports = imports;
  const report = await refreshPluginRegistry({
    holder,
    store,
    loadOpts: {
      skipFetch: true,
      importFn: importer,
      resolveBuiltinPath: (s) => `__memory__/${s.id}/local/`
    }
  });
  // The cached source was a true no-op: no extra import for ext-cached.
  // (Built-ins re-import because resolveBuiltinPath returns a path
  // without a sha; their modules ARE re-imported, but the call count
  // for `ext-cached` specifically didn't go up.)
  const cachedAfter = imports - beforeImports;
  assert.ok(cachedAfter < 2, "git source with unchanged sha must hit cache");
  assert.deepEqual(report.diff.added, []);
  assert.deepEqual(report.diff.removed, []);
  // Updated MAY be non-empty for built-ins (no commitSha to compare),
  // but the load-bearing assertion is that the git source held steady.
});

test("refreshPluginRegistry: a source that fails ONLY surfaces as `failed` in `sources` — refresh succeeds", async () => {
  __clearPluginCacheForTests();
  const good = gitSrc("ext-good", fixedSha("5"), ["g_plug"]);
  const bad: PluginSource = {
    id: "ext-bad",
    kind: "git",
    enabled: true,
    gitUrl: undefined,
    ref: fixedSha("6")
  };
  const store = new InMemoryPluginSourceStore([good.source, bad]);
  const { registry, statuses } = await buildPluginRegistry({
    store,
    loadOpts: {
      skipFetch: true,
      importFn: importerFor({
        ...good.modules,
        "__memory__/builtin/local/": {},
        "__memory__/sample-text/local/": {}
      }),
      resolveBuiltinPath: (s) => `__memory__/${s.id}/local/`
    }
  });
  const holder = new PluginRegistryHolder(registry, statuses);
  __clearPluginCacheForTests();
  const report = await refreshPluginRegistry({
    holder,
    store,
    loadOpts: {
      skipFetch: true,
      importFn: importerFor({
        ...good.modules,
        "__memory__/builtin/local/": {},
        "__memory__/sample-text/local/": {}
      }),
      resolveBuiltinPath: (s) => `__memory__/${s.id}/local/`
    }
  });
  const byId = Object.fromEntries(report.sources.map((s) => [s.id, s]));
  assert.equal(byId["ext-good"].status, "loaded");
  assert.equal(byId["ext-bad"].status, "failed");
  // The good source's plugin survives in the new registry.
  assert.ok(
    holder.get({ category: "datasource", id: "g_plug", version: "1.0.0" })
  );
});
