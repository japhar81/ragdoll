/**
 * SSO state store tests. Covers:
 *  - InMemorySsoStateStore: set/get/delete + TTL expiry.
 *  - RedisSsoStateStore: serialisation, EX TTL math, missing/corrupt
 *    entry handling, key prefixing — exercised against a fake
 *    RedisLikeClient so the suite stays offline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemorySsoStateStore,
  RedisSsoStateStore,
  type RedisLikeClient,
  type SsoPendingState
} from "../src/sso-state.ts";

function pending(overrides: Partial<SsoPendingState> = {}): SsoPendingState {
  return {
    slug: "okta",
    nonce: "n-1",
    redirectUri: "https://app/cb",
    at: Date.now(),
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// InMemorySsoStateStore
// ---------------------------------------------------------------------------

test("InMemorySsoStateStore: set then get round-trips the value", async () => {
  const s = new InMemorySsoStateStore();
  await s.set("tok", pending(), 10_000);
  assert.deepEqual(await s.get("tok"), pending({ at: (await s.get("tok"))!.at }));
});

test("InMemorySsoStateStore: get on missing key returns undefined", async () => {
  const s = new InMemorySsoStateStore();
  assert.equal(await s.get("nope"), undefined);
});

test("InMemorySsoStateStore: delete removes the entry", async () => {
  const s = new InMemorySsoStateStore();
  await s.set("tok", pending(), 10_000);
  await s.delete("tok");
  assert.equal(await s.get("tok"), undefined);
});

test("InMemorySsoStateStore: TTL expiry lazily on get", async () => {
  const s = new InMemorySsoStateStore();
  await s.set("tok", pending(), 1); // 1ms TTL
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await s.get("tok"), undefined);
});

test("InMemorySsoStateStore: close clears all entries", async () => {
  const s = new InMemorySsoStateStore();
  await s.set("a", pending(), 10_000);
  await s.set("b", pending(), 10_000);
  await s.close?.();
  assert.equal(await s.get("a"), undefined);
  assert.equal(await s.get("b"), undefined);
});

// ---------------------------------------------------------------------------
// RedisSsoStateStore (fake client)
// ---------------------------------------------------------------------------

interface FakeRedisCalls {
  set: Array<{ key: string; value: string; mode: "EX"; seconds: number }>;
  get: string[];
  del: string[];
  quitCalled: boolean;
}

function fakeRedis(): { client: RedisLikeClient; calls: FakeRedisCalls; data: Map<string, string> } {
  const calls: FakeRedisCalls = { set: [], get: [], del: [], quitCalled: false };
  const data = new Map<string, string>();
  const client: RedisLikeClient = {
    async set(key, value, mode, seconds) {
      calls.set.push({ key, value, mode, seconds });
      data.set(key, value);
      return "OK";
    },
    async get(key) {
      calls.get.push(key);
      return data.get(key) ?? null;
    },
    async del(key) {
      calls.del.push(key);
      data.delete(key);
      return 1;
    },
    async quit() {
      calls.quitCalled = true;
      return "OK";
    },
    on() {
      return client;
    }
  };
  return { client, calls, data };
}

test("RedisSsoStateStore: set issues SET … EX with seconds rounded up from ttlMs", async () => {
  const { client, calls } = fakeRedis();
  const store = new RedisSsoStateStore(client);
  await store.set("tok-1", pending(), 600_000); // 10 minutes
  assert.equal(calls.set.length, 1);
  assert.equal(calls.set[0].mode, "EX");
  assert.equal(calls.set[0].seconds, 600);
  assert.equal(calls.set[0].key, "ragdoll:ssoState:tok-1");
});

test("RedisSsoStateStore: sub-second TTL is clamped to a 1-second floor", async () => {
  const { client, calls } = fakeRedis();
  const store = new RedisSsoStateStore(client);
  await store.set("tok", pending(), 50); // 50ms
  // We never want to issue `EX 0` (instant expiry); the store rounds
  // up to a 1s floor so the entry has at least a tick to be claimed.
  assert.equal(calls.set[0].seconds, 1);
});

test("RedisSsoStateStore: custom keyPrefix is honored", async () => {
  const { client, calls } = fakeRedis();
  const store = new RedisSsoStateStore(client, { keyPrefix: "custom:" });
  await store.set("tok", pending(), 10_000);
  assert.equal(calls.set[0].key, "custom:tok");
});

test("RedisSsoStateStore: get parses the JSON payload back into SsoPendingState", async () => {
  const { client } = fakeRedis();
  const store = new RedisSsoStateStore(client);
  const original = pending({ slug: "azure", nonce: "n-xyz" });
  await store.set("tok", original, 10_000);
  const round = await store.get("tok");
  assert.deepEqual(round, original);
});

test("RedisSsoStateStore: get on missing key returns undefined", async () => {
  const { client } = fakeRedis();
  const store = new RedisSsoStateStore(client);
  assert.equal(await store.get("nope"), undefined);
});

test("RedisSsoStateStore: corrupt payload is treated as missing, not thrown", async () => {
  const { client, data } = fakeRedis();
  const store = new RedisSsoStateStore(client);
  // Directly poison the store with something that isn't valid JSON.
  data.set("ragdoll:ssoState:bad", "not-json{");
  assert.equal(await store.get("bad"), undefined);
});

test("RedisSsoStateStore: delete sends DEL with the prefixed key", async () => {
  const { client, calls } = fakeRedis();
  const store = new RedisSsoStateStore(client);
  await store.delete("tok");
  assert.deepEqual(calls.del, ["ragdoll:ssoState:tok"]);
});

test("RedisSsoStateStore: close calls quit only for owned clients", async () => {
  const { client, calls } = fakeRedis();
  const shared = new RedisSsoStateStore(client);
  await shared.close?.();
  assert.equal(calls.quitCalled, false, "shared client should not be quit");
  const owned = new RedisSsoStateStore(client, { owned: true });
  await owned.close?.();
  assert.equal(calls.quitCalled, true);
});
