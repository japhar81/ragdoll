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

import type { ExternalConnectionRepository, ExternalConnectionRow } from "../../db/src/types.ts";
import type { SecretProvider } from "../../secrets/src/index.ts";

export type { ExternalConnectionRow, ExternalConnectionRepository };

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
   *  `undefined` when the connection row has no `secretRefId` — the
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
  private repo: ExternalConnectionRepository;
  private secrets: SecretProvider;

  constructor(repo: ExternalConnectionRepository, secrets: SecretProvider) {
    this.repo = repo;
    this.secrets = secrets;
  }

  async resolve(
    args: ResolveConnectionArgs
  ): Promise<ResolvedExternalConnection | undefined> {
    const row = await this.repo.resolveSlug(args);
    if (!row) return undefined;
    let secret: string | undefined;
    if (row.secretRefId) {
      try {
        secret = await this.secrets.get(
          // SecretRef shape expected by SecretProvider. The connection's
          // secretRefId is a key into the tenant's secret store.
          {
            scope: row.tenantId ? "tenant" : "global",
            tenantId: row.tenantId ?? undefined,
            key: row.secretRefId
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
      options: row.options ?? {},
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

type AnyDriver = ConnectionDriver<unknown>;

const drivers = new Map<string, AnyDriver>();
const clientCache = new Map<string, unknown>();

/**
 * Register a driver factory for a connection kind. Idempotent: a re-register
 * with the same kind replaces the prior factory (useful in tests). Drivers
 * for shipped families (`mongodb`, `clickhouse`, …) register at module-load
 * time of their plugin file.
 */
export function registerConnectionDriver<T>(
  kind: string,
  driver: ConnectionDriver<T>
): void {
  drivers.set(kind, driver as AnyDriver);
}

export function getRegisteredDriverKinds(): string[] {
  return [...drivers.keys()].sort();
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
  const driver = drivers.get(connection.kind);
  if (!driver) {
    throw new Error(
      `no driver registered for connection kind "${connection.kind}" — call registerConnectionDriver() in the plugin module`
    );
  }
  const client = await driver.create(connection);
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
  for (const driver of drivers.values()) {
    if (driver.dispose) {
      try {
        await driver.dispose(client);
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
    const driver = drivers.get(connection.kind);
    if (!driver) {
      return { ok: false, error: `no driver registered for kind "${connection.kind}"` };
    }
    const client = await acquireClient(connection);
    if (driver.probe) await driver.probe(client);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
