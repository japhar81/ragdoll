/**
 * The whole failover fix is the `reconnectOnError` predicate + it being wired
 * into the client. Both are pinned here. No Redis server is contacted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { reconnectOnError, createRedisClient } from "../src/index.ts";

test("reconnectOnError: a READONLY replica error triggers reconnect + resend (2)", () => {
  // The exact error Valkey returns to a write against a demoted primary.
  assert.equal(
    reconnectOnError(new Error("READONLY You can't write against a read only replica.")),
    2
  );
  // Case-insensitive (defensive against wording changes).
  assert.equal(reconnectOnError(new Error("-readonly")), 2);
});

test("reconnectOnError: every other error is left to ioredis's retry strategy (0)", () => {
  assert.equal(reconnectOnError(new Error("ETIMEDOUT")), 0);
  assert.equal(reconnectOnError(new Error("MOVED 1234 10.0.0.1:6379")), 0);
  assert.equal(reconnectOnError(new Error("ECONNREFUSED")), 0);
  assert.equal(reconnectOnError(new Error("")), 0);
});

test("reconnectOnError: tolerates a message-less error", () => {
  assert.equal(reconnectOnError({} as Error), 0);
});

test("createRedisClient actually wires reconnectOnError onto the client", async () => {
  // connect:false + lazyConnect means no socket is opened.
  const client = (await createRedisClient("redis://127.0.0.1:6379", { connect: false })) as {
    options: { reconnectOnError?: unknown; lazyConnect?: boolean };
    disconnect?: () => void;
  };
  try {
    assert.equal(
      client.options.reconnectOnError,
      reconnectOnError,
      "the client must carry our READONLY-recovery handler, or the fix does nothing"
    );
    assert.equal(client.options.lazyConnect, true);
  } finally {
    client.disconnect?.();
  }
});
