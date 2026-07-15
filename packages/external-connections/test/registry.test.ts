/**
 * Connection driver registry — the manager-level guarantees the identity
 * work depends on:
 *
 *   - `acquireClient` single-flights `create()`: two concurrent first-acquires
 *     for the same connection share ONE build (no double pool / double token
 *     source).
 *   - `closeClient` disposes via the driver that BUILT the client (matched by
 *     kind), never a sibling driver — the bug the token path would trip.
 *   - `ExternalConnectionResolver` attaches a working `resolveSecret` seam that
 *     re-runs the cascade, so a rotated stored secret is picked up on demand.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  acquireClient,
  closeClient,
  registerConnectionDriver,
  resetConnectionRegistry,
  ExternalConnectionResolver,
  type ConnectionDriver,
  type ResolvedExternalConnection
} from "../src/index.ts";

function conn(over: Partial<ResolvedExternalConnection> = {}): ResolvedExternalConnection {
  return {
    id: "c1",
    slug: "s1",
    kind: "k1",
    options: {},
    cascadeReason: "global",
    ...over
  };
}

test("acquireClient single-flights create() for concurrent first-acquires", async (t) => {
  t.after(() => resetConnectionRegistry());
  resetConnectionRegistry();

  let creates = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const driver: ConnectionDriver<{ n: number }> = {
    async create() {
      const n = ++creates;
      await gate;
      return { n };
    }
  };
  registerConnectionDriver("k1", driver);

  const all = Promise.all([acquireClient(conn()), acquireClient(conn()), acquireClient(conn())]);
  release();
  const clients = await all;
  assert.equal(creates, 1, "one create for three concurrent acquires");
  // All callers get the SAME cached instance.
  assert.equal(clients[0], clients[1]);
  assert.equal(clients[1], clients[2]);
  // And a later acquire still returns that instance.
  assert.equal(await acquireClient(conn()), clients[0]);
  assert.equal(creates, 1);
});

test("a failed create() doesn't wedge the connection — the next acquire retries", async (t) => {
  t.after(() => resetConnectionRegistry());
  resetConnectionRegistry();

  let attempt = 0;
  registerConnectionDriver("k1", {
    async create() {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return { ok: true };
    }
  });

  await assert.rejects(() => acquireClient(conn()), /boom/);
  assert.deepEqual(await acquireClient(conn()), { ok: true });
  assert.equal(attempt, 2);
});

test("closeClient disposes via the driver that built the client, not siblings", async (t) => {
  t.after(() => resetConnectionRegistry());
  resetConnectionRegistry();

  const disposed: string[] = [];
  registerConnectionDriver("k1", {
    async create() {
      return { which: "k1" };
    },
    async dispose() {
      disposed.push("k1");
    }
  });
  // A sibling driver whose dispose must NOT run for a k1 client.
  registerConnectionDriver("k2", {
    async create() {
      return { which: "k2" };
    },
    async dispose() {
      disposed.push("k2");
    }
  });

  await acquireClient(conn({ id: "c1", kind: "k1" }));
  await closeClient("c1");
  assert.deepEqual(disposed, ["k1"], "only the k1 driver's dispose runs");
});

test("resolver attaches a resolveSecret seam that re-runs the cascade", async (t) => {
  t.after(() => resetConnectionRegistry());

  // Minimal repo returning one row with a secretRefKey.
  const repo = {
    resolveSlug: async () => ({
      id: "c9",
      slug: "svc",
      kind: "oauth",
      scope: "global" as const,
      tenantId: null,
      secretRefKey: "svc-secret",
      config: {}
    })
  };
  // A secret provider whose value ROTATES between calls, so re-resolution is
  // observable.
  let version = 0;
  const secrets = {
    get: async () => `secret-v${++version}`
  };

  const resolver = new ExternalConnectionResolver(
    repo as never,
    secrets as never
  );
  const resolved = await resolver.resolve({ slug: "svc" });
  assert.ok(resolved);
  assert.equal(resolved.secret, "secret-v1"); // frozen value from resolve()
  assert.equal(typeof resolved.resolveSecret, "function");
  // The dynamic seam re-runs the cascade → sees the rotated value.
  assert.equal(await resolved.resolveSecret!(), "secret-v2");
  assert.equal(await resolved.resolveSecret!(), "secret-v3");
});

test("a secretless row gets no resolveSecret seam", async () => {
  const repo = {
    resolveSlug: async () => ({
      id: "c0",
      slug: "noauth",
      kind: "http",
      scope: "global" as const,
      tenantId: null,
      secretRefKey: null,
      config: {}
    })
  };
  const resolver = new ExternalConnectionResolver(
    repo as never,
    { get: async () => "unused" } as never
  );
  const resolved = await resolver.resolve({ slug: "noauth" });
  assert.ok(resolved);
  assert.equal(resolved.secret, undefined);
  assert.equal(resolved.resolveSecret, undefined);
});
