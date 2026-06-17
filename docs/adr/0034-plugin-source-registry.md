# ADR 0034: PLUGIN-ARCH-1 — Repo-source plugin registry + runtime refresh

## Status

**Accepted + implemented.** The hardcoded `PLUGIN_MODULES` array in
`packages/plugin-loader/src/index.ts` is replaced by a first-class
`PluginSourceStore` (DB-backed for production, in-memory for tests);
plugins load from a per-source lifecycle (fetch → import → scan →
register with provenance), and a `PluginRegistryHolder` lets an
admin `POST /api/plugins/refresh` rebuild + atomically swap the
registry without a worker restart.

Companions:
- [ADR 0022 — Connect-RPC plugin transport](./0022-connect-rpc-plugin-transport.md)
- [ADR 0024 — Connection drivers as plugins](./0024-connection-drivers-as-plugins.md)
- [ADR 0025 — Neo4j driver + cartography in the python sidecar](./0025-neo4j-driver.md)

## Context

Plugins arrived in RAGdoll via static imports — every new plugin
meant a code change, a build, and a deploy. The duck-type contract
(`{manifest:{id,...}, execute:fn}` / `defineConnectionDriverPlugin`)
was already abstract enough to make repo-driven loading possible;
only the hardcoded source list was holding us back. The user-facing
goal: external (internal/trusted) repos host their own integrations
in their own repos and `POST /api/plugins/refresh` makes them
appear, no restart.

The hard part is NOT the contract (unchanged) or the loading
(`import()` works on `.ts` natively under `--experimental-strip-types`).
The hard part is **refresh correctness**: ES modules are cached by
URL, so importing the same path twice returns the cached instance.
A naïve refresh after a repo update would see stale code.

## Decisions

### 1. Source list = first-class abstraction

A `PluginSourceStore` interface owns the `(id, gitUrl, ref, subpath,
enabled)` list. Implementations:

- `DbPluginSourceStore` — reads/writes the `plugin_sources` table
  (migration `023_plugin_sources.sql`). Production path.
- `InMemoryPluginSourceStore` — pre-seeded list. Test + dev path.

Built-in `plugins/builtin-rag` and `plugins/sample-text` modules are
NOT in the DB. They live as in-code `BUILTIN_SOURCES` descriptors
with `kind: "local"` so a fresh install with an empty DB still loads
the in-tree plugin set. The legacy `PLUGIN_MODULES` array semantics
are preserved without the legacy code path. External (`git`)
sources layer on top of these via the store.

### 2. Per-source lifecycle (the unchanged contract, generalised)

`loadSource(source, registry, opts)` walks one source through:

1. **Resolve** ref → sha (git only). `git ls-remote` is cheap — done
   BEFORE any clone, so an already-fetched sha skips the clone
   entirely.
2. **Fetch** to `<cacheDir>/<repoId>/<sha>/`. Content-addressed by
   sha — different commits land in different paths.
3. **Import** the entry module via dynamic `import()`. For git
   sources, the import URL is the working-copy + subpath. For local
   sources, the in-tree module path (resolved relative to the
   loader file).
4. **Scan + register** using the EXISTING `isInProcessPlugin` /
   `isConnectionDriverPlugin` duck-types (the contract is unchanged
   — only how we *find* plugins is different). Every emitted
   `RegisteredPlugin` carries `source: PluginSourceProvenance` so
   the catalog can show repo + commit per plugin.

Per-source failure is isolated: any throw at any stage produces a
`failed` status with the stage and message; the loader proceeds to
the next source. The pre-existing "skip non-matching exports"
behaviour extends naturally to "skip a whole source that doesn't
load."

### 3. ESM cache correctness — content-addressed paths

Node caches modules by URL: `import("/cache/repo/sha1/index.ts")`
and `import("/cache/repo/sha2/index.ts")` are distinct cache
entries. A new commit produces a new path, which produces fresh
code, with NO cache-busting hacks — the cache IS the contract.

The lifecycle layer also keeps its own `(repoId, sha) →
RegisteredPlugin[]` cache so an unchanged-sha refresh is a true
no-op: same plugins re-registered from cache, no re-import. The
diff reports zero changes.

### 4. Atomic swap — `PluginRegistryHolder`

The holder owns a `current: PluginRegistry` reference and proxies
every method (`register` / `get` / `require` / `list`) to it.
Refresh builds a fresh registry off-line, then a single reference
assignment (`this.current = next`) swaps the pointer. In-flight
executions hold the OLD registry snapshot (they already destructured
`deps.pluginRegistry` and resolved their plugin); new executions
read the post-swap registry. JavaScript's single-threaded execution
guarantees there's no torn read.

The holder `extends PluginRegistry` so every legacy callsite that
types `PluginRegistry` accepts it without modification. The
inherited `plugins` map is unused — every method is overridden to
delegate to `current`.

Atomicity test (`PluginRegistryHolder.swap()`): a pre-swap
`.snapshot()` reference still resolves against the old registry
AFTER the swap; a fresh `.list()` on the same holder sees the new
one. This is the architectural invariant — broken, in-flight
executions race with the swap.

### 5. `postRegister` hook — external-plugin survival

`PYTHON_PLUGIN_URL` plugins (crawl4ai / scrapy / cartography /
cloudquery_aws_sync) are an env-driven runtime capability of the
sidecar, NOT a source. They don't belong in the source store, but
they DO need to be present in EVERY freshly-built registry. The
`postRegister` hook fires after every source has been walked —
the API + worker startup paths use it to re-layer the external
plugins on top of every build / refresh pass. Without this, a
refresh would silently drop the sidecar plugins.

### 6. Provenance seam — trust is deferred

Every `RegisteredPlugin` carries an optional
`source: PluginSourceProvenance`:

```typescript
{
  repoId: string;
  kind: "local" | "git";
  gitUrl?: string;
  ref?: string;
  commitSha?: string;
  subpath?: string;
  loadedAt?: string;
}
```

The catalog (`GET /api/plugins`) surfaces it on every plugin so the
operator sees "this plugin came from `<repoId>` @ `<commitSha>`."
A future trust tier (signing / allowlist / sandbox) attaches to
this field without re-architecting registration — the seam is
ready, the policy is not built.

### 7. API surface

- `GET /api/plugins` — projects every registered plugin onto the
  Builder's wire shape, NOW WITH the `source` provenance field.
- `GET /api/plugins/sources` (`execution:view_logs`) — enumerates
  built-in + DB sources with per-source status, last commit sha,
  last fetch time, error + stage.
- `POST /api/plugins/refresh` (`plugin:manage`) — rebuilds + swaps
  + returns `{sources, diff:{added, removed, updated}, pluginCount}`.

The deps blob gains optional `pluginRegistryHolder` +
`pluginSourceStore` so legacy harnesses that don't wire them get a
graceful 503 from `/refresh` (instead of a crash).

## Verification

`packages/plugin-loader/test/lifecycle.test.ts` (8 cases) +
`packages/plugin-loader/test/registry-holder.test.ts` (10 cases):

- duck-typed scan registers `{manifest, execute}` exports, skips
  non-matching values + bad manifests
- provenance stamped on every emitted `RegisteredPlugin`
  (`repoId` + `kind` + `commitSha` for git, no `commitSha` for
  local)
- 40-char sha as `ref` short-circuits `git ls-remote` (the
  hot-path no-fetch behaviour)
- disabled source → `skipped`, importer never called
- missing `gitUrl` → `failed:verify`, registry stays clean
- importer throws → `failed:import`, no partial registration
- module exports zero plugins → `loaded` with `pluginCount: 0`
- same (repoId, sha) → cache hit, no re-import
- new sha → cache bypass, fresh import
- `buildPluginRegistry`: built-ins first (deterministic order),
  per-source failure isolation, `postRegister` fires after every
  source, `markLoadResult` called for git not local sources
- `PluginRegistryHolder.swap()`: pre-swap snapshot still resolves
  to the old registry AFTER the swap (the load-bearing atomicity
  test)
- `PluginRegistryHolder` extends `PluginRegistry` so legacy
  callsites work unchanged
- `refreshPluginRegistry`: diff (added/removed/updated by
  `category:id:version`); unchanged-sha refresh = no-op; failed
  source surfaces in `sources` but refresh succeeds

`apps/api/test/plugins-providers.test.ts` (4 new cases):

- `GET /api/plugins/sources` returns the holder's per-source
  statuses (empty store → empty array)
- `POST /api/plugins/refresh` rebuilds + returns the diff envelope
  (fake_echo from the old registry surfaces in `removed` —
  confirms the swap is real)
- `POST /api/plugins/refresh` requires `plugin:manage` (viewer
  rejected)
- `GET /api/plugins` surfaces `source` provenance on every plugin
  after a refresh

342 core + 224 functional + 371 plugin tests pass; `tsc --noEmit`
exit 0.

## Consequences

- Adding a plugin is a DB-row insert + `POST /api/plugins/refresh`.
  No worker restart. No code change. No deploy.
- Built-in plugins still ship in the worker image as before; the
  catalog rows for them aren't editable (they're in code).
- Every plugin in the catalog carries provenance — the operator
  sees where each one came from and which commit is live.
- The refresh swap is atomic by construction — in-flight executions
  finish against the snapshot they already resolved.
- A bad repo is loud (status `failed` with stage + error) but
  non-fatal — the OTHER sources still load. No more "one
  bad plugin took down the whole catalog."
- The trust policy seam is `RegisteredPlugin.source`; the policy
  itself is deferred.

## Out of scope (PLUGIN-ARCH-2 follow-ons)

- **The trust policy**: signing, allowlist, sandboxing. Provenance
  is recorded; what to DO with it is the next ADR.
- **Tenant-scoped sources**: today's `plugin_sources` table is
  global (matches the registry's process scope). Tenant-scoped
  sources require routing the loader through the tenant resolver,
  which we don't model in PLUGIN-ARCH-1.
- **External dependency resolution**: an external plugin repo that
  `import`s `@ragdoll/plugin-sdk` needs the SDK resolvable at the
  cloned path. Today's path-of-least-resistance: external authors
  target the duck-type with plain `{manifest, execute}` literals
  and don't need to import the SDK at all. Heavier deps require
  vendoring (or a follow-on `npm install` step in the lifecycle).
- **Worker-side refresh**: the worker process loads its own
  registry at boot. A `/api/plugins/refresh` call on the API
  swaps the API's registry; the worker stays on its boot
  snapshot until restart. A worker-side refresh endpoint (or a
  Redis pub/sub channel the worker subscribes to) is an
  obvious follow-on.
- **Python sidecar dynamic loading**: the sidecar registers its
  HANDLERS at startup. Repo-driven Python plugin loading would
  mirror this design on the sidecar side.

## References

- `packages/plugin-loader/src/sources.ts` — source store + types.
- `packages/plugin-loader/src/git-fetcher.ts` — content-addressed
  clone.
- `packages/plugin-loader/src/lifecycle.ts` — per-source load.
- `packages/plugin-loader/src/registry-holder.ts` — holder + swap +
  refresh.
- `packages/db/migrations/023_plugin_sources.sql` — DB schema.
- `apps/api/src/app/routes/plugins-providers.ts` — `/sources` +
  `/refresh` endpoints.
