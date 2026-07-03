/**
 * Webhook-delivery platform plugin (ADR 0036 Phase 1c): matching (event glob +
 * phase + tenant scope) and signed delivery.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  webhookDeliveryPlugin,
  gateWebhookPlugin,
  deliverToSubscription
} from "../src/platform-webhooks.ts";
import {
  InMemoryEventSubscriptionRepository,
  InMemoryWebhookDeliveryFailureRepository
} from "../../../packages/db/src/index.ts";
import type { MutationEvent } from "../../../packages/platform-plugins/src/index.ts";

function captureServer(): Promise<{
  url: string;
  received: Array<{ body: string; sig?: string; event?: string }>;
  close: () => Promise<void>;
}> {
  const received: Array<{ body: string; sig?: string; event?: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({
        body: Buffer.concat(chunks).toString("utf8"),
        sig: req.headers["x-ragdoll-signature"] as string | undefined,
        event: req.headers["x-ragdoll-event"] as string | undefined
      });
      res.writeHead(200);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        received,
        close: () => new Promise<void>((d) => server.close(() => d()))
      });
    });
  });
}

function mutation(event: string, tenantId: string | null): MutationEvent {
  return {
    id: "m1",
    correlationId: "r1",
    event,
    phase: "post",
    category: "mutation",
    at: "2026-01-01T00:00:00Z",
    actor: { id: "admin" },
    tenantId,
    target: { type: "secret", id: "s1" },
    after: { ref: "x" }
  };
}

test("delivers a matching event to a subscribed URL, HMAC-signed", async () => {
  const srv = await captureServer();
  const repo = new InMemoryEventSubscriptionRepository();
  await repo.create({
    id: "sub1",
    tenantId: "t1",
    events: ["secret.*"],
    phases: ["post"],
    url: srv.url,
    secret: "topsecret",
    active: true,
    createdAt: "x",
    updatedAt: "x"
  });
  const plugin = webhookDeliveryPlugin(repo);
  try {
    await plugin.on!(mutation("secret.delete", "t1"), {});
    assert.equal(srv.received.length, 1);
    const got = srv.received[0];
    assert.equal(got.event, "secret.delete");
    // signature = sha256=HMAC(secret, body)
    const expected =
      "sha256=" + createHmac("sha256", "topsecret").update(got.body).digest("hex");
    assert.equal(got.sig, expected);
    assert.equal(JSON.parse(got.body).event, "secret.delete");
  } finally {
    await srv.close();
  }
});

test("does not deliver a non-matching event or another tenant's event", async () => {
  const srv = await captureServer();
  const repo = new InMemoryEventSubscriptionRepository();
  await repo.create({
    id: "sub1",
    tenantId: "t1",
    events: ["secret.*"],
    phases: ["post"],
    url: srv.url,
    secret: null,
    active: true,
    createdAt: "x",
    updatedAt: "x"
  });
  const plugin = webhookDeliveryPlugin(repo);
  try {
    await plugin.on!(mutation("pipeline.deploy", "t1"), {}); // wrong event
    await plugin.on!(mutation("secret.delete", "t2"), {}); // wrong tenant
    assert.equal(srv.received.length, 0);
  } finally {
    await srv.close();
  }
});

// ---- DLQ (dead-letter + replay) ------------------------------------------

test("a delivery that exhausts retries is captured in the DLQ", async () => {
  const repo = new InMemoryEventSubscriptionRepository();
  const dlq = new InMemoryWebhookDeliveryFailureRepository();
  await repo.create({
    id: "sub1",
    tenantId: "t1",
    events: ["secret.*"],
    phases: ["post"],
    url: "http://127.0.0.1:9/hook", // discard port → connection refused
    secret: null,
    active: true,
    createdAt: "x",
    updatedAt: "x"
  });
  await webhookDeliveryPlugin(repo, undefined, dlq).on!(
    mutation("secret.delete", "t1"),
    {}
  );
  const failures = await dlq.listByTenant("t1");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].eventName, "secret.delete");
  assert.equal(failures[0].subscriptionId, "sub1");
  assert.ok(failures[0].attempts >= 1);
  assert.ok(failures[0].lastError);
});

test("deliverToSubscription (replay path) succeeds against a 2xx target", async () => {
  const srv = await captureServer();
  try {
    const result = await deliverToSubscription(
      { url: srv.url, secret: "k" },
      mutation("secret.delete", "t1")
    );
    assert.equal(result.ok, true);
    assert.equal(srv.received.length, 1);
  } finally {
    await srv.close();
  }
});

// ---- gate webhooks (synchronous pre) -------------------------------------

function gateServer(
  respond: (req: http.IncomingMessage) => { status: number; body?: unknown }
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const { status, body } = respond(req);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/gate`,
        close: () => new Promise<void>((d) => server.close(() => d()))
      });
    });
  });
}

function gateSub(url: string) {
  return {
    id: "g1",
    tenantId: "t1" as string | null,
    events: ["secret.*"],
    phases: ["pre"],
    url,
    secret: null,
    active: true,
    createdAt: "x",
    updatedAt: "x"
  };
}

test("gate webhook returning {allow:false} vetoes (deny)", async () => {
  const srv = await gateServer(() => ({
    status: 200,
    body: { allow: false, reason: "policy says no" }
  }));
  const repo = new InMemoryEventSubscriptionRepository();
  await repo.create(gateSub(srv.url));
  try {
    const decision = await gateWebhookPlugin(repo).before!(
      { ...mutation("secret.delete", "t1"), phase: "pre" },
      {}
    );
    assert.equal(decision.action, "deny");
    assert.match((decision as { reason: string }).reason, /policy says no/);
  } finally {
    await srv.close();
  }
});

test("gate webhook returning {allow:true} continues", async () => {
  const srv = await gateServer(() => ({ status: 200, body: { allow: true } }));
  const repo = new InMemoryEventSubscriptionRepository();
  await repo.create(gateSub(srv.url));
  try {
    const decision = await gateWebhookPlugin(repo).before!(
      { ...mutation("secret.delete", "t1"), phase: "pre" },
      {}
    );
    assert.equal(decision.action, "continue");
  } finally {
    await srv.close();
  }
});

test("gate webhook that errors (5xx) is fail-open (continue)", async () => {
  const srv = await gateServer(() => ({ status: 500 }));
  const repo = new InMemoryEventSubscriptionRepository();
  await repo.create(gateSub(srv.url));
  try {
    const decision = await gateWebhookPlugin(repo).before!(
      { ...mutation("secret.delete", "t1"), phase: "pre" },
      {}
    );
    assert.equal(decision.action, "continue");
  } finally {
    await srv.close();
  }
});

test("no matching gate subscription → continue", async () => {
  const repo = new InMemoryEventSubscriptionRepository();
  const decision = await gateWebhookPlugin(repo).before!(
    { ...mutation("secret.delete", "t1"), phase: "pre" },
    {}
  );
  assert.equal(decision.action, "continue");
});

test("a platform-scoped (tenantId null) subscription receives every tenant's events", async () => {
  const srv = await captureServer();
  const repo = new InMemoryEventSubscriptionRepository();
  await repo.create({
    id: "plat",
    tenantId: null,
    events: ["*"],
    phases: ["post"],
    url: srv.url,
    secret: null,
    active: true,
    createdAt: "x",
    updatedAt: "x"
  });
  const plugin = webhookDeliveryPlugin(repo);
  try {
    await plugin.on!(mutation("secret.delete", "t1"), {});
    assert.equal(srv.received.length, 1);
  } finally {
    await srv.close();
  }
});
