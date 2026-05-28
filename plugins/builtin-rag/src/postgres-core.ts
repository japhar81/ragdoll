/**
 * Shared pooled-connection core for the Postgres plugin family
 * (`postgres_query`, `postgres_upsert`, `postgres_exec`).
 *
 * The three plugins are siblings of one architectural pattern — external
 * database access via Ragdoll's secret store — so the connection lifecycle
 * lives in one place:
 *
 *   - A module-scoped `Map<key, PoolEntry>` is built lazily on first use.
 *   - Keys hash the resolved DSN so two nodes referencing the same connection
 *     transparently share a pool, while a DSN typo or env-swap creates a
 *     separate pool instead of silently inheriting the wrong one.
 *   - A graceful-shutdown hook ends every pool when the host process receives
 *     `SIGTERM` / `SIGINT` (also exported so tests can clear state
 *     deterministically).
 *
 * Why a hash-keyed pool rather than a name-keyed pool: the prompt suggested
 * keying by connection name, but a name is a label chosen by the pipeline
 * author. Keying by the resolved DSN means the SAME secret reference
 * (resolved per env) is what determines pool identity — so a single alias
 * pointing at dev in one tenant and prod in another keeps the two pools
 * isolated, which is the property we actually want. The `name` is kept on
 * the pool entry for observability labels.
 *
 * `pg` is loaded via dynamic `import("pg")` (matching the existing pattern in
 * `packages/db/src/pool.ts`) so this module is import-safe in environments
 * where `pg` isn't installed — the test suite mocks via {@link __setPoolFactory}.
 */

import { createHash } from "node:crypto";

/** Structural slice of pg.PoolClient we actually use. */
export interface PoolClientLike {
  query<R = Record<string, unknown>>(
    queryConfig: string | { text: string; values?: unknown[] },
    values?: unknown[]
  ): Promise<{ rows: R[]; rowCount: number | null }>;
  release(): void;
}

/** Structural slice of pg.Pool we actually use. */
export interface PoolLike {
  connect(): Promise<PoolClientLike>;
  end(): Promise<void>;
  on(event: "error", listener: (err: unknown) => void): unknown;
}

/** Subset of pg.PoolConfig surfaced as overrides for tests / advanced ops. */
export interface PoolOverrides {
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  allowExitOnIdle?: boolean;
}

/** A pooled entry. `name` is the human label used in metrics / logs. */
export interface PoolEntry {
  name: string;
  pool: PoolLike;
  /** ms wall-clock spent waiting on `pool.connect()` (sampled, additive). */
  acquireWaitMs: number;
  /** number of `pool.connect()` calls observed since the pool was created. */
  acquireCount: number;
}

type PoolFactory = (args: { dsn: string; overrides?: PoolOverrides }) => Promise<PoolLike>;

const POOL_CACHE = new Map<string, PoolEntry>();
let shutdownHookInstalled = false;
let poolFactory: PoolFactory = defaultPoolFactory;

/**
 * Default factory: dynamic-import `pg` so this module is safe to load in
 * environments where the native module isn't installed (the test suite
 * mocks via {@link __setPoolFactory}).
 */
async function defaultPoolFactory(args: { dsn: string; overrides?: PoolOverrides }): Promise<PoolLike> {
  // `pg` ships without bundled types in this repo (no @types/pg installed);
  // dynamic-import + cast keeps the module import-safe AND lint-clean.
  const pgImport = new Function("m", "return import(m)") as (m: string) => Promise<unknown>;
  const pg = (await pgImport("pg")) as {
    default?: { Pool: new (cfg: Record<string, unknown>) => PoolLike };
    Pool?: new (cfg: Record<string, unknown>) => PoolLike;
  };
  const PoolCtor = pg.Pool ?? pg.default?.Pool;
  if (!PoolCtor) {
    throw new Error("Unable to resolve pg.Pool constructor (is the `pg` package installed?)");
  }
  return new PoolCtor({
    connectionString: args.dsn,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    allowExitOnIdle: true,
    ...args.overrides
  });
}

/**
 * Test seam: replace the pool factory so unit tests can hand back a fake
 * PoolLike without pulling in the real `pg` driver. Returns the previous
 * factory so a test can restore it in `t.after()`.
 */
export function __setPoolFactory(factory: PoolFactory | null): PoolFactory {
  const prev = poolFactory;
  poolFactory = factory ?? defaultPoolFactory;
  return prev;
}

/**
 * Hash a DSN to derive the pool cache key. SHA-256 then sliced — collisions
 * across distinct DSNs would require an active second pre-image, which is
 * infeasible. We slice to 16 hex chars to keep log lines and trace tags
 * compact; full hash is still recoverable from the DSN if needed.
 */
function dsnKey(dsn: string): string {
  return createHash("sha256").update(dsn).digest("hex").slice(0, 16);
}

/**
 * Install ONCE-per-process shutdown hooks that end every cached pool. The
 * host already handles its own lifecycle for HTTP servers / BullMQ workers,
 * so we attach as a low-priority listener; idempotent because Node fires
 * each signal at most once per registered handler.
 */
function ensureShutdownHook(): void {
  if (shutdownHookInstalled) return;
  shutdownHookInstalled = true;
  const handler = () => {
    void closeAllPools();
  };
  process.once("SIGTERM", handler);
  process.once("SIGINT", handler);
  process.once("beforeExit", handler);
}

/**
 * Resolve (or lazily create) the pool entry for a given DSN.
 *
 * `name` is the operator-facing label (the `config.connection` string) and
 * only ends up in pool metadata; it does NOT affect cache identity. Two
 * nodes with identical DSNs but different labels still share one pool —
 * any other behaviour would be a foot-gun for ingest fan-out.
 *
 * `overrides` is for tests and advanced operators who need to tune
 * `max`, `idleTimeoutMillis`, etc. Most callers pass nothing.
 */
export async function getPool(args: {
  dsn: string;
  name: string;
  overrides?: PoolOverrides;
}): Promise<PoolEntry> {
  if (!args.dsn) {
    throw new Error("postgres-core: dsn is required (set the connection secret).");
  }
  ensureShutdownHook();
  const key = dsnKey(args.dsn);
  const existing = POOL_CACHE.get(key);
  if (existing) return existing;

  const pool = await poolFactory({ dsn: args.dsn, overrides: args.overrides });
  // Suppress unhandled `error` events from idle clients — they're emitted
  // when the DB drops an idle connection (e.g. server restart) and would
  // otherwise crash the process. The next acquire will simply rebuild.
  pool.on("error", () => undefined);
  const entry: PoolEntry = { name: args.name, pool, acquireWaitMs: 0, acquireCount: 0 };
  POOL_CACHE.set(key, entry);
  return entry;
}

/**
 * Acquire a client from the pool with wait-time accounting. Callers should
 * always `release()` in a `finally` block; this helper does NOT auto-release
 * because callers run multi-statement transactions and need explicit control.
 */
export async function acquire(entry: PoolEntry): Promise<PoolClientLike> {
  const start = Date.now();
  const client = await entry.pool.connect();
  entry.acquireWaitMs += Date.now() - start;
  entry.acquireCount += 1;
  return client;
}

/** End every cached pool. Used by the shutdown hook and the test suite. */
export async function closeAllPools(): Promise<void> {
  const entries = [...POOL_CACHE.values()];
  POOL_CACHE.clear();
  await Promise.all(
    entries.map(async (entry) => {
      try {
        await entry.pool.end();
      } catch {
        // Intentional swallow: closing during shutdown is best-effort.
      }
    })
  );
}

/** Test seam: peek at the cache size without exposing the cache itself. */
export function poolCacheSize(): number {
  return POOL_CACHE.size;
}

/**
 * Identifier regex: a Postgres unquoted identifier is up to 63 chars from
 * `[A-Za-z_][A-Za-z0-9_$]*`. Quoted identifiers can contain anything but
 * we deliberately reject them — accepting `"` from operator-supplied config
 * is the SQL-injection vector this whole module is designed to close.
 *
 * Identifiers are the ONE thing in SQL that can't be parameterised by the
 * driver. Validating them here, then quoting with double-quotes at use
 * sites, gives a strong guarantee: every identifier in the emitted SQL is
 * a well-formed token chosen by the pipeline author (config-time), never
 * by a runtime input value.
 */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

/**
 * Validate `value` as a Postgres identifier and return the double-quoted
 * form ready for splicing into SQL. Throws `InvalidIdentifierError` on
 * malformed input — never returns the input string verbatim.
 *
 * Two-part names (`schema.table`) are split, validated independently, and
 * re-joined. We don't accept three-part (database-qualified) names because
 * the database is already pinned by the DSN.
 */
export function quoteIdentifier(value: string, fieldLabel = "identifier"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidIdentifierError(`${fieldLabel} must be a non-empty string`);
  }
  const parts = value.split(".");
  if (parts.length > 2) {
    throw new InvalidIdentifierError(
      `${fieldLabel} ${JSON.stringify(value)} must be at most "schema.name"`
    );
  }
  for (const part of parts) {
    if (!IDENTIFIER_RE.test(part)) {
      throw new InvalidIdentifierError(
        `${fieldLabel} ${JSON.stringify(value)} is not a valid Postgres identifier ` +
          "(expected [A-Za-z_][A-Za-z0-9_$]{0,62}; quoted identifiers are not accepted)"
      );
    }
  }
  return parts.map((part) => `"${part}"`).join(".");
}

export class InvalidIdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidIdentifierError";
  }
}

/**
 * Defensive readonly statement gate. The READ ONLY transaction `postgres_query`
 * opens is the authoritative defence (it makes any write fail at the DB), but
 * surfacing a clear error pre-flight beats a cryptic "cannot execute … in a
 * read-only transaction" from Postgres after the round-trip.
 *
 * The check is intentionally conservative: it rejects on the first
 * "non-read" keyword in a statement-leading position, after stripping the
 * outer `WITH … SELECT` shape so CTE-headed reads pass.
 */
const NON_READ_LEADING =
  /^(insert|update|delete|merge|truncate|alter|create|drop|grant|revoke|comment|vacuum|reindex|cluster|copy|call|do|listen|notify|unlisten|prepare|deallocate|execute|reset|set|begin|commit|rollback|savepoint|release|lock)\b/i;

export function assertLooksReadOnly(sql: string): void {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  // Allow a leading CTE: `WITH … AS (...) SELECT/VALUES …`. We don't try to
  // parse — instead we check that the trimmed statement, after a possible
  // `WITH` prefix, starts with a read keyword. False negatives are acceptable
  // (the READ ONLY transaction backs us up); false positives would block
  // legitimate queries, which is why we accept WITH/SELECT/VALUES/TABLE/SHOW.
  if (/^(select|values|table|show|with)\b/i.test(trimmed)) return;
  if (NON_READ_LEADING.test(trimmed)) {
    throw new Error(
      `postgres_query is read-only: refusing statement starting with ${JSON.stringify(
        trimmed.split(/\s+/, 1)[0] ?? ""
      )}`
    );
  }
  // Unknown leading keyword — let it through; the READ ONLY txn will reject
  // anything that mutates, and `EXPLAIN ANALYZE` style statements are safe.
}
