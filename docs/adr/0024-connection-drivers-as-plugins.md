# ADR 0024: Connection Drivers as Plugins

## Status

**Implemented.** Companion to [ADR 0023 — Unified Connections Registry](./0023-unified-connections-registry.md).
0023 establishes that connection `kind` is open-ended text; this ADR
specifies how the platform learns about new kinds without a code
change.

The six in-process drivers shipped today (`postgres`, `mongodb`,
`clickhouse`, `qdrant`, `opensearch`, `dgraph`) are loaded via
`ConnectionDriverPlugin` manifests; `plugins/builtin-rag/src/index.ts`
re-exports each so `packages/plugin-loader` discovers them through its
standard module-namespace scan. The imperative
`registerConnectionDriver(kind, driver, manifest)` API is kept as a
public shim for tests / out-of-tree consumers and is no longer the
registration path drivers ship through.

`GET /api/connection-kinds` enumerates the loaded catalog; the
Connections form in the web UI renders schema-driven from each kind's
`configSchema` with zero per-kind TSX.

## Context

The current driver registry (`registerConnectionDriver(kind, driver)`)
is plugin-shaped in **code** — the postgres / mongodb / clickhouse
families each call it at module load — but not plugin-shaped in the
**registry**. Adding a new connection kind requires:

1. Editing TypeScript in `packages/external-connections/` (or wherever
   the driver lives).
2. Editing the per-kind config form in the web UI by hand
   (`apps/web/src/components/ConnectionsScreen.tsx` has the form switch
   today).
3. Bundling the driver's npm package into the runtime image.
4. Shipping a new platform release.

That's a "fork the platform to add a Snowflake driver" workflow. ADR
0019 (Plugin Contract v2) + ADR 0022 (Connect transport) established
that external plugins can be installed as sidecars without forking the
platform; connection drivers should ride the same path.

## Proposal

Introduce a new plugin **category**, `connection_driver`, whose
manifest declares everything the platform needs to recognise, render,
probe, and pool a new connection kind.

### Manifest shape

```ts
interface ConnectionDriverManifest extends PluginManifest {
  category: "connection_driver";
  /** Unique kind string. Globally unique across all installed drivers;
   *  the loader refuses two manifests claiming the same kind. */
  kind: string;
  /** Per-kind config schema rendered as the connection form. Standard
   *  JsonSchemaLike — same shape every other plugin manifest uses for
   *  its configSchema. The schema describes ONLY non-secret config
   *  (host, port, database, TLS verify, …); credentials live in
   *  managed secrets and are referenced separately via `secretRefId`. */
  configSchema: JsonSchemaLike;
  /** Optional schema describing the expected shape of the resolved
   *  secret (e.g. {"type":"string"} for a DSN, {"type":"object",
   *  "properties":{"username":..., "password":...}} for split creds).
   *  The Connections UI uses this to render the secret-binding step. */
  secretSchema?: JsonSchemaLike;
  /** Connection-test entrypoint. Called by the "Test now" button and
   *  the periodic connection_probe_sweep. Returns ok+error; never
   *  throws. */
  probe: (resolved: ResolvedConnection) => Promise<{ ok: boolean; error?: string }>;
  /** Acquire a pooled client for this connection. The runtime caches
   *  the returned client by connection.id (per ADR-0023 §1) and hands
   *  it back to every subsequent acquire for the same connection. */
  acquire: (resolved: ResolvedConnection) => Promise<unknown>;
  /** Optional disposal — invoked when the connection is archived /
   *  deleted or the process shuts down. */
  dispose?: (client: unknown) => Promise<void>;
}
```

### Lifecycle

1. **Discovery**. Plugin loader scans the in-process and external
   plugin registries for `category: "connection_driver"`. Each
   manifest is indexed by `kind`.
2. **Validation at load**. Duplicate `kind` across two drivers is a
   load-time error. Missing `acquire` is a load-time error. Missing
   `probe` is permitted (defaults to a no-op that returns ok — for
   drivers where TCP-reach is the only meaningful liveness signal).
3. **UI integration**. The Connections form requests the
   `connectionKinds` API at mount; the API enumerates the loaded
   driver manifests + their `configSchema`s. The form renders
   dynamically from the schema (the existing `schemaForm` utility
   already does this for other plugin configs).
4. **Pool cache**. The runtime's existing connection-id-keyed cache
   (from ADR-0021, preserved in 0023) calls `driver.acquire()` on
   miss, caches the result, hands it back on subsequent acquires.
5. **Probe sweep**. The 10-minute `connection_probe_sweep` worker job
   (ADR-0021 follow-up) iterates rows, looks up each row's driver by
   `kind`, calls `driver.probe()`, writes the result back.
6. **Disposal**. On row archive: the runtime calls `driver.dispose()`
   on the cached client (if any) and evicts the cache entry. On
   process shutdown: same, across every cached client.

### External (Connect-transport) drivers

A `connection_driver` plugin can run as a sidecar — same machinery
ADR-0022 established for other v2 plugins. The manifest is published
the same way; `probe` / `acquire` / `dispose` become Connect RPC
methods. The plugin process owns the actual DB client; the platform
talks to it over the wire.

This is the path for Snowflake / Databricks / BigQuery / Trino — heavy
JVM-shaped drivers that the platform should NOT bundle. Operator
installs the sidecar, the platform registers the kind, the
Connections UI now offers it.

In-process drivers (the families we ship today: postgres, mongodb,
clickhouse) remain in-process. The category is the same; the
transport is the difference.

### Permission model

Driver plugins are **platform-scoped**: installing one is
`plugin:manage`, same as any other plugin install. Using a connection
of that kind is governed by `connection:use` per ADR-0023 §6.

A platform admin can't be forced to accept a driver they don't trust
— same posture as any other v2 external plugin.

### Schema discovery for the Builder

Picker UIs (ADR-0023 §5) filter connections by what kinds the relevant
plugin accepts. The loader exposes:

```
GET /api/connection-kinds
  -> [{ kind: "postgres", displayName: "PostgreSQL",
        configSchema: {...}, secretSchema: {...},
        bindingsAccepted: ["vectors"], category: "in_process" | "external" }, …]
```

The `bindingsAccepted` field is computed from the loaded plugin
catalog: which plugins declare `requires: [{kind: <this>, binding:
<x>}]`. Empty array = tool-only kind (mongo, clickhouse today). The
dataset binding picker reads this to filter; the pipeline node binding
picker reads it for the same reason.

## Migration

In-process drivers shipped today (postgres, mongodb, clickhouse) move
from imperative `registerConnectionDriver(...)` calls to manifest
declarations under `plugins/builtin-rag/src/plugins/<kind>/manifest.ts`
and a sibling driver implementation. The plugin loader picks them up
through the same scan that finds every other plugin. Two-step
deprecation:

1. **Release N**: introduce the manifest path. Both registration
   paths work; the static `registerConnectionDriver` calls become a
   thin shim that constructs a manifest from the args.
2. **Release N+1**: drop the imperative registration API. All drivers
   must be manifests. The shim goes away.

External plugins authored against the existing v2 contract don't need
to change — they just gain a new category they CAN claim if they're a
driver.

## Backwards compatibility

- The runtime's `registerConnectionDriver(kind, driver)` continues to
  exist for one release as a compatibility shim that synthesises a
  manifest at call time.
- `getRegisteredDriverKinds()` / `acquireClient(connection)` /
  `closeClient(connectionId)` / `probeConnection(connection)` keep
  their signatures — the underlying implementation routes through the
  manifest registry.
- ADR-0023's pool cache (keyed by `connection.id`) is unchanged.

## Alternatives considered

1. **Keep drivers static in code, deferred indefinitely.** Cheapest,
   but locks the platform to whatever's bundled. Rejected because the
   operator demand to add Snowflake / Databricks without a platform
   release is already implicit in ADR-0023's open-ended `kind`.
2. **Per-kind code paths in the UI.** Today the Connections form
   switches between Qdrant / OpenSearch / Postgres / etc. forms via
   hand-rolled TSX. Adding a new kind = TSX change. Reject by making
   the form schema-driven via the loader's `configSchema`.
3. **One mega-plugin per family containing both the connection driver
   AND the consuming plugins.** Tempting bundling, but conflates
   "owns the driver" with "owns the use-case plugins" — they're
   independently versionable and independently authored (a third party
   may ship a Snowflake driver; operators ship pipelines that use it
   via standard `clickhouse_query`-style query plugins authored
   separately).

## Consequences

- New connection kinds ship as **plugins, not platform releases**.
  Snowflake, Databricks, BigQuery, Trino — all installable as
  sidecars.
- The Connections form becomes **schema-driven**: zero hand-rolled
  TSX per kind.
- Probe + acquire + dispose lifecycle is **one contract** that every
  driver implements, in-process or external. No special-cased code
  paths.
- The static "known kinds" table in code goes away. The picker UIs
  in datasets + pipeline nodes read the live loaded catalog.
- Operators get to **refuse drivers** at install time same as any
  other plugin (the `plugin:manage` gate).
- Migration cost is bounded: today's three in-process drivers get
  thin manifest wrappers; the imperative registration API stays as a
  shim for one release.

## References

- ADR 0019 — Plugin Contract v2.
- ADR 0021 — External Connections Registry (registry side; this ADR
  is the driver-loading side).
- ADR 0022 — Connect RPC plugin transport (the on-the-wire path
  external drivers use).
- ADR 0023 — Unified Connections Registry (companion).
