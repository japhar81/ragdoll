import { DatabaseConfigError } from "./errors.ts";

// Minimal structural typing for the pieces of `pg` we use, so this module never
// imports `pg` at the top level (the test suite runs with no install / offline).
export interface QueryResultLike<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number | null;
}

export interface PoolClientLike {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResultLike<R>>;
  release(): void;
}

export interface PoolLike {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResultLike<R>>;
  connect(): Promise<PoolClientLike>;
  end(): Promise<void>;
}

export interface CreatePoolOptions {
  connectionString?: string;
  max?: number;
}

/**
 * Lazily constructs a `pg` Pool. `pg` is only imported when this function is
 * actually called, keeping the module import-safe in offline / no-install
 * environments (e.g. the unit test runner).
 */
export async function createPool(options: CreatePoolOptions = {}): Promise<PoolLike> {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new DatabaseConfigError("DATABASE_URL is not set and no connectionString was provided");
  }
  const pg = await import("pg");
  const Pool = (pg as unknown as { default?: { Pool: new (cfg: unknown) => PoolLike }; Pool?: new (cfg: unknown) => PoolLike });
  const PoolCtor = Pool.Pool ?? Pool.default?.Pool;
  if (!PoolCtor) {
    throw new DatabaseConfigError("Unable to resolve pg.Pool constructor");
  }
  return new PoolCtor({ connectionString, max: options.max ?? 10 });
}

/** Runs `fn` inside a transaction, committing on success and rolling back on error. */
export async function withTransaction<T>(
  pool: PoolLike,
  fn: (client: PoolClientLike) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failures; surface the original error
    }
    throw error;
  } finally {
    client.release();
  }
}
