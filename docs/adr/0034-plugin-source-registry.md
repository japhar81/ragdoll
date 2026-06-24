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

## Amendment — close-out (Builds 1 / 2 / 3)

After the initial landing, three gaps remained between the
architecture and a bulwark-ready plugin surface. All three closed
without touching the unchanged duck-type contract.

### Build 1 — dependency install (the obvious gap)

A bare git checkout doesn't have `node_modules`. A plugin that
imports `lodash` failed at the `import` stage. We close this with
an `install` stage inserted in the lifecycle right after the cache
check and BEFORE verify:

- New helper `ensureDependenciesInstalled(workingCopy)` in
  `packages/plugin-loader/src/install-deps.ts`.
- `npm ci` when a `package-lock.json` is present, else `npm install`.
  Flags: `--omit=dev --ignore-scripts --no-audit --no-fund
  --loglevel=error`.
- Content-addressed: a sentinel file `.ragdoll-installed` in the
  working copy is the marker. A second load against the same sha
  hits the in-process plugin cache and skips install entirely; a
  cold restart hits the marker and skips install at the helper
  level too.
- Per-source isolation: an install failure surfaces as
  `failed{stage:'install'}` with the stderr tail. New stage in
  the `errorStage` union.
- Hard timeout (default 5 min, `RAGDOLL_PLUGIN_INSTALL_TIMEOUT_MS`
  override) so a hung registry can't wedge a refresh.

KISS safety:
- `--ignore-scripts` by default — postinstall scripts don't run.
  Plugins that need them become a future opt-in (named explicitly
  here as a trust-tier concern; KISS now = install works,
  scripts don't).
- `NPM_CONFIG_FETCH_RETRIES=1` — fail loud rather than retry
  forever inside the child.
- npm config (registry / auth token) inherited from the worker's
  env, not from `$HOME/.npmrc`, so the install runs against a
  known-good registry posture.

### Build 2 — signature verification (KISS: verify, don't build a PKI)

Provenance is recorded; this layer VERIFIES git's own commit
signature against a per-source allowed-signers file. New columns
on `plugin_sources` (migration `024_plugin_sources_signing.sql`):
`require_signature` + `allowed_signers`. Per-source, default OFF.

- Helper `verifyCommitSignature` in
  `packages/plugin-loader/src/verify-signature.ts` runs
  `git -c gpg.format=ssh -c
  gpg.ssh.allowedSignersFile=<tmp> verify-commit <sha>` against a
  hermetic per-call temp file. Exit code is the verdict;
  signer identity parsed from stderr (`Good "git" signature for
  <id> with <key-type> key`).
- Verify runs in the existing `verify` stage, AFTER the cache
  check, BEFORE install. Order: an untrusted source NEVER reaches
  `npm install`.
- A bad / missing / untrusted signature is `failed{stage:'verify'}`;
  the plugin doesn't load. An empty `allowedSigners` with
  `requireSignature: true` is a loud refusal at the same stage.
- Provenance gains `signatureVerified: true` + `signedBy: "<id>"`
  on every plugin from a verified source. `GET /api/plugins`
  surfaces both — operators see the "signed by X" badge.

KISS boundaries (explicit):
- No key management UI, no revocation, no chain-of-trust.
- Reuses git's own verifier — no custom crypto, no PKI.
- Opt-in per source. A source that doesn't require signing keeps
  its legacy behaviour.

### Build 3 — surface (admin screen + CRUD)

- `POST/PATCH/DELETE /api/plugins/sources/:id` added to the
  routes file, all gated by `plugin:manage`. Reserved ids
  (`builtin` / `sample-text`) refused on every mutation so the
  safety-net rows are never editable.
- `PluginSourcesScreen.tsx` mirrors `ConnectionsScreen.tsx`:
  - List rows (id, kind badge, git url + ref + sha, last fetched,
    status + per-source failure stage, plugin count).
  - Side-drawer editor for create / update — git url, ref,
    subpath, description, enabled, signing toggle + allowed-signers
    textarea.
  - Refresh button → `POST /api/plugins/refresh` → inline diff
    (added / removed / updated). The "add a source → refresh →
    plugin appears" moment made visible.
  - Built-in rows surfaced read-only; non-builtin rows get
    Edit + Delete (`plugin:manage` enforced both server-side AND
    via the `canManage` button-disable in the UI).
- Failed sources render their stage + error tail so operators
  diagnose without reading logs.
- Nav: new "Plugin Sources" entry under the "Connections" group,
  gated by `plugin:manage` so non-admins don't see it.

### Verification (close-out)

Plugin-loader (32 tests total, +14 new):
- install: `installFn` called exactly ONCE per `(repoId, sha)`;
  second load hits cache and skips it
- install failure → `failed{stage:'install'}` with the error
  message; no plugin loads
- `skipInstall: true` operator opt-out
- verify: requireSignature + bad signature → `failed{stage:'verify'}`,
  install NEVER runs (load-bearing ordering invariant), no plugin
  registered
- verify: requireSignature + empty allowedSigners → refused
  BEFORE invoking `verifyFn`
- verify: success stamps `signatureVerified` + `signedBy` on the
  status AND the plugin's `source` provenance
- verify: `requireSignature: false` → `verifyFn` NEVER called
- helper-level: empty signers refused; bad sha refused;
  non-zero git exit surfaced with stderr tail; success parses
  the signer id
- `ensureDependenciesInstalled`: returns `not-needed` /
  `already-cached` / fails loudly with stderr

API (5 new tests):
- POST / PATCH / DELETE round-trip; minimal-UPDATE shape
  (audit-friendly)
- reserved ids refused on every mutation
- malformed ids refused on POST
- viewer-level user gets 403 on every mutation

UI: bundle builds cleanly; route + nav entry wired.

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
- **Python sidecar dynamic loading**: ~~the sidecar registers its
  HANDLERS at startup. Repo-driven Python plugin loading would
  mirror this design on the sidecar side.~~ **DONE** — see the
  "Amendment — Python sidecar git loading (PLUGIN-ARCH-2)"
  section below.

## Amendment — file:// URL support

Operators with a local mirror, an air-gapped install, or a dev
workflow that bypasses a hosted Git server can point a plugin
source at a `file:///path/to/bare-repo.git` URL. git supports it
natively; the lifecycle's existing resolve → fetch → import →
scan → register path covers it without a code branch.

One non-obvious correctness concern needed handling:

**`git clone --no-hardlinks` is load-bearing for `file://`.**

By default, `git clone` of a `file://` URL uses git's "local
optimization" — it **hardlinks** objects from the source bare repo
into the clone's `.git/objects/`. That means a write to the source
repo's objects later (e.g. `git gc`, `git push -f`, or a manual
mutation) would mutate the cached working copy too. That breaks
the content-addressed cache invariant: a path keyed by sha MUST be
immutable post-clone.

`--no-hardlinks` is unconditionally applied to the clone command
— it's a no-op on https / ssh / git transports (those always
copy) so keeping it on without a per-scheme branch is the right
call.

Verification: `packages/plugin-loader/test/file-url.test.ts` runs
the full lifecycle against a real bare repo created with `git
init --bare`, including a test that:

1. Clones the source via `file://` into the cache,
2. Reads the cached plugin file's content,
3. Mutates the source repo (commits different content +
   force-pushes + `git gc --prune=now`),
4. Re-reads the cached file and asserts it's UNCHANGED.

That's the `--no-hardlinks` guarantee made tangible.

The screen's URL input placeholder mentions both shapes:
`https://git.internal.example/plugins.git  or
file:///srv/plugins/repo.git`, with help text explaining the
no-hardlinks behaviour.

## Amendment — Python sidecar git loading (PLUGIN-ARCH-2)

The TS in-process loader (this ADR) had a sibling gap: the Python
sidecar's plugins were all baked into the image, registered in a
static `HANDLERS` dict. This amendment lets the sidecar load
plugin handlers from external (internal/trusted) git repos too —
the Python mirror of the same design.

### Sidecar side (`services/python-plugins`)

- `app/git_source.py` — content-addressed git fetch, a direct port
  of `git-fetcher.ts`: `git ls-remote` to resolve ref → sha,
  `git clone --no-hardlinks --filter=blob:none` into
  `<cache>/<repoId>/<sha>/`, idempotent on a repeat `(repoId, sha)`.
  Same `--no-hardlinks` `file://` invariant.
- `app/plugin_loader.py` — per-source lifecycle (resolve → clone →
  install deps → import → scan → register) with per-source
  isolation + provenance. A git-loaded plugin module uses the SAME
  duck-type every built-in sidecar plugin already exposes:

      PLUGIN_ID = "my_plugin"            # str
      def handle(request) -> dict: ...   # the handler
      MANIFEST = {...}                   # optional, for RAGdoll discovery

  Discovery scans the subpath's top-level `.py` files. Deps are
  pip-installed into an isolated, content-addressed `.ragdoll_deps`
  dir inside the working copy (marker-gated, once per sha — the
  Python analogue of the TS `npm ci` install stage). Per-source
  failure → a `failed` status with the stage (`resolve` / `clone`
  / `install` / `import` / `scan` / `register`), never crashing the
  load.
- `app/main.py` — `HANDLERS` became `BUILTIN_HANDLERS` + a LIVE
  resolver (`_resolve_handler`) the Connect bridge reads on every
  call, so reloads are visible without rebuilding the app.
  Built-ins win over git-loaded on an id collision (a vendor repo
  can't shadow a first-party plugin). Sources load from
  `RAGDOLL_PYTHON_PLUGIN_SOURCES` (a JSON array) at startup; a
  token-gated `POST /admin/reload` reloads at runtime (accepting
  the source list in the body so RAGdoll can push the current
  `plugin_sources` rows). The registry SWAP on reload replaces the
  whole git-loaded set, so a removed source's plugins disappear.
- `GET /manifests` — lists every git-loaded plugin's id + manifest
  + provenance. This is RAGdoll's discovery surface.
- Dockerfile — `git` added to the apt install (it wasn't present).

### RAGdoll side (`packages/plugin-loader`)

- `registerSidecarGitPlugins(registry)` — queries the sidecar's
  `GET /manifests` and registers each reported plugin as an
  external plugin pointed at the sidecar, with the git provenance
  the sidecar reports. A module with no `MANIFEST` gets a
  synthesised minimal manifest so it's still referenceable +
  executable. Best-effort: sidecar down / older image (no
  `/manifests`) / no `PYTHON_PLUGIN_URL` → silent no-op.
- `applyExternalPlugins(registry)` — the hardcoded built-in sidecar
  manifests + the git-loaded discovery, run together. Wired as the
  `postRegister` hook on `/api/plugins/refresh` (which ALSO fixes a
  latent bug: the refresh path previously dropped ALL external
  PYTHON_PLUGIN_URL plugins on a registry swap because it never
  re-layered them) and called once at API boot so git-loaded
  sidecar plugins appear in the builder palette without a manual
  refresh.

### Verification

Python — `services/python-plugins/tests/test_plugin_loader.py`
(real `git init --bare` fixtures, auto-skip when git absent):
resolve `main` → sha; sha short-circuit; content-addressed +
idempotent clone; end-to-end load registers the handler + stamps
provenance + the manifest; cache-hit replays the same object;
disabled source skipped; a bad source is isolated and the good one
still loads; a non-plugin module registers nothing; a removed
source disappears on reload; `parse_sources_env` happy + garbage
paths.

TS — `packages/plugin-loader/test/sidecar-git-plugins.test.ts`
(stub `/manifests` server): registers with manifest + provenance;
synthesises a manifest when `MANIFEST` is omitted; no
`PYTHON_PLUGIN_URL` / 404 / unreachable → silent no-op;
`applyExternalPlugins` layers hardcoded built-ins AND git-loaded.

### Single source of truth (DONE)

`plugin_sources` is now the single source of truth for BOTH plugin
families. Migration `025_plugin_sources_host.sql` adds a `host`
column:

- `host: "worker"` (default) — TS in-process. Loaded by the
  lifecycle in `buildPluginRegistry` (which now SKIPS sidecar-host
  rows so a Python repo is never import-attempted as a TS module).
- `host: "sidecar"` — Python. `pushSidecarSources(store)` POSTs the
  enabled sidecar-host rows to the sidecar's `POST /admin/reload`
  (always, even an empty list, so a removed row is dropped — the
  reload swaps the whole git-loaded set). RAGdoll then discovers the
  resulting plugins back via `registerSidecarGitPlugins`
  (`/manifests`) and stamps each row's load result on the store via
  `markLoadResult`.

Wired into the refresh route (push → rebuild → discover; the
response carries a `sidecar` push report) AND API boot. The
sidecar's `/admin/reload` is gated by `RAGDOLL_SIDECAR_ADMIN_TOKEN`
(matched on both sides via the compose env); unset → open (dev
default). The Plugin Sources screen exposes the `host` as a select
on the editor + a column in the list, and surfaces the sidecar push
result inline after a refresh.

The sidecar's `RAGDOLL_PYTHON_PLUGIN_SOURCES` env still works as a
fallback for an air-gapped sidecar RAGdoll can't reach.

Verified: `pushSidecarSources` posts ONLY sidecar-host rows with the
token + marks results; empty-list-drops-removed; no-URL / unreachable
graceful no-op; `buildPluginRegistry` skips sidecar rows in-process;
the API CRUD round-trips `host` + the refresh report carries
`sidecar`. Plus a live e2e (a `host: "sidecar"` row pushed +
served).

### Deferred (still PLUGIN-ARCH-2+)

- Signature verification for sidecar git plugins (the TS side has
  it; the Python side trusts the internal/trusted model for now).

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
