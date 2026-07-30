/**
 * TokenSource — the identity-connection token lifecycle helper.
 *
 * Pins the properties a hand-rolled per-driver token cache usually gets wrong:
 * single-flight minting, proactive refresh with skew (clamped to ≤ half the
 * TTL), invalidate-on-401, static (never-expiring) tokens, and per-audience
 * isolation. A controllable clock makes expiry deterministic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TokenSource, type MintedToken } from "../src/token-source.ts";

/** A clock the tests advance by hand. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("mints on first get, then serves the cached token until it goes stale", async () => {
  const clock = fakeClock();
  let mints = 0;
  const ts = new TokenSource({
    now: clock.now,
    skewMs: 60_000,
    mint: async () => ({ token: `t${++mints}`, expiresAt: clock.now() + 900_000 })
  });

  assert.equal(await ts.get(), "t1");
  assert.equal(await ts.get(), "t1"); // cached
  assert.equal(mints, 1);

  // Advance to just before the refresh point (expiry - 60s skew): still fresh.
  clock.advance(900_000 - 60_000 - 1);
  assert.equal(await ts.get(), "t1");
  assert.equal(mints, 1);

  // Cross the refresh point → re-mint.
  clock.advance(2);
  assert.equal(await ts.get(), "t2");
  assert.equal(mints, 2);
});

test("single-flight: concurrent gets on an expired token trigger ONE mint", async () => {
  const clock = fakeClock();
  let mints = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const ts = new TokenSource({
    now: clock.now,
    mint: async () => {
      mints += 1;
      await gate; // hold all callers inside the mint
      return { token: "shared", expiresAt: clock.now() + 900_000 };
    }
  });

  const all = Promise.all([ts.get(), ts.get(), ts.get(), ts.get()]);
  release();
  const tokens = await all;
  assert.deepEqual(tokens, ["shared", "shared", "shared", "shared"]);
  assert.equal(mints, 1, "four concurrent gets must share one mint");
});

test("invalidate() forces the next get to re-mint (the 401 path)", async () => {
  const clock = fakeClock();
  let mints = 0;
  const ts = new TokenSource({
    now: clock.now,
    mint: async () => ({ token: `t${++mints}`, expiresAt: clock.now() + 900_000 })
  });

  assert.equal(await ts.get(), "t1");
  ts.invalidate();
  assert.equal(await ts.get(), "t2"); // re-minted despite not being expired
  assert.equal(mints, 2);
});

test("a null-expiry (static) token is never refreshed by the clock", async () => {
  const clock = fakeClock();
  let mints = 0;
  const ts = new TokenSource({
    now: clock.now,
    mint: async (): Promise<MintedToken> => ({ token: `s${++mints}`, expiresAt: null })
  });

  assert.equal(await ts.get(), "s1");
  clock.advance(10 * 365 * 24 * 60 * 60 * 1000); // a decade
  assert.equal(await ts.get(), "s1");
  assert.equal(mints, 1);
  // …but an explicit invalidate still re-mints it.
  ts.invalidate();
  assert.equal(await ts.get(), "s2");
});

test("skew is clamped to half the TTL so short-lived tokens still get used", async () => {
  const clock = fakeClock();
  let mints = 0;
  // TTL 30s, skew 60s. Un-clamped, expiry-skew would be in the past → re-mint
  // on every call. Clamped to 15s, the token is usable for ~15s.
  const ts = new TokenSource({
    now: clock.now,
    skewMs: 60_000,
    mint: async () => ({ token: `t${++mints}`, expiresAt: clock.now() + 30_000 })
  });

  assert.equal(await ts.get(), "t1");
  clock.advance(10_000); // 10s < 15s refresh point
  assert.equal(await ts.get(), "t1");
  assert.equal(mints, 1);
  clock.advance(6_000); // now past the 15s refresh point
  assert.equal(await ts.get(), "t2");
});

test("audiences are cached independently", async () => {
  const clock = fakeClock();
  const minted: string[] = [];
  const ts = new TokenSource({
    now: clock.now,
    mint: async (audience) => {
      minted.push(audience ?? "<none>");
      return { token: `tok:${audience ?? "none"}`, expiresAt: clock.now() + 900_000 };
    }
  });

  assert.equal(await ts.get("api://a"), "tok:api://a");
  assert.equal(await ts.get("api://b"), "tok:api://b");
  assert.equal(await ts.get("api://a"), "tok:api://a"); // cached, no re-mint
  assert.deepEqual(minted, ["api://a", "api://b"]);

  // Invalidating one audience doesn't touch the other.
  ts.invalidate("api://a");
  assert.equal(await ts.get("api://b"), "tok:api://b");
  assert.equal(minted.length, 2);
  assert.equal(await ts.get("api://a"), "tok:api://a");
  assert.equal(minted.length, 3);
});

test("a failing mint rejects the get and caches nothing; the next get retries", async () => {
  const clock = fakeClock();
  let attempt = 0;
  const ts = new TokenSource({
    now: clock.now,
    mint: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("idp unreachable");
      return { token: "recovered", expiresAt: clock.now() + 900_000 };
    }
  });

  await assert.rejects(() => ts.get(), /idp unreachable/);
  assert.equal(await ts.get(), "recovered"); // retried, not stuck on the failure
  assert.equal(attempt, 2);
});
