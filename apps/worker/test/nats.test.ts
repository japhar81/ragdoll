/**
 * Unit tests for the NATS JetStream queue's BullMQ-parity retry policy.
 *
 * `decideRedelivery` is the pure core of the consumer's failure handling —
 * it decides term (give up, dead-letter) vs nak-with-backoff from the
 * per-job `attempts` budget and the 1-based delivery count. Testing it in
 * isolation pins the parity with BullMQ's "N attempts + exponential backoff,
 * then move-to-failed" without needing a live NATS server. Importing nats.ts
 * loads nothing heavy: its non-type imports are all lazy (inside methods).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideRedelivery } from "../src/nats.ts";

test("decideRedelivery: run_pipeline parity (attempts:1) terminates on first failure — never re-executes", () => {
  const d = decideRedelivery({ attempts: 1, deliveryCount: 1, backoffMs: 1000 });
  assert.equal(d.action, "term");
  assert.equal(d.delayMs, undefined);
});

test("decideRedelivery: default 3 attempts → nak with exponential backoff, then term on the last", () => {
  // 1st failure → retry after backoffMs
  assert.deepEqual(decideRedelivery({ attempts: 3, deliveryCount: 1, backoffMs: 1000 }), {
    action: "nak",
    delayMs: 1000
  });
  // 2nd failure → retry after 2× backoff
  assert.deepEqual(decideRedelivery({ attempts: 3, deliveryCount: 2, backoffMs: 1000 }), {
    action: "nak",
    delayMs: 2000
  });
  // 3rd failure → delivery count reached the budget → terminal (dead-letter)
  assert.deepEqual(decideRedelivery({ attempts: 3, deliveryCount: 3, backoffMs: 1000 }), {
    action: "term"
  });
});

test("decideRedelivery: backoff scales off the configured base (exponential 2^(n-1))", () => {
  assert.equal(
    decideRedelivery({ attempts: 5, deliveryCount: 1, backoffMs: 500 }).delayMs,
    500
  );
  assert.equal(
    decideRedelivery({ attempts: 5, deliveryCount: 3, backoffMs: 500 }).delayMs,
    2000 // 500 * 2^2
  );
});

test("decideRedelivery: a delivery count past the budget still terminates (no negative/loop)", () => {
  const d = decideRedelivery({ attempts: 2, deliveryCount: 9, backoffMs: 1000 });
  assert.equal(d.action, "term");
});
