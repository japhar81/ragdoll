/**
 * In-memory token bucket for per-(key, route) rate limiting.
 *
 * Why in-memory (not Redis):
 *  - Single-replica default — most local/dev deployments are one API pod.
 *  - Avoids a Redis round-trip on every webhook hit (the operation we're
 *    trying to protect).
 *  - For multi-replica deployments the per-pod limit is multiplied by the
 *    replica count, which is FINE for abuse protection (still bounded);
 *    if exact global limits matter, replace with a Redis-backed
 *    implementation that exposes the same `consume()` signature.
 *
 * Bucket math:
 *  - Each key gets `capacity` tokens; one is consumed per request.
 *  - Tokens refill at `refillPerSec` per second, clamped to capacity.
 *  - A request that finds zero tokens returns `{ allowed: false, retryAfterSec }`
 *    so the route can set the `Retry-After` header.
 *
 * Memory management:
 *  - Idle buckets are pruned on `consume()` when over LRU_CAP keys are tracked,
 *    so a flood of one-off IPs can't grow the map unbounded.
 */

export interface RateLimitConfig {
  /** Maximum tokens in the bucket (burst capacity). */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const LRU_CAP = 10_000;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    if (config.capacity <= 0 || config.refillPerSec <= 0) {
      throw new Error(
        `RateLimiter: capacity and refillPerSec must be > 0 (got ${JSON.stringify(config)})`
      );
    }
    this.config = config;
  }

  consume(key: string, now = Date.now()): RateLimitDecision {
    const bucket = this.buckets.get(key) ?? {
      tokens: this.config.capacity,
      lastRefillMs: now
    };
    // Refill since last touch (capped at capacity).
    const elapsedSec = Math.max(0, (now - bucket.lastRefillMs) / 1000);
    const refilled = Math.min(
      this.config.capacity,
      bucket.tokens + elapsedSec * this.config.refillPerSec
    );
    if (refilled < 1) {
      const missing = 1 - refilled;
      const retryAfterSec = Math.ceil(missing / this.config.refillPerSec);
      bucket.tokens = refilled;
      bucket.lastRefillMs = now;
      this.buckets.set(key, bucket);
      return { allowed: false, remaining: 0, retryAfterSec };
    }
    bucket.tokens = refilled - 1;
    bucket.lastRefillMs = now;
    this.buckets.set(key, bucket);
    // Opportunistic LRU prune.
    if (this.buckets.size > LRU_CAP) {
      // Drop the oldest 10% by insertion order.
      let toDrop = Math.floor(LRU_CAP / 10);
      for (const k of this.buckets.keys()) {
        if (toDrop-- <= 0) break;
        if (k !== key) this.buckets.delete(k);
      }
    }
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
      retryAfterSec: 0
    };
  }

  /** Test helper — reset all buckets. */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Module-level singletons keyed by route purpose. Routes import these so
 * test code can `.reset()` between cases without threading a registry.
 *
 * Tuning rationale:
 *  - webhook (per token): 20 burst, 5/sec sustained → 18,000/hr per token,
 *    plenty for a legit producer, blocks brute-force.
 *  - webhook (per IP): 60 burst, 10/sec sustained → catches token enumeration
 *    attempts that rotate through many tokens from one IP.
 *  - sso (per IP): 10 burst, 1/sec sustained → SSO start/callback is rare
 *    in normal use; this is purely abuse mitigation.
 *
 * Override at runtime via env vars (see server boot logs for current values).
 */
function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const webhookPerTokenLimiter = new RateLimiter({
  capacity: envInt("RATE_LIMIT_WEBHOOK_TOKEN_CAPACITY", 20),
  refillPerSec: envInt("RATE_LIMIT_WEBHOOK_TOKEN_REFILL_PER_SEC", 5)
});

export const webhookPerIpLimiter = new RateLimiter({
  capacity: envInt("RATE_LIMIT_WEBHOOK_IP_CAPACITY", 60),
  refillPerSec: envInt("RATE_LIMIT_WEBHOOK_IP_REFILL_PER_SEC", 10)
});

export const ssoPerIpLimiter = new RateLimiter({
  capacity: envInt("RATE_LIMIT_SSO_IP_CAPACITY", 10),
  refillPerSec: envInt("RATE_LIMIT_SSO_IP_REFILL_PER_SEC", 1)
});
