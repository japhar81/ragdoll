/**
 * @ragdoll/connection-sdk — the authoring surface for RAGdoll connection
 * drivers.
 *
 * A connection driver teaches the platform how to open + pool a client for an
 * external system (a database, a search engine, an identity-protected HTTP
 * API…). Author one by exporting the result of {@link defineConnectionDriverPlugin}
 * from a plugin module; the platform discovers it by the same duck-typed scan
 * that finds every other plugin.
 *
 * This package is DELIBERATELY dependency-free — it carries only what a plugin
 * author needs (the driver types, the `defineConnectionDriverPlugin` helper,
 * the process-wide driver registry, and the {@link TokenSource} credential-
 * lifecycle helper) and pulls in NONE of the platform runtime (no secret
 * store, no database, no HTTP framework). The secret-resolving half of the
 * connection system (`ExternalConnectionResolver`) lives in the platform, not
 * here, precisely so a published plugin doesn't inherit it.
 *
 * What does NOT live here:
 *   - `ExternalConnectionResolver` — needs the platform's secret store; stays
 *     internal to the platform.
 *   - The connection ROW + repository types — those are a persistence concern.
 */

export {
  TokenSource,
  type MintedToken,
  type TokenSourceOptions
} from "./token-source.ts";

/**
 * The shape handed to a driver's `create()` at execute time. Carries the
 * resolved secret value (whatever the kind expects — usually a URI or DSN
 * string) and the per-kind options blob.
 */
export interface ResolvedExternalConnection {
  id: string;
  slug: string;
  kind: string;
  /** Resolved credential payload (DSN, mongo URI, ClickHouse password, …).
   *  `undefined` when the connection has no secret — the driver may still
   *  construct a client from `options` alone for no-auth or env-defaulting
   *  backends. */
  secret?: string;
  /**
   * Re-resolve the connection's STORED secret on demand. Attached by the
   * platform for connections with a managed secret; `undefined` for secretless
   * connections and for connections built by hand (tests). This is the
   * "dynamically resolve credentials" seam: an identity-protected driver calls
   * it inside its token refresh so a rotated client_secret / refresh_token is
   * picked up WITHOUT a process restart, whereas `secret` is the value frozen
   * at resolve() time. Static/DB drivers ignore it and use `secret`.
   *
   * In-process only — a closure cannot cross a transport to an external
   * (sidecar) driver; those resolve credentials on their own side.
   */
  resolveSecret?: () => Promise<string | undefined>;
  options: Record<string, unknown>;
  /** Diagnostic — how the slug was resolved through the scope cascade. */
  cascadeReason: "global" | "tenant" | "environment";
}

export interface ResolveConnectionArgs {
  slug: string;
  tenantId?: string;
  environmentId?: string;
}

/**
 * ADR-0039: a JSON-serialisable credential a driver materialises for an
 * external (sidecar) plugin. The live driver client (a pooled DB handle, an
 * open socket) can never cross a transport; this is the portable projection of
 * it — a bearer token, a header set, a DSN string — that core computes in-TS
 * and ships to the sidecar so the sidecar never re-implements the driver's
 * credential logic.
 *
 * Every field is optional so a driver emits only what its backend needs; a
 * sidecar reads whichever it understands.
 */
export interface ExternalCredential {
  /** Primary credential string — a bearer token, DSN, password, signed URL.
   *  The common case; a sidecar reads it as `connection.credential.value`. */
  value?: string;
  /** Header name → value to attach to outbound requests (e.g. `Authorization`). */
  headers?: Record<string, string>;
  /** Query-string params to attach (signed-URL schemes). */
  query?: Record<string, string>;
  /** ISO-8601 instant after which `value` / `headers` are stale. The sidecar
   *  redeems its callback grant to re-materialise BEFORE this. Absent = the
   *  credential has no known expiry (static DSN / password). */
  expiresAt?: string;
  /** Non-secret, driver-specific metadata the plugin needs alongside the
   *  credential (region, account id, base URL…). Distinct from the connection's
   *  own `options`; use this for anything derived while materialising. */
  options?: Record<string, unknown>;
}

/**
 * ADR-0040: the run context a driver may read while materialising a credential
 * for a sidecar plugin. Handed to {@link ConnectionDriver.materializeExternalCredential}
 * so a SINGLE connection can serve many tenants / environments / credentials —
 * the per-run selectors (a tenant id, an environment id, a credential id) come
 * from the node's resolved `config` or an upstream input port rather than being
 * baked into the connection, which would force one connection per combination.
 *
 * Everything here is resolved IN CORE (the driver runs in-process), so reading
 * it is free — nothing is serialised at materialise time; only the returned
 * {@link ExternalCredential} crosses the wire.
 */
export interface CredentialMaterializationContext {
  tenantId: string;
  /** Environment NAME (dev/staging/prod) — matches the execution context. */
  environment: string;
  executionId: string;
  nodeId: string;
  requestId?: string;
  /** The node's resolved config (templates substituted), exactly as the plugin
   *  sees it. A driver reads its selectors from here, e.g. `config.tenantRef`. */
  config: Record<string, unknown>;
  /** The node's resolved input-port values (upstream outputs feeding this
   *  node). A driver may read a selector from a wired port instead of config.
   *  Can be large — read the specific key you need, don't walk the whole map. */
  inputs: Record<string, unknown>;
  /**
   * Set ONLY on the refresh-callback path, NEVER on the first (runtime)
   * materialisation. It is the {@link MaterializedExternalCredential.refreshContext}
   * the driver nominated on the first call, persisted on the grant and replayed
   * here: the API callback has no node config / input ports at redeem time, so a
   * run-context-dependent driver stashes its selectors here on the first call
   * and reads them back from here on refresh. When this is present, prefer it
   * over `config` / `inputs` (which are empty on the refresh path).
   */
  refreshContext?: Record<string, unknown>;
}

/**
 * ADR-0040: the return of {@link ConnectionDriver.materializeExternalCredential}.
 * It is an {@link ExternalCredential} (what ships to the sidecar) plus an
 * optional, CORE-ONLY `refreshContext` the driver wants replayed on the refresh
 * callback. Core persists `refreshContext` on the grant and STRIPS it from the
 * envelope — it never crosses the wire. A driver that doesn't depend on run
 * context simply returns a plain {@link ExternalCredential} (back-compatible).
 */
export interface MaterializedExternalCredential extends ExternalCredential {
  /**
   * Identifiers-only selectors (a tenant id, an environment id, a credential
   * id) the driver needs to re-materialise this exact credential on refresh.
   * MUST NOT contain secrets — it is persisted in the grant store; the secret
   * itself is always re-fetched, never stored. Absent for drivers that resolve
   * the credential from the connection alone.
   */
  refreshContext?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Driver registry: per-kind factories + per-(connection.id) pool cache.
// ---------------------------------------------------------------------------

/**
 * A driver factory produces a kind-specific client object from a resolved
 * connection. The runtime caches whatever you return, keyed by
 * `connection.id`; you'll get the SAME object back on every subsequent call
 * for the same connection until `closeClient` is invoked. That's what gives
 * plugins shared pooling.
 *
 * `dispose` is invoked on registry shutdown or when a connection is
 * archived/deleted so drivers can close pools cleanly.
 */
export interface ConnectionDriver<TClient = unknown> {
  create(connection: ResolvedExternalConnection): Promise<TClient>;
  dispose?(client: TClient): Promise<void>;
  /** Optional health probe — the periodic probe job calls this; the
   *  result is stored on the connection row. */
  probe?(client: TClient): Promise<void>;
  /**
   * ADR-0039 — OPT-IN: produce a serialisable {@link ExternalCredential} for a
   * sidecar plugin. Only drivers whose credential is meaningfully portable
   * across a process boundary (a minted token, a header set, a DSN) implement
   * this; a pooled live-client driver (Postgres, Mongo) omits it and stays
   * in-process only, which is exactly why a credential never leaks to a sidecar
   * unless a driver author deliberately exposes one. Identity-protected drivers
   * typically mint a fresh token here (reusing their in-process
   * {@link TokenSource}), so core materialises a current credential per call —
   * and the external callback grant re-invokes this to refresh mid-run.
   *
   * ADR-0040 — the optional second argument carries the run context (node
   * config / input ports / tenant / environment). A driver reads its per-run
   * selectors from it so ONE connection serves many tenants/credentials, and
   * returns a {@link MaterializedExternalCredential} whose `refreshContext`
   * core replays on the refresh callback. The argument is optional and the
   * richer return extends {@link ExternalCredential}, so a driver written
   * against ADR-0039 keeps compiling and working unchanged.
   */
  materializeExternalCredential?(
    connection: ResolvedExternalConnection,
    context?: CredentialMaterializationContext
  ): Promise<MaterializedExternalCredential>;
}

/**
 * Minimal JSON-schema-like shape. The Connections form in the platform UI
 * renders directly from this. Declared structurally so the SDK stays free of
 * any schema library.
 */
export interface ConnectionConfigSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, ConnectionConfigSchema>;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  format?: string;
  items?: ConnectionConfigSchema;
  additionalProperties?: boolean | ConnectionConfigSchema;
}

/**
 * Manifest metadata for a connection driver.
 *
 * Bundled with the driver factory at registration time so the Connections UI
 * can render a per-kind config form WITHOUT hand-rolled TSX, the picker can
 * filter by "which plugin slots does this kind fill," and the connection-kinds
 * API can enumerate every loaded driver dynamically.
 */
export interface ConnectionDriverManifest {
  /** Operator-facing label rendered in the Type dropdown. */
  displayName: string;
  /** One-line summary shown next to the dropdown option. */
  description?: string;
  /** JSON-schema-like shape for the per-kind config form (host, port,
   *  database, TLS verify, etc.). Secrets DO NOT appear here — they're
   *  referenced via the connection's managed secret. */
  configSchema: ConnectionConfigSchema;
  /** Optional schema describing the expected resolved-secret shape
   *  (string DSN vs split-creds object). UI hint only. */
  secretSchema?: ConnectionConfigSchema;
  /** Binding names this kind can fill in a Dataset (e.g. ["vectors"] for
   *  qdrant, ["vectors","keywords"] for opensearch). Empty array = tool-only
   *  kind, never appears in dataset binding pickers. */
  datasetBindings?: string[];
  /** Whether the driver runs in-process (bundled with the platform) or via a
   *  transport (external sidecar). */
  transport?: "in_process" | "external";
}

interface DriverEntry {
  driver: ConnectionDriver<unknown>;
  manifest: ConnectionDriverManifest;
}

const drivers = new Map<string, DriverEntry>();
/** connection.id → the cached client AND the kind that built it. Storing the
 *  kind is what lets `closeClient` dispose via the RIGHT driver (see below). */
const clientCache = new Map<string, { kind: string; client: unknown }>();
/** connection.id → in-flight `create()`, so two concurrent acquires for the
 *  same connection share one build instead of racing to construct (and leak)
 *  two pools / two token sources. */
const clientInflight = new Map<string, Promise<unknown>>();

const DEFAULT_MANIFEST: ConnectionDriverManifest = {
  displayName: "(unnamed)",
  configSchema: { type: "object", properties: {}, additionalProperties: true },
  datasetBindings: [],
  transport: "in_process"
};

/**
 * Register a driver factory for a connection kind. Idempotent: a re-register
 * with the same kind replaces the prior factory (useful in tests).
 *
 * Two call shapes:
 *  - `registerConnectionDriver(kind, driver)` — synthesizes an empty manifest.
 *    The Connections UI shows a raw JSON editor for this kind (no rendered
 *    form).
 *  - `registerConnectionDriver(kind, driver, manifest)` — the Connections UI
 *    renders the per-kind form from `manifest.configSchema` and the dataset
 *    picker filters by `manifest.datasetBindings`.
 */
export function registerConnectionDriver<T>(
  kind: string,
  driver: ConnectionDriver<T>,
  manifest?: ConnectionDriverManifest
): void {
  drivers.set(kind, {
    driver: driver as ConnectionDriver<unknown>,
    manifest: manifest
      ? { ...DEFAULT_MANIFEST, ...manifest }
      : { ...DEFAULT_MANIFEST, displayName: kind }
  });
}

export function getRegisteredDriverKinds(): string[] {
  return [...drivers.keys()].sort();
}

/**
 * Public catalog used by `GET /api/connection-kinds`. Returns a stable
 * snapshot of the loaded driver manifests so the UI can populate the Type
 * dropdown + render config forms dynamically.
 */
export interface ConnectionKindInfo extends ConnectionDriverManifest {
  kind: string;
}

export function listConnectionKinds(): ConnectionKindInfo[] {
  return [...drivers.entries()]
    .map(([kind, entry]) => ({ kind, ...entry.manifest }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

/**
 * Acquire (or build + cache) a client for the given connection. The cache key
 * is `connection.id` — explainable pool isolation, not accidental DSN-based
 * identity. Two pipelines pointing at the SAME registered connection share a
 * pool; two pipelines pointing at different connections (even with identical
 * underlying DSNs) get different pools.
 */
export async function acquireClient<T = unknown>(
  connection: ResolvedExternalConnection
): Promise<T> {
  const cached = clientCache.get(connection.id);
  if (cached !== undefined) return cached.client as T;
  // Single-flight: coalesce concurrent first-acquires for the same connection
  // onto one create() so we don't build (and cache-clobber, and leak) two
  // clients. Matters most for token drivers, whose create() opens an IdP
  // session.
  let pending = clientInflight.get(connection.id);
  if (!pending) {
    const entry = drivers.get(connection.kind);
    if (!entry) {
      throw new Error(
        `no driver registered for connection kind "${connection.kind}" — call registerConnectionDriver() in the plugin module`
      );
    }
    const kind = connection.kind;
    pending = entry.driver.create(connection).then((client) => {
      clientCache.set(connection.id, { kind, client });
      return client;
    });
    clientInflight.set(connection.id, pending);
    // Clear the in-flight slot on settle (success OR failure) so a failed
    // create() doesn't wedge the connection permanently uncacheable.
    void pending
      .catch(() => undefined)
      .finally(() => {
        if (clientInflight.get(connection.id) === pending) {
          clientInflight.delete(connection.id);
        }
      });
  }
  return (await pending) as T;
}

/**
 * ADR-0039: materialise a serialisable credential for a sidecar plugin by
 * running the driver's opt-in {@link ConnectionDriver.materializeExternalCredential}
 * hook. Called in core at two points — the runtime, to ship the INITIAL
 * credential inline in the external request, and the API callback endpoint, to
 * RE-materialise a fresh one when the sidecar's grant is redeemed near expiry.
 *
 * Returns `undefined` when the driver does not implement the hook: that is the
 * explicit signal that this connection kind is in-process only, and the caller
 * must fail loudly rather than hand the sidecar an empty credential. Throws
 * when no driver is registered for the kind at all.
 *
 * ADR-0040: the optional `context` carries the run's node config / input ports
 * so a run-context-dependent driver resolves the right credential. Forwarded
 * verbatim to the driver hook; omit it and the driver falls back to
 * connection-only resolution (ADR-0039 behaviour).
 */
export async function materializeExternalCredential(
  connection: ResolvedExternalConnection,
  context?: CredentialMaterializationContext
): Promise<MaterializedExternalCredential | undefined> {
  const entry = drivers.get(connection.kind);
  if (!entry) {
    throw new Error(
      `no driver registered for connection kind "${connection.kind}" — call registerConnectionDriver() in the plugin module`
    );
  }
  if (!entry.driver.materializeExternalCredential) return undefined;
  return entry.driver.materializeExternalCredential(connection, context);
}

/**
 * Dispose a single cached client. Used when a connection is archived / deleted
 * so its pool closes promptly instead of waiting for process shutdown.
 */
export async function closeClient(connectionId: string): Promise<void> {
  const cached = clientCache.get(connectionId);
  if (cached === undefined) return;
  clientCache.delete(connectionId);
  // Dispose via the driver that BUILT this client (matched by the stored
  // kind), not every registered driver. Calling a sibling driver's dispose on
  // a client it never created is at best a no-op and at worst destructive —
  // e.g. cancelling the wrong token source's refresh state.
  const entry = drivers.get(cached.kind);
  if (entry?.driver.dispose) {
    try {
      await entry.driver.dispose(cached.client);
    } catch {
      /* best-effort */
    }
  }
}

/** Drop every cached client + driver. Test helper. */
export function resetConnectionRegistry(): void {
  clientCache.clear();
  clientInflight.clear();
  drivers.clear();
}

/**
 * Run a health probe against a registered connection using its driver's
 * `probe` hook. Returns `{ ok: true }` when the driver accepted the probe,
 * `{ ok: false, error }` on any failure. Never throws.
 */
export async function probeConnection(
  connection: ResolvedExternalConnection
): Promise<{ ok: boolean; error?: string }> {
  try {
    const entry = drivers.get(connection.kind);
    if (!entry) {
      return { ok: false, error: `no driver registered for kind "${connection.kind}"` };
    }
    const client = await acquireClient(connection);
    if (entry.driver.probe) await entry.driver.probe(client);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Drivers ship as plugin manifests.
// ---------------------------------------------------------------------------

/**
 * The plugin-manifest subset that {@link defineConnectionDriverPlugin} emits.
 * Kept local so this SDK stays dependency-free; it is a structural subset of
 * the platform's full `PluginManifest`, and the loader discovers driver
 * plugins by duck-typing `category === "connection_driver"`.
 */
export interface ConnectionDriverPluginManifest {
  id: string;
  name: string;
  version: string;
  category: "connection_driver";
  description: string;
  configSchema?: Record<string, unknown>;
  secretsSchema?: Record<string, unknown>;
}

/**
 * A driver shipped as a plugin. Combines:
 *  - `kind` — the connection kind this driver fills (globally unique across
 *    every loaded driver plugin; the loader refuses two with the same kind).
 *  - `driverManifest` — the UI/picker metadata.
 *  - `driver` — the runtime factory (`create` / optional `dispose` / `probe`).
 *  - `manifest` — a plugin manifest with `category: "connection_driver"`. The
 *    conventional id is `connection_driver.<kind>`.
 *
 * Use {@link defineConnectionDriverPlugin} to build one.
 */
export interface ConnectionDriverPlugin {
  kind: string;
  manifest: ConnectionDriverPluginManifest;
  driverManifest: ConnectionDriverManifest;
  driver: ConnectionDriver<unknown>;
}

export interface DefineConnectionDriverPluginArgs<TClient = unknown> {
  /** Connection kind string (e.g. `"qdrant"`, `"clickhouse"`). */
  kind: string;
  /** Plugin name shown in `/api/plugins`. Defaults to the displayName. */
  name?: string;
  /** Plugin version. Defaults to `"1.0.0"`. */
  version?: string;
  /** Driver factory + lifecycle hooks. */
  driver: ConnectionDriver<TClient>;
  /** UI/picker metadata (forwarded to {@link ConnectionKindInfo}). */
  manifest: ConnectionDriverManifest;
}

/**
 * Build a {@link ConnectionDriverPlugin} that the platform's plugin-loader
 * discovers via its standard module scan. Sets the conventional
 * `connection_driver.<kind>` id so a driver never collides with an
 * execute-able plugin under the same kind label.
 */
export function defineConnectionDriverPlugin<TClient = unknown>(
  args: DefineConnectionDriverPluginArgs<TClient>
): ConnectionDriverPlugin {
  const manifest: ConnectionDriverPluginManifest = {
    id: `connection_driver.${args.kind}`,
    name: args.name ?? args.manifest.displayName,
    version: args.version ?? "1.0.0",
    category: "connection_driver",
    description:
      args.manifest.description ?? `Connection driver for kind "${args.kind}".`,
    configSchema: args.manifest.configSchema as Record<string, unknown>,
    secretsSchema: args.manifest.secretSchema as Record<string, unknown> | undefined
  };
  return {
    kind: args.kind,
    manifest,
    driverManifest: args.manifest,
    driver: args.driver as ConnectionDriver<unknown>
  };
}

/** Duck-types a value as a {@link ConnectionDriverPlugin}. Used by the plugin
 *  loader to distinguish driver exports from regular plugin exports during the
 *  module-namespace scan. */
export function isConnectionDriverPlugin(value: unknown): value is ConnectionDriverPlugin {
  if (!value || typeof value !== "object") return false;
  const v = value as {
    kind?: unknown;
    manifest?: { category?: unknown };
    driverManifest?: unknown;
    driver?: { create?: unknown };
  };
  return (
    typeof v.kind === "string" &&
    !!v.manifest &&
    v.manifest.category === "connection_driver" &&
    !!v.driverManifest &&
    !!v.driver &&
    typeof v.driver.create === "function"
  );
}

/**
 * Register a driver plugin into the imperative driver map. The platform's
 * plugin-loader calls this for every discovered {@link ConnectionDriverPlugin}
 * so the `acquireClient` / `probeConnection` / `closeClient` machinery works.
 * Direct callers should prefer exporting a {@link ConnectionDriverPlugin} —
 * this entry point is the bridge, not the primary contract.
 */
export function registerConnectionDriverPlugin(plugin: ConnectionDriverPlugin): void {
  registerConnectionDriver(plugin.kind, plugin.driver, plugin.driverManifest);
}
