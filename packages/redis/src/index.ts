/**
 * Shared ioredis client construction, hardened against Valkey/Redis failover.
 *
 * THE BUG THIS FIXES
 * ------------------
 * `REDIS_URL` points at the Bitnami redis/Valkey `-master` Service, which routes
 * to whichever pod currently holds the primary role. When Valkey is redeployed
 * or fails over (a StatefulSet rolling update, a Sentinel-driven promotion), the
 * pod our TCP connection is pinned to can lose the primary role and become a
 * READ-ONLY replica. ioredis keeps that established socket open — a role change
 * does not drop the connection — so every subsequent write command errors with:
 *
 *     READONLY You can't write against a read only replica.
 *
 * and, because the connection is never re-established, it NEVER recovers. The
 * worker's leader-election loop caught the error, logged
 * `leader_election_tick_failed`, backed off, and retried against the same dead
 * connection forever.
 *
 * THE FIX
 * -------
 * ioredis's `reconnectOnError` hook: on a READONLY error we return `2`, which
 * tells ioredis to (a) drop and re-establish the connection — re-resolving the
 * `-master` DNS to the NEW primary — and (b) re-send the failed command so the
 * write lands on the new primary instead of erroring out. Every other error is
 * left to ioredis's normal retry strategy.
 *
 * All keyspace-writing clients (leader election, SSO pending-state) build their
 * connection through {@link createRedisClient} so they share this behavior.
 */

/** The minimal logger slice we use (matches @ragdoll/observability). */
export interface RedisClientLogger {
  warn?: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * ioredis `reconnectOnError` handler. Returns `2` (reconnect AND resend the
 * failed command) when the connected node reports it is a read-only replica —
 * i.e. a failover/rolling-update left us pinned to a demoted pod. Returns `0`
 * for anything else, leaving ioredis's normal retry strategy in charge.
 *
 * Exported for unit testing — this predicate is the whole fix.
 */
export function reconnectOnError(err: Error): 0 | 2 {
  return /READONLY/i.test(err?.message ?? "") ? 2 : 0;
}

export interface CreateRedisClientOptions {
  /** Logger for connection-level errors (surfaced, not swallowed). */
  logger?: RedisClientLogger;
  /** Log message used for the `error` event. Lets callers keep their existing
   *  structured-log keys (e.g. `leader_election_redis_error`). */
  errorEvent?: string;
  /** Connect eagerly before returning. Default true. */
  connect?: boolean;
}

/**
 * Build an ioredis client that survives a Valkey/Redis failover (see the module
 * doc). ioredis is imported lazily so packages that never touch Redis (offline /
 * single-pod / test paths) don't pay for it.
 *
 * The return type is intentionally loose (`unknown`) — callers narrow it to the
 * small command slice they need, exactly as before.
 */
export async function createRedisClient(
  redisUrl: string,
  options: CreateRedisClientOptions = {}
): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ioredis: any = await import("ioredis");
  const Redis = ioredis.default ?? ioredis.Redis ?? ioredis;
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    // Recover from a failover that left us on a now-read-only replica.
    reconnectOnError
  });
  const event = options.errorEvent ?? "redis_client_error";
  client.on("error", (e: Error) => options.logger?.warn?.(event, { message: e.message }));
  if (options.connect !== false) await client.connect();
  return client;
}
