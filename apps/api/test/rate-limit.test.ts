import test from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, webhookPerIpLimiter, webhookPerTokenLimiter, ssoPerIpLimiter } from "../src/app/rate-limit.ts";

test("RateLimiter: bucket starts at capacity and decrements per consume", () => {
  const rl = new RateLimiter({ capacity: 3, refillPerSec: 1 });
  const a = rl.consume("k", 0);
  const b = rl.consume("k", 0);
  const c = rl.consume("k", 0);
  assert.equal(a.allowed, true);
  assert.equal(a.remaining, 2);
  assert.equal(b.remaining, 1);
  assert.equal(c.remaining, 0);
});

test("RateLimiter: returns retry-after when bucket is empty", () => {
  const rl = new RateLimiter({ capacity: 1, refillPerSec: 2 });
  rl.consume("k", 0);
  const denied = rl.consume("k", 0);
  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 0);
  // Need 1 token at 2/sec → ceil(0.5) = 1s.
  assert.equal(denied.retryAfterSec, 1);
});

test("RateLimiter: tokens refill over time and a later consume is allowed", () => {
  const rl = new RateLimiter({ capacity: 2, refillPerSec: 10 });
  rl.consume("k", 0);
  rl.consume("k", 0);
  // Empty bucket; wait 200ms → 2 tokens available.
  const after = rl.consume("k", 200);
  assert.equal(after.allowed, true);
});

test("RateLimiter: keys are isolated", () => {
  const rl = new RateLimiter({ capacity: 1, refillPerSec: 1 });
  assert.equal(rl.consume("a", 0).allowed, true);
  assert.equal(rl.consume("b", 0).allowed, true);
  // Both buckets exhausted, but independently.
  assert.equal(rl.consume("a", 0).allowed, false);
  assert.equal(rl.consume("b", 0).allowed, false);
});

test("RateLimiter: rejects non-positive config", () => {
  assert.throws(() => new RateLimiter({ capacity: 0, refillPerSec: 1 }));
  assert.throws(() => new RateLimiter({ capacity: 1, refillPerSec: 0 }));
});

test("module-level limiters are wired and resettable", () => {
  // Smoke test — these are the singletons routes import. Reset to avoid
  // cross-test contamination if some other test happens to fire first.
  webhookPerIpLimiter.reset();
  webhookPerTokenLimiter.reset();
  ssoPerIpLimiter.reset();
  assert.equal(webhookPerIpLimiter.consume("test-ip").allowed, true);
  assert.equal(webhookPerTokenLimiter.consume("test-tok").allowed, true);
  assert.equal(ssoPerIpLimiter.consume("test-sso-ip").allowed, true);
});
