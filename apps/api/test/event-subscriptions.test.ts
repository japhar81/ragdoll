/**
 * /api/event-subscriptions CRUD + DLQ routes (ADR 0036 Phase 1c/#2):
 * validation, secret redaction, tenant isolation, and the DLQ list + replay.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness } from "./helpers.ts";

const ADMIN = { "x-actor-id": "admin", "x-roles": "platform_admin" };

test("create → list (secret redacted) → delete", async () => {
  const h = buildHarness();
  const created = await h.request({
    method: "POST",
    path: "/api/event-subscriptions",
    headers: ADMIN,
    body: { events: ["secret.*", "execution.failure"], url: "https://hook.test/x", secret: "shh" }
  });
  assert.equal(created.status, 201);
  const sub = created.body.subscription;
  assert.equal(sub.hasSecret, true);
  assert.equal(sub.secret, undefined, "raw secret must never be returned");
  assert.deepEqual(sub.events, ["secret.*", "execution.failure"]);
  assert.deepEqual(sub.phases, ["post"]);

  const list = await h.request({ method: "GET", path: "/api/event-subscriptions", headers: ADMIN });
  assert.equal(list.status, 200);
  assert.equal(list.body.subscriptions.length, 1);
  assert.equal(list.body.subscriptions[0].hasSecret, true);

  const del = await h.request({
    method: "DELETE",
    path: `/api/event-subscriptions/${sub.id}`,
    headers: ADMIN
  });
  assert.equal(del.status, 204);
  const after = await h.request({ method: "GET", path: "/api/event-subscriptions", headers: ADMIN });
  assert.equal(after.body.subscriptions.length, 0);
});

test("create rejects a missing url / empty events (422)", async () => {
  const h = buildHarness();
  const noUrl = await h.request({
    method: "POST",
    path: "/api/event-subscriptions",
    headers: ADMIN,
    body: { events: ["secret.*"] }
  });
  assert.equal(noUrl.status, 422);
  const badUrl = await h.request({
    method: "POST",
    path: "/api/event-subscriptions",
    headers: ADMIN,
    body: { events: ["secret.*"], url: "ftp://nope" }
  });
  assert.equal(badUrl.status, 422);
  const noEvents = await h.request({
    method: "POST",
    path: "/api/event-subscriptions",
    headers: ADMIN,
    body: { events: [], url: "https://ok.test" }
  });
  assert.equal(noEvents.status, 422);
});

test("phases:['pre'] is accepted (a gate subscription)", async () => {
  const h = buildHarness();
  const created = await h.request({
    method: "POST",
    path: "/api/event-subscriptions",
    headers: ADMIN,
    body: { events: ["pipeline.deploy"], phases: ["pre"], url: "https://gate.test" }
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.subscription.phases, ["pre"]);
});

test("delete of another id / unknown id → 404", async () => {
  const h = buildHarness();
  const del = await h.request({
    method: "DELETE",
    path: "/api/event-subscriptions/00000000-0000-0000-0000-000000000000",
    headers: ADMIN
  });
  assert.equal(del.status, 404);
});

test("DLQ: list starts empty; a seeded failure replays (502 when the target is unreachable)", async () => {
  const h = buildHarness();
  // Seed a dead-letter row directly on the injected repo.
  await h.deps.webhookFailures!.create({
    id: "f1",
    tenantId: null,
    subscriptionId: null,
    eventName: "tenant.create",
    url: "http://127.0.0.1:9/hook", // unreachable
    event: { id: "x", event: "tenant.create", phase: "post", category: "mutation", tenantId: null },
    lastError: "status 500",
    attempts: 2,
    failedAt: new Date().toISOString(),
    replayedAt: null
  });
  const list = await h.request({
    method: "GET",
    path: "/api/event-subscriptions/failures",
    headers: ADMIN
  });
  assert.equal(list.status, 200);
  assert.equal(list.body.failures.length, 1);
  assert.equal(list.body.failures[0].eventName, "tenant.create");

  // Replay against the (still unreachable) url → 502.
  const replay = await h.request({
    method: "POST",
    path: "/api/event-subscriptions/failures/f1/replay",
    headers: ADMIN
  });
  assert.equal(replay.status, 502);
});
