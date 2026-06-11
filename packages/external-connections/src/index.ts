/**
 * ADR-0021: External Connections Registry — runtime side.
 *
 * What lives here:
 *   - `ResolvedExternalConnection`: the shape a plugin receives at execute
 *     time (the row + resolved secret/DSN). Mirrors `ResolvedDataset`.
 *   - `ExternalConnectionResolver`: given a slug + (tenant, env), walks the
 *     repo cascade, fetches the secret, and assembles the resolved object.
 *   - `ConnectionDriverRegistry`: a process-wide map of `kind` → factory.
 *     Plugin families register their driver once at module load (e.g.
 *     `registerConnectionDriver("mongodb", mongoFactory)`), and the
 *     resolver/plugin uses `acquireClient(connection)` to get a pooled
 *     client. The pool cache keys off `connection.id` (per ADR-0021) so
 *     pool isolation is explainable, not accidental.
 *
 * What does NOT live here:
 *   - The DB row + repo (those live in `packages/db`).
 *   - The driver implementations themselves (those live with their plugin
 *     family in `plugins/builtin-rag/src/plugins/<kind>.ts` to avoid
 *     forcing the runtime to import every driver's npm package).
 */

import type { ConnectionRepository, ConnectionRow } from "../../db/src/types.ts";
import type { SecretProvider } from "../../secrets/src/index.ts";

export type { ConnectionRow, ConnectionRepository };

/**
 * The shape handed to a plugin at execute time. Carries the row,
 * the resolved secret value (whatever the kind expects — usually a URI
 * or DSN string), and the per-kind options blob.
 */
export interface ResolvedExternalConnection {
  id: string;
  slug: string;
  kind: string;
  /** Resolved credential payload (DSN, mongo URI, ClickHouse password, …).
   *  `undefined` when the connection row has no `secretRefKey` — the
   *  driver may still construct a client from `options` alone for
   *  no-auth or env-defaulting backends. */
  secret?: string;
  options: Record<string, unknown>;
  /** Diagnostic — how the slug was resolved through the cascade. */
  cascadeReason: "global" | "tenant" | "environment";
}

export interface ResolveConnectionArgs {
  slug: string;
  tenantId?: string;
  environmentId?: string;
}

export class ExternalConnectionResolver {
  private repo: ConnectionRepository;
  private secrets: SecretProvider;

  constructor(repo: ConnectionRepository, secrets: SecretProvider) {
    this.repo = repo;
    this.secrets = secrets;
  }

  async resolve(
    args: ResolveConnectionArgs
  ): Promise<ResolvedExternalConnection | undefined> {
    const row = await this.repo.resolveSlug(args);
    if (!row) return undefined;
    let secret: string | undefined;
    if (row.secretRefKey) {
      try {
        secret = await this.secrets.get(
          // SecretRef shape expected by SecretProvider. The connection's
          // secretRefKey is a key into the tenant's secret store.
          {
            scope: row.tenantId ? "tenant" : "global",
            tenantId: row.tenantId ?? undefined,
            key: row.secretRefKey
          },
          row.tenantId ?? args.tenantId ?? ""
        );
      } catch {
        // A connection with an unresolved secret still surfaces — the
        // driver factory decides whether to fail (most will). Letting
        // resolution succeed lets the UI display the connection row.
      }
    }
    return {
      id: row.id,
      slug: row.slug,
      kind: row.kind,
      secret,
      options: row.config ?? {},
      cascadeReason:
        row.scope === "environment"
          ? "environment"
          : row.scope === "tenant"
            ? "tenant"
            : "global"
    };
  }
}

// ---------------------------------------------------------------------------
// Driver registry: per-kind factories + per-(connection.id) pool cache.
// ---------------------------------------------------------------------------

/**
 * A driver factory produces a kind-specific client object from a resolved
 * connection. The runtime caches whatever you return, keyed by
 * `connection.id`; you'll get the SAME object back on every subsequent
 * call for the same connection until `closeClient` is invoked. That's
 * what gives plugins shared pooling.
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
}

/**
 * Minimal JSON-schema-like shape (matches `JsonSchemaLike` in plugin-sdk
 * — declared structurally here to avoid the cross-package import). The
 * Connections form in the web UI renders directly from this.
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
 * ADR-0024 manifest metadata for a connection driver.
 *
 * Bundled with the driver factory at registration time so the
 * Connections UI can render a per-kind config form WITHOUT hand-rolled
 * TSX, the picker can filter by "which plugin slots does this kind
 * fill," and the connection-kinds API can enumerate every loaded
 * driver dynamically.
 *
 * Driver authors install via `registerConnectionDriver(kind, driver,
 * manifest)`. New manifest fields are additive; the legacy two-arg
 * call (driver only) still works for now and produces a synthesized
 * manifest with empty schemas.
 */
export interface ConnectionDriverManifest {
  /** Operator-facing label rendered in the Type dropdown. */
  displayName: string;
  /** One-line summary shown next to the dropdown option. */
  description?: string;
  /** JSON-schema-like shape for the per-kind config form (host, port,
   *  database, TLS verify, etc.). Secrets DO NOT appear here — they're
   *  referenced via `secretRefKey` on the connection row. */
  configSchema: ConnectionConfigSchema;
  /** Optional schema describing the expected resolved-secret shape
   *  (string DSN vs split-creds object). UI hint only. */
  secretSchema?: ConnectionConfigSchema;
  /** Binding names this kind can fill in a Dataset (e.g. ["vectors"]
   *  for qdrant, ["vectors","keywords"] for opensearch). Empty array
   *  = tool-only kind, never appears in dataset binding pickers. The
   *  binding-name vocabulary is plugin-declared per ADR-0023 §3. */
  datasetBindings?: string[];
  /** Whether the driver runs in-process (bundled with the platform)
   *  or via Connect transport (external sidecar, ADR-0022). External
   *  drivers ship as separate plugins; in-process are the families
   *  the platform bundles today (postgres / mongodb / clickhouse). */
  transport?: "in_process" | "external";
}

interface DriverEntry {
  driver: ConnectionDriver<unknown>;
  manifest: ConnectionDriverManifest;
}

const drivers = new Map<string, DriverEntry>();
const clientCache = new Map<string, unknown>();

const DEFAULT_MANIFEST: ConnectionDriverManifest = {
  displayName: "(unnamed)",
  configSchema: { type: "object", properties: {}, additionalProperties: true },
  datasetBindings: [],
  transport: "in_process"
};

/**
 * Register a driver factory for a connection kind. Idempotent: a re-register
 * with the same kind replaces the prior factory (useful in tests). Drivers
 * for shipped families (`mongodb`, `clickhouse`, …) register at module-load
 * time of their plugin file.
 *
 * Two call shapes:
 *  - `registerConnectionDriver(kind, driver)` — legacy, synthesizes an
 *    empty manifest. The Connections UI will show a raw JSON editor for
 *    this kind (no rendered form).
 *  - `registerConnectionDriver(kind, driver, manifest)` — ADR-0024, the
 *    Connections UI renders the per-kind form from `manifest.configSchema`
 *    and the dataset picker filters by `manifest.datasetBindings`.
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
 * snapshot of the loaded driver manifests so the UI can populate the
 * Type dropdown + render config forms dynamically.
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
 * Acquire (or build + cache) a client for the given connection. The cache
 * key is `connection.id` per ADR-0021 — explainable pool isolation, not
 * accidental DSN-based identity. Two pipelines pointing at the SAME
 * registered connection share a pool; two pipelines pointing at
 * different connections (even with identical underlying DSNs) get
 * different pools.
 */
export async function acquireClient<T = unknown>(
  connection: ResolvedExternalConnection
): Promise<T> {
  const cached = clientCache.get(connection.id);
  if (cached !== undefined) return cached as T;
  const entry = drivers.get(connection.kind);
  if (!entry) {
    throw new Error(
      `no driver registered for connection kind "${connection.kind}" — call registerConnectionDriver() in the plugin module`
    );
  }
  const client = await entry.driver.create(connection);
  clientCache.set(connection.id, client);
  return client as T;
}

/**
 * Dispose a single cached client. Used when a connection is archived /
 * deleted so its pool closes promptly instead of waiting for process
 * shutdown.
 */
export async function closeClient(connectionId: string): Promise<void> {
  const client = clientCache.get(connectionId);
  if (client === undefined) return;
  clientCache.delete(connectionId);
  // Find the driver by walking registrations — connection.kind isn't
  // stored separately in the cache; the registry is small so this is cheap.
  for (const entry of drivers.values()) {
    if (entry.driver.dispose) {
      try {
        await entry.driver.dispose(client);
      } catch {
        /* best-effort */
      }
    }
  }
}

/** Drop every cached client + driver. Test helper. */
export function resetConnectionRegistry(): void {
  for (const client of clientCache.values()) {
    void client;
  }
  clientCache.clear();
  drivers.clear();
}

/**
 * Run a health probe against a registered connection using its driver's
 * `probe` hook. Returns `{ ok: true }` when the driver accepted the
 * probe, `{ ok: false, error }` on any failure. Never throws.
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
// ADR-0024: drivers ship as plugin manifests.
// ---------------------------------------------------------------------------
//
// `ConnectionDriverPlugin` is the shape an in-process driver exports so the
// platform's plugin-loader can discover it through the same module-scan that
// finds every other in-process plugin. The loader bridges these into the
// imperative driver map via `registerConnectionDriverPlugin` so existing
// `acquireClient` / `probeConnection` paths keep working unchanged.
//
// External (Connect-transport) drivers ship as `category: "connection_driver"`
// plugins too — the manifest's `id` / `version` flow through the standard
// external-plugin registration path; the loader calls into a Connect client
// adapter for the driver hooks. That keeps "ship a Snowflake sidecar" on the
// SAME contract as "ship an in-process Qdrant driver".

import type { PluginManifest } from "../../plugin-sdk/src/index.ts";

/**
 * A driver shipped as a plugin. Combines:
 *  - `kind` — the connection kind this driver fills (globally unique across
 *    every loaded driver plugin; the loader refuses two with the same kind).
 *  - `driverManifest` — the UI/picker metadata (display name, configSchema,
 *    secretSchema, datasetBindings, transport).
 *  - `driver` — the runtime factory (`create` / optional `dispose` / optional
 *    `probe`).
 *  - `manifest` — a regular {@link PluginManifest} with
 *    `category: "connection_driver"`. The conventional id is
 *    `connection_driver.<kind>` so it doesn't collide with execute-able
 *    plugins under the same kind label.
 *
 * Use {@link defineConnectionDriverPlugin} to build one — the helper sets the
 * conventional id and the empty config/output schemas the registry expects.
 */
export interface ConnectionDriverPlugin {
  kind: string;
  manifest: PluginManifest;
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
 * Build a {@link ConnectionDriverPlugin} that the plugin-loader will
 * discover via its standard module scan. Sets the conventional
 * `connection_driver.<kind>` id and a no-op execute() so the same
 * RegisteredPlugin record can be listed by `/api/plugins` without
 * polluting the executable-plugin set (the runtime never calls execute()
 * on a connection_driver — the driver hooks are pulled off `driver`).
 */
export function defineConnectionDriverPlugin<TClient = unknown>(
  args: DefineConnectionDriverPluginArgs<TClient>
): ConnectionDriverPlugin {
  const manifest: PluginManifest = {
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
 *  loader to distinguish driver exports from regular InProcessPlugin exports
 *  during the module-namespace scan. */
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
 * so the existing `acquireClient` / `probeConnection` / `closeClient`
 * machinery keeps working without changes. Direct callers should prefer
 * exporting a {@link ConnectionDriverPlugin} — this entry point is the bridge,
 * not the primary contract.
 */
export function registerConnectionDriverPlugin(plugin: ConnectionDriverPlugin): void {
  registerConnectionDriver(plugin.kind, plugin.driver, plugin.driverManifest);
}
