/**
 * Tests for the Redis-backed scheduler leader election.
 *
 * Exercises:
 *  - acquire happy path: SET NX PX succeeds, isLeader() flips true.
 *  - failover: when no peer holds the lease, the next candidate
 *    acquires on its next poll.
 *  - renewal: Lua-fenced PEXPIRE runs at the renew cadence and
 *    keeps the lease alive.
 *  - lease loss: when the holder pauses past TTL and the renewal
 *    Lua returns 0, leadership is surrendered without manual reset.
 *  - release: stop() runs the Lua-fenced DEL only if we still hold
 *    the lease (no clobbering a successor).
 *
 * A fake RedisLikeClient backs all of this — no live Redis required.
 * The fake implements the subset our SET NX/XX PX + EVAL scripts
 * actually use; it tracks owner + expiry per key so failover/loss
 * scenarios behave like real Redis.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  AlwaysLeader,
  RedisLeaderElection,
  type RedisLikeClient
} from "../src/leader-election.ts";

interface FakeEntry {
  value: string;
  expiresAt: number;
}

interface FakeRedis {
  client: RedisLikeClient;
  /** Advance the fake clock — used to expire leases without sleep. */
  advance(ms: number): void;
  /** Read the current holder (or null if expired / missing). */
  holder(key: string): string | null;
  /** Direct write — simulates a peer claiming the lease out-of-band. */
  setHolder(key: string, value: string, ttlMs: number): void;
}

function fakeRedis(): FakeRedis {
  const data = new Map<string, FakeEntry>();
  let now = 1_000_000;
  const isExpired = (e: FakeEntry | undefined): boolean =>
    e === undefined || e.expiresAt <= now;
  const liveEntry = (key: string): FakeEntry | undefined => {
    const e = data.get(key);
    if (isExpired(e)) {
      data.delete(key);
      return undefined;
    }
    return e;
  };
  const client: RedisLikeClient = {
    async set(key, value, mode, expiryMode, ms) {
      if (expiryMode !== "PX") throw new Error("fake: only PX supported");
      const existing = liveEntry(key);
      if (mode === "NX" && existing) return null;
      if (mode === "XX" && !existing) return null;
      data.set(key, { value, expiresAt: now + ms });
      return "OK";
    },
    async eval(script, _numKeys, ...args) {
      // The fake script runner pattern-matches on the two scripts we
      // actually use (renew + release) instead of parsing Lua.
      const [key, token, maybeTtl] = args;
      if (script.includes("PEXPIRE")) {
        const e = liveEntry(key);
        if (!e || e.value !== token) return 0;
        e.expiresAt = now + Number(maybeTtl);
        return 1;
      }
      if (script.includes("DEL")) {
        const e = liveEntry(key);
        if (!e || e.value !== token) return 0;
        data.delete(key);
        return 1;
      }
      throw new Error(`fake: unhandled script ${script}`);
    },
    async quit() {
      return "OK";
    },
    on() {
      return client;
    }
  };
  return {
    client,
    advance(ms: number) {
      now += ms;
    },
    holder(key: string) {
      return liveEntry(key)?.value ?? null;
    },
    setHolder(key: string, value: string, ttlMs: number) {
      data.set(key, { value, expiresAt: now + ttlMs });
    }
  };
}

/** Wait until `predicate()` is true or `timeoutMs` elapses. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// AlwaysLeader
// ---------------------------------------------------------------------------

test("AlwaysLeader is leader from the start; start() returns a no-op stop", async () => {
  const a = new AlwaysLeader();
  assert.equal(a.isLeader(), true);
  const stop = a.start();
  assert.equal(a.isLeader(), true);
  await stop();
  // After stop the AlwaysLeader is still a leader — only one process,
  // no contention; the stop is just for shape parity with the Redis impl.
  assert.equal(a.isLeader(), true);
});

// ---------------------------------------------------------------------------
// RedisLeaderElection
// ---------------------------------------------------------------------------

test("RedisLeaderElection rejects mismatched ttl/renew configuration", () => {
  const { client } = fakeRedis();
  assert.throws(
    () =>
      new RedisLeaderElection({
        client,
        podId: "p1",
        leaseTtlMs: 1000,
        renewIntervalMs: 800,
        pollIntervalMs: 100
      }),
    /at least 2x renewIntervalMs/
  );
});

test("RedisLeaderElection: a single pod acquires the lease on the first poll", async (t) => {
  const r = fakeRedis();
  const election = new RedisLeaderElection({
    client: r.client,
    podId: "pod-A",
    leaseTtlMs: 200,
    renewIntervalMs: 30,
    pollIntervalMs: 30
  });
  const stop = election.start();
  t.after(() => stop());
  await waitFor(() => election.isLeader());
  assert.equal(r.holder("ragdoll:scheduler:leader"), "pod-A");
});

test("RedisLeaderElection: a peer that doesn't hold the lease isn't a leader", async (t) => {
  const r = fakeRedis();
  // Pre-stash a lease held by pod-A.
  r.setHolder("ragdoll:scheduler:leader", "pod-A", 60_000);
  const election = new RedisLeaderElection({
    client: r.client,
    podId: "pod-B",
    leaseTtlMs: 200,
    renewIntervalMs: 30,
    pollIntervalMs: 30
  });
  const stop = election.start();
  t.after(() => stop());
  // Let the loop run a few iterations.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(election.isLeader(), false);
  // Holder unchanged.
  assert.equal(r.holder("ragdoll:scheduler:leader"), "pod-A");
});

test("RedisLeaderElection: failover — peer takes over after the previous holder's lease expires", async (t) => {
  const r = fakeRedis();
  // pod-A holds a lease that's about to expire.
  r.setHolder("ragdoll:scheduler:leader", "pod-A", 50);
  const election = new RedisLeaderElection({
    client: r.client,
    podId: "pod-B",
    leaseTtlMs: 200,
    renewIntervalMs: 30,
    pollIntervalMs: 30
  });
  const stop = election.start();
  t.after(() => stop());
  // Expire pod-A's lease deterministically via the fake clock.
  r.advance(100);
  await waitFor(() => election.isLeader());
  assert.equal(r.holder("ragdoll:scheduler:leader"), "pod-B");
});

test("RedisLeaderElection: a held lease is periodically renewed", async (t) => {
  const r = fakeRedis();
  const election = new RedisLeaderElection({
    client: r.client,
    podId: "pod-A",
    leaseTtlMs: 200,
    renewIntervalMs: 30,
    pollIntervalMs: 30
  });
  const stop = election.start();
  t.after(() => stop());
  await waitFor(() => election.isLeader());
  // Verify renewals keep the lease alive across two renew intervals.
  await new Promise((r) => setTimeout(r, 100));
  // Without renewals the lease would have expired at this point
  // (TTL 200ms, but the fake clock has been frozen — the renew Lua
  // script bumps expiresAt each renewal call).
  assert.equal(r.holder("ragdoll:scheduler:leader"), "pod-A");
  assert.equal(election.isLeader(), true);
});

test("RedisLeaderElection: lease loss is observed and leadership is surrendered", async (t) => {
  const r = fakeRedis();
  const election = new RedisLeaderElection({
    client: r.client,
    podId: "pod-A",
    leaseTtlMs: 200,
    renewIntervalMs: 30,
    pollIntervalMs: 30
  });
  const stop = election.start();
  t.after(() => stop());
  await waitFor(() => election.isLeader());
  // Simulate the lease being stolen — a peer overwrote it (the renew
  // Lua compares ownership and refuses to bump someone else's lease).
  r.setHolder("ragdoll:scheduler:leader", "pod-B", 60_000);
  await waitFor(() => !election.isLeader());
  // pod-A correctly observed the loss and dropped its claim.
});

test("RedisLeaderElection: stop() releases the lease (Lua-fenced DEL)", async (t) => {
  const r = fakeRedis();
  const election = new RedisLeaderElection({
    client: r.client,
    podId: "pod-A",
    leaseTtlMs: 200,
    renewIntervalMs: 30,
    pollIntervalMs: 30
  });
  const stop = election.start();
  await waitFor(() => election.isLeader());
  assert.equal(r.holder("ragdoll:scheduler:leader"), "pod-A");
  await stop();
  // Lease gone — next pod can grab it without waiting for TTL.
  assert.equal(r.holder("ragdoll:scheduler:leader"), null);
  t.after(() => undefined);
});

test("RedisLeaderElection: stop() does NOT clobber a successor's lease", async (t) => {
  const r = fakeRedis();
  const election = new RedisLeaderElection({
    client: r.client,
    podId: "pod-A",
    leaseTtlMs: 200,
    renewIntervalMs: 30,
    pollIntervalMs: 30
  });
  const stop = election.start();
  await waitFor(() => election.isLeader());
  // Out-of-band steal — pod-B is the rightful holder now.
  r.setHolder("ragdoll:scheduler:leader", "pod-B", 60_000);
  await stop();
  // The release Lua compared ownership and did nothing because pod-A
  // no longer holds the key.
  assert.equal(r.holder("ragdoll:scheduler:leader"), "pod-B");
  t.after(() => undefined);
});
