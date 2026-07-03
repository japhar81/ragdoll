/**
 * Webhook-delivery platform plugin (ADR 0036 Phase 1c): matching (event glob +
 * phase + tenant scope) and signed delivery.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { webhookDeliveryPlugin } from "../src/platform-webhooks.ts";
import { InMemoryEventSubscriptionRepository } from "../../../packages/db/src/index.ts";
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
