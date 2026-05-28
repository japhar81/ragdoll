/**
 * SSO state store.
 *
 * The OIDC / SAML start step generates a `state` token and stashes the
 * pending flow (slug + nonce + redirectUri + timestamp) under it. The
 * callback step looks the entry up by the `state` the IdP echoes back
 * and clears it.
 *
 * In a single-pod deployment a process-local Map is enough. In a
 * multi-pod deployment the start might land on pod A and the callback
 * on pod B — without shared state the callback fails with
 * `sso_state_invalid` and the user has to redo the entire login. So
 * we ship two implementations:
 *
 *   - InMemorySsoStateStore — Map with TTL, used by tests and any
 *     deployment that doesn't set REDIS_URL.
 *   - RedisSsoStateStore — keyed on `ssoState:<token>`, TTL via
 *     EX seconds. Two ioredis connections aren't needed (no
 *     subscribe), so a single client is sufficient.
 *
 * The interface intentionally avoids a "list" or "scan" — SSO
 * tokens are opaque random strings the operator should never enumerate.
 */

export interface SsoPendingState {
  /** Identity-provider slug the user is signing in via. */
  slug: string;
  /** OIDC nonce used to bind the auth response to this start. */
  nonce: string;
  /** Where the IdP redirects the browser after auth. */
  redirectUri: string;
  /** Unix millis when the state was stored. */
  at: number;
}

export interface SsoStateStore {
  /** Stash a pending state. `ttlMs` triggers a delete that many ms later. */
  set(token: string, state: SsoPendingState, ttlMs: number): Promise<void>;
  /** Look up a pending state. Returns undefined if missing or expired. */
  get(token: string): Promise<SsoPendingState | undefined>;
  /** Delete a pending state (typically called after a successful claim). */
  delete(token: string): Promise<void>;
  /** Release resources (test/teardown only — production stores share the
   *  process-level redis client and don't need cleanup). */
  close?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/**
 * Process-local store. TTL is enforced lazily on `get` (a missed
 * cleanup just means the entry sits in memory until something queries
 * for it). Safe to use offline, in unit tests, or in a single-pod
 * production deployment.
 */
export class InMemorySsoStateStore implements SsoStateStore {
  private states = new Map<string, { state: SsoPendingState; expiresAt: number }>();

  async set(token: string, state: SsoPendingState, ttlMs: number): Promise<void> {
    this.states.set(token, { state, expiresAt: Date.now() + ttlMs });
  }

  async get(token: string): Promise<SsoPendingState | undefined> {
    const entry = this.states.get(token);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.states.delete(token);
      return undefined;
    }
    return entry.state;
  }

  async delete(token: string): Promise<void> {
    this.states.delete(token);
  }

  async close(): Promise<void> {
    this.states.clear();
  }
}

// ---------------------------------------------------------------------------
// Redis implementation
// ---------------------------------------------------------------------------

export interface RedisSsoStateStoreOptions {
  redisUrl: string;
  /** Key prefix for stored states. Defaults to `ragdoll:ssoState:`. */
  keyPrefix?: string;
}

/** Minimal slice of ioredis we use — pinned here so the auth package
 *  stays dependency-free and tests can mock with a plain object. */
export interface RedisLikeClient {
  set(
    key: string,
    value: string,
    mode: "EX",
    seconds: number
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
  on(event: "error", listener: (err: Error) => void): unknown;
}

/**
 * Redis-backed SSO state store. TTL is enforced server-side via the
 * `EX` argument to `SET`, so a callback that arrives after expiry
 * simply hits a missing key — no clock-skew between pods to worry
 * about.
 *
 * The constructor takes a pre-built RedisLikeClient so the same
 * pattern can be reused with a shared `ioredis` instance (api/server.ts
 * already manages one for the change-bus); the {@link createRedisSsoStateStore}
 * factory below is the convenience that opens a dedicated client when
 * the caller doesn't have one to share.
 */
export class RedisSsoStateStore implements SsoStateStore {
  private client: RedisLikeClient;
  private prefix: string;
  private owned: boolean;

  constructor(client: RedisLikeClient, options: { keyPrefix?: string; owned?: boolean } = {}) {
    this.client = client;
    this.prefix = options.keyPrefix ?? "ragdoll:ssoState:";
    this.owned = options.owned ?? false;
  }

  private k(token: string): string {
    return `${this.prefix}${token}`;
  }

  async set(token: string, state: SsoPendingState, ttlMs: number): Promise<void> {
    const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
    await this.client.set(this.k(token), JSON.stringify(state), "EX", ttlSeconds);
  }

  async get(token: string): Promise<SsoPendingState | undefined> {
    const raw = await this.client.get(this.k(token));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as SsoPendingState;
    } catch {
      // Corrupted entry — treat as missing rather than crash the login.
      return undefined;
    }
  }

  async delete(token: string): Promise<void> {
    await this.client.del(this.k(token));
  }

  async close(): Promise<void> {
    if (this.owned) await this.client.quit();
  }
}

/**
 * Convenience factory that lazy-imports `ioredis` (so the package stays
 * install-free for unit tests / single-pod offline use) and returns
 * a connected RedisSsoStateStore.
 */
export async function createRedisSsoStateStore(
  options: RedisSsoStateStoreOptions
): Promise<RedisSsoStateStore> {
  // Lazy import keeps tests and offline single-pod paths free of the
  // ioredis dependency. Same pattern as createRedisChangeBus.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ioredis: any = await import("ioredis");
  const Redis = ioredis.default ?? ioredis.Redis ?? ioredis;
  const client = new Redis(options.redisUrl, { lazyConnect: true });
  client.on("error", () => {
    // Swallowed: real outages reconnect via ioredis's retry strategy;
    // a failing publish surfaces at call time as a rejected promise.
  });
  await client.connect();
  return new RedisSsoStateStore(client as RedisLikeClient, {
    keyPrefix: options.keyPrefix,
    owned: true
  });
}
