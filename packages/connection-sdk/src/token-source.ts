/**
 * ADR-0021 amendment — token lifecycle for identity-protected connections.
 *
 * The connection abstraction pools stateful clients keyed by `connection.id`
 * and hands each driver a credential resolved ONCE at `resolve()` time. That
 * fits a database DSN (a static string) but not an identity-protected service,
 * whose usable credential is a short-lived token minted from a stored secret
 * (client_secret / refresh_token / basic creds) via a network call, and which
 * must be refreshed before it expires.
 *
 * `TokenSource` is the reusable machinery for that second layer. A driver
 * builds one inside the client it returns from `create()`, gives it a `mint`
 * callback that performs the provider-specific token exchange, and calls
 * `get(audience?)` on every request. The connection manager stays oblivious —
 * it still just caches the client object forever; the expiry clock lives here.
 *
 * What it gets right that a hand-rolled per-driver implementation usually
 * doesn't (see the pre-refactor wazuh driver):
 *
 *   - Single-flight: N concurrent `get()`s for the same audience await ONE
 *     `mint()`. Without this, a fleet of pipeline executions hitting an
 *     expired token stampede the IdP — an outage against a rate-limited one.
 *   - Proactive refresh with skew: a token is treated as stale slightly
 *     BEFORE its expiry so an in-flight request doesn't race the clock. The
 *     skew is clamped to half the observed TTL so very short-lived tokens
 *     don't refresh on literally every call.
 *   - Explicit invalidation: `invalidate()` forces the next `get()` to
 *     re-mint — the driver calls it on a 401 (token revoked/expired between
 *     our clock and the server's), then retries once.
 *   - Per-audience isolation: the cache is keyed by audience/scope, so one
 *     connection can hold distinct tokens for distinct downstream audiences
 *     without cross-contamination. Single-audience drivers just pass nothing.
 *
 * Never logs a token: this file only ever returns the string to the caller.
 */

/** A freshly minted token and when it expires. */
export interface MintedToken {
  /** The bearer/access token string. */
  token: string;
  /** Epoch-ms expiry. `null`/`undefined` means the token never expires on a
   *  clock we can see (a static operator-rotated credential) — it is cached
   *  indefinitely and only re-minted on an explicit `invalidate()`. */
  expiresAt?: number | null;
}

export interface TokenSourceOptions {
  /**
   * Mint (or re-mint) a token for `audience`. Runs under single-flight —
   * concurrent `get()`s for the same audience share one call — so it need not
   * guard against its own concurrency. Rejecting propagates to every awaiting
   * `get()` and caches nothing; the next `get()` retries.
   */
  mint: (audience: string | undefined) => Promise<MintedToken>;
  /**
   * Refresh this many ms before expiry. Default 60s. Clamped per-token to at
   * most half the observed TTL so a token whose lifetime is shorter than the
   * skew still gets used rather than re-minted on every call.
   */
  skewMs?: number;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

interface CacheEntry {
  token: string;
  /** Epoch-ms at/after which the token is stale and must be re-minted.
   *  `null` = static (never stale except via `invalidate()`). */
  refreshAt: number | null;
}

const DEFAULT_SKEW_MS = 60_000;

export class TokenSource {
  private readonly mintFn: (audience: string | undefined) => Promise<MintedToken>;
  private readonly skewMs: number;
  private readonly now: () => number;
  /** audience-key → cached token. Key is `audience ?? ""`. */
  private readonly cache = new Map<string, CacheEntry>();
  /** audience-key → in-flight mint, for single-flight. */
  private readonly inflight = new Map<string, Promise<MintedToken>>();

  constructor(opts: TokenSourceOptions) {
    this.mintFn = opts.mint;
    this.skewMs = opts.skewMs ?? DEFAULT_SKEW_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Return a currently-valid token for `audience`, minting or refreshing as
   * needed. Concurrent calls for the same audience await a single mint.
   */
  async get(audience?: string): Promise<string> {
    const key = audience ?? "";
    const cached = this.cache.get(key);
    if (cached && !this.isStale(cached)) return cached.token;
    return this.refresh(key, audience);
  }

  /**
   * Drop the cached token for `audience` (all audiences if omitted) so the
   * next `get()` re-mints. Call on a 401 before retrying. Does not disturb an
   * in-flight mint — that mint's fresh result is exactly what a 401 wants.
   */
  invalidate(audience?: string): void {
    if (audience === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(audience);
  }

  /** Forget every cached token + in-flight mint (driver dispose / shutdown). */
  clear(): void {
    this.cache.clear();
    this.inflight.clear();
  }

  private isStale(entry: CacheEntry): boolean {
    if (entry.refreshAt === null) return false;
    return this.now() >= entry.refreshAt;
  }

  private async refresh(key: string, audience: string | undefined): Promise<string> {
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.mintFn(audience);
      this.inflight.set(key, pending);
      // Clear the in-flight slot whether the mint resolved or rejected, but
      // only if it's still ours (a later mint may have replaced it).
      void pending
        .catch(() => undefined)
        .finally(() => {
          if (this.inflight.get(key) === pending) this.inflight.delete(key);
        });
    }
    const minted = await pending; // throws → nothing cached; caller sees it
    this.cache.set(key, {
      token: minted.token,
      refreshAt: this.computeRefreshAt(minted.expiresAt)
    });
    return minted.token;
  }

  /** Turn an expiry into a refresh deadline, clamping skew to ≤ half the TTL. */
  private computeRefreshAt(expiresAt: number | null | undefined): number | null {
    if (expiresAt === null || expiresAt === undefined) return null;
    const ttl = expiresAt - this.now();
    const skew = Math.min(this.skewMs, Math.max(0, ttl / 2));
    return expiresAt - skew;
  }
}
