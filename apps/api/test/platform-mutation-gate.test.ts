/**
 * The central mutation PRE-gate (ADR 0036): a platform-plugin `before`
 * interceptor wired via the dispatcher vetoes a catalogued mutation route
 * BEFORE the handler runs, returning 4xx. Proves the router-level gate +
 * mutation-catalog mapping, without per-route wiring.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness } from "./helpers.ts";
import {
  PlatformEventDispatcher,
  PlatformPluginRegistry
} from "../../../packages/platform-plugins/src/index.ts";

const ADMIN = { "x-actor-id": "admin", "x-roles": "platform_admin" };

function denyDispatcher(denyEvents: string[]): PlatformEventDispatcher {
  const reg = new PlatformPluginRegistry();
  reg.register({
    name: "policy",
    subscriptions: [{ events: denyEvents, phases: ["pre"] }],
    before: (event) => ({
      action: "deny",
      reason: `blocked ${event.event}`,
      status: 451
    })
  });
  return new PlatformEventDispatcher(reg);
}

test("mutation gate vetoes a catalogued mutation (tenant.create) with the hook's status", async () => {
  const harness = buildHarness({ platformDispatcher: denyDispatcher(["tenant.create"]) });
  const res = await harness.request({
    method: "POST",
    path: "/api/tenants",
    headers: ADMIN,
    body: { slug: "blocked-co", name: "Blocked Co" }
  });
  assert.equal(res.status, 451);
  assert.equal(res.body.error, "blocked_by_platform_plugin");
  assert.match(res.body.message, /blocked tenant\.create/);
});

test("mutation gate lets a non-matching mutation through", async () => {
  const harness = buildHarness({ platformDispatcher: denyDispatcher(["secret.delete"]) });
  // secret.delete is denied, but creating a tenant is not → succeeds.
  const res = await harness.request({
    method: "POST",
    path: "/api/tenants",
    headers: ADMIN,
    body: { slug: "allowed-co", name: "Allowed Co" }
  });
  assert.equal(res.status, 201);
});

test("a glob subscription (pipeline.*) gates every pipeline mutation", async () => {
  const harness = buildHarness({ platformDispatcher: denyDispatcher(["pipeline.*"]) });
  const res = await harness.request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "p1", name: "p1" }
  });
  assert.equal(res.status, 451);
  assert.match(res.body.message, /pipeline\.create/);
});
