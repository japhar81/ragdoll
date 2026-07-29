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
import {
  decideRedelivery,
  withNatsAuth,
  connectNats,
  RetryableLazy,
  type NatsTransportLike
} from "../src/nats.ts";

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

// ---------------------------------------------------------------------------
// withNatsAuth — env credentials → connect options
// ---------------------------------------------------------------------------

test("withNatsAuth: NATS_USER + NATS_PASSWORD layer onto the base options", () => {
  const opts = withNatsAuth(
    { servers: "nats://h:4222", name: "x" },
    { NATS_USER: "svc", NATS_PASSWORD: "s3cr3t" }
  );
  assert.equal(opts.user, "svc");
  assert.equal(opts.pass, "s3cr3t");
  assert.equal(opts.servers, "nats://h:4222"); // base preserved
});

test("withNatsAuth: NATS_TOKEN maps to token", () => {
  const opts = withNatsAuth({}, { NATS_TOKEN: "tok123" });
  assert.equal(opts.token, "tok123");
  assert.equal(opts.user, undefined);
});

test("withNatsAuth: no credentials → base is unchanged (anonymous)", () => {
  const opts = withNatsAuth({ servers: "nats://h:4222" }, {});
  assert.deepEqual(opts, { servers: "nats://h:4222" });
});

test("withNatsAuth: username is trimmed, password is NOT (may contain spaces)", () => {
  const opts = withNatsAuth({}, { NATS_USER: "  svc  ", NATS_PASSWORD: "  pw " });
  assert.equal(opts.user, "svc");
  assert.equal(opts.pass, "  pw "); // preserved verbatim
});

test("withNatsAuth: an empty-string password still sets pass when the user is set", () => {
  const opts = withNatsAuth({}, { NATS_USER: "svc", NATS_PASSWORD: "" });
  assert.equal(opts.user, "svc");
  assert.equal(opts.pass, ""); // present-but-empty is honored (not dropped)
});

// ---------------------------------------------------------------------------
// connectNats — passes creds through, logs + rethrows on failure
// ---------------------------------------------------------------------------

test("connectNats: passes env credentials to transport.connect", async () => {
  let seen: Record<string, unknown> | undefined;
  const transport: NatsTransportLike = {
    connect: async (opts) => {
      seen = opts;
      return { fake: "nc" };
    }
  };
  const nc = await connectNats(
    transport,
    { servers: "nats://h:4222", name: "ragdoll-producer" },
    { env: { NATS_USER: "svc", NATS_PASSWORD: "pw" } }
  );
  assert.deepEqual(nc, { fake: "nc" });
  assert.equal(seen?.user, "svc");
  assert.equal(seen?.pass, "pw");
  assert.equal(seen?.name, "ragdoll-producer");
});

test("connectNats: on failure logs nats_connect_failed with the reason, then rethrows", async () => {
  const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const transport: NatsTransportLike = {
    connect: async () => {
      throw new Error("AUTHORIZATION_VIOLATION");
    }
  };
  const logger = {
    warn: (msg: string, fields?: Record<string, unknown>) => logs.push({ msg, fields })
  } as never;
  await assert.rejects(
    () => connectNats(transport, { servers: "nats://h:4222", name: "ragdoll-consumer" }, { logger, env: {} }),
    /AUTHORIZATION_VIOLATION/
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0].msg, "nats_connect_failed");
  assert.equal(logs[0].fields?.client, "ragdoll-consumer");
  assert.match(String(logs[0].fields?.error), /AUTHORIZATION_VIOLATION/);
});

test("connectNats: NATS_CREDS resolves an authenticator from the creds file", async () => {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "creds-"));
  const path = join(dir, "u.creds");
  writeFileSync(path, "-----BEGIN NATS USER JWT-----\nfake\n------END NATS USER JWT------\n");
  let seen: Record<string, unknown> | undefined;
  const transport: NatsTransportLike = {
    connect: async (opts) => {
      seen = opts;
      return {};
    },
    credsAuthenticator: (bytes) => ({ authFromCreds: bytes.byteLength })
  };
  await connectNats(transport, { servers: "nats://h:4222", name: "x" }, { env: { NATS_CREDS: path } });
  assert.ok(seen?.authenticator, "authenticator was set from the creds file");
});

// ---------------------------------------------------------------------------
// RetryableLazy — self-heals on rejection (the /readyz wedge fix)
// ---------------------------------------------------------------------------

test("RetryableLazy: caches a successful value (factory runs once)", async () => {
  let calls = 0;
  const lazy = new RetryableLazy(async () => ++calls);
  assert.equal(await lazy.get(), 1);
  assert.equal(await lazy.get(), 1);
  assert.equal(calls, 1);
});

test("RetryableLazy: a rejection is NOT cached — the next get() retries", async () => {
  let calls = 0;
  const lazy = new RetryableLazy(async () => {
    calls += 1;
    if (calls === 1) throw new Error("nats down");
    return "connected";
  });
  await assert.rejects(() => lazy.get(), /nats down/);
  // Without the self-heal this would replay the cached rejection forever.
  assert.equal(await lazy.get(), "connected");
  assert.equal(calls, 2);
});

test("RetryableLazy: concurrent get()s during one in-flight attempt share it", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const lazy = new RetryableLazy(async () => {
    calls += 1;
    await gate;
    return "v";
  });
  const all = Promise.all([lazy.get(), lazy.get(), lazy.get()]);
  release();
  assert.deepEqual(await all, ["v", "v", "v"]);
  assert.equal(calls, 1);
});
