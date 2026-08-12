/**
 * Regression: updating a connection must INVALIDATE its pooled driver client.
 *
 * The driver registry caches the live client keyed by `connection.id`
 * (`acquireClient`). Before the fix only DELETE evicted that cache — so after
 * an operator edited a connection's config (url/host/secret) and saved, the
 * next `acquireClient()` kept handing back the client built from the OLD
 * config. The visible symptom in the field: change a connection's URL from a
 * remote host to localhost, save, click "Test" → the probe still succeeds
 * against the stale endpoint because it reused the cached client.
 *
 * The registry (`acquireClient`/`closeClient`) is a module singleton shared
 * with the API route, so the test drives the real thing: register a fake
 * driver, populate the pool, PUT the connection, and assert the client was
 * disposed (evicted). Framework-agnostic, InMemory, install-free.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness } from "./helpers.ts";
import {
  acquireClient,
  closeClient,
  registerConnectionDriver,
  resetConnectionRegistry,
  type ConnectionDriver
} from "../../../packages/external-connections/src/index.ts";

const ADMIN = { "x-actor-id": "admin", "x-roles": "platform_admin" };

async function createConnection(harness: ReturnType<typeof buildHarness>, kind: string) {
  const out = await harness.request({
    method: "POST",
    path: "/api/connections",
    headers: ADMIN,
    body: {
      scope: "global",
      slug: "probe-target",
      displayName: "probe-target",
      kind,
      config: { url: "http://remote.example:9200" }
    }
  });
  assert.equal(out.status, 201, `connection POST: ${JSON.stringify(out.body)}`);
  return out.body.connection as { id: string; slug: string; kind: string };
}

test("PUT /api/connections/:id evicts the pooled driver client (no stale reuse)", async (t) => {
  t.after(() => resetConnectionRegistry());
  resetConnectionRegistry();

  const kind = "invalidation-probe";
  let creates = 0;
  const disposed: string[] = [];
  const driver: ConnectionDriver<{ n: number }> = {
    async create() {
      return { n: ++creates };
    },
    async dispose() {
      disposed.push(kind);
    }
  };
  registerConnectionDriver(kind, driver);

  const harness = buildHarness();
  const conn = await createConnection(harness, kind);

  // Populate the pool exactly as a /probe or a real read would.
  const first = await acquireClient({
    id: conn.id,
    slug: conn.slug,
    kind,
    options: {},
    cascadeReason: "global"
  });
  assert.equal(creates, 1, "one build for the first acquire");

  // Operator edits the endpoint and saves.
  const put = await harness.request({
    method: "PUT",
    path: `/api/connections/${conn.id}`,
    headers: ADMIN,
    body: { config: { url: "http://localhost:9200" } }
  });
  assert.equal(put.status, 200, `PUT: ${JSON.stringify(put.body)}`);

  // The update must have disposed the cached client...
  assert.deepEqual(disposed, [kind], "update disposed the pooled client");

  // ...so the NEXT acquire rebuilds from the new config instead of reusing.
  const second = await acquireClient({
    id: conn.id,
    slug: conn.slug,
    kind,
    options: {},
    cascadeReason: "global"
  });
  assert.equal(creates, 2, "next acquire rebuilds (cache was evicted)");
  assert.notEqual(first, second, "a fresh client, not the stale cached one");
});

test("closeClient for an un-pooled connection is a harmless no-op (update never fails)", async (t) => {
  t.after(() => resetConnectionRegistry());
  resetConnectionRegistry();
  // No driver, nothing pooled — the route's best-effort closeClient must not throw.
  await assert.doesNotReject(() => closeClient("never-acquired"));
});
