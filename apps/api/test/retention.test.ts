/**
 * PATCH /api/retention/:resource — global retention caps used by the
 * sweep worker. Previously only the GET was incidentally hit by api.test;
 * the PATCH path had zero coverage.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildHarness } from "./helpers.ts";
import { PasswordService } from "../../../packages/auth/src/index.ts";

async function seedAdmin(h: ReturnType<typeof buildHarness>): Promise<Record<string, string>> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await h.deps.users!.create({
    id,
    email: `r-${randomUUID().slice(0, 6)}@x.io`,
    displayName: "r",
    passwordHash: await new PasswordService().hash("password123"),
    status: "active",
    createdAt: now,
    updatedAt: now
  });
  await h.deps.rbacPolicies!.addGrant({
    id: randomUUID(),
    userId: id,
    role: "platform_admin",
    scope: "*",
    createdAt: now
  });
  return {
    authorization: `Bearer ${h.sessions.sign({ id, type: "user", roles: [] }, 3600)}`
  };
}

test("PATCH /api/retention/executions sets maxCount + maxAgeDays", async () => {
  const h = buildHarness({ withAuth: true });
  const admin = await seedAdmin(h);
  const res = await h.request({
    method: "PATCH",
    path: "/api/retention/executions",
    headers: admin,
    body: { maxCount: 1000, maxAgeDays: 30 }
  });
  assert.equal(res.status, 200);
  // GET reflects the patch.
  const get = await h.request({
    method: "GET",
    path: "/api/retention",
    headers: admin
  });
  const exec = get.body.settings.find((s: { resource: string }) => s.resource === "executions");
  assert.equal(exec.maxCount, 1000);
  assert.equal(exec.maxAgeDays, 30);
});

test("PATCH /api/retention: null clears a cap, omitted preserves it", async () => {
  const h = buildHarness({ withAuth: true });
  const admin = await seedAdmin(h);
  // Set both.
  await h.request({
    method: "PATCH",
    path: "/api/retention/usage",
    headers: admin,
    body: { maxCount: 500, maxAgeDays: 90 }
  });
  // Clear maxCount only.
  await h.request({
    method: "PATCH",
    path: "/api/retention/usage",
    headers: admin,
    body: { maxCount: null }
  });
  const get = await h.request({
    method: "GET",
    path: "/api/retention",
    headers: admin
  });
  const usage = get.body.settings.find((s: { resource: string }) => s.resource === "usage");
  assert.equal(usage.maxCount, null);
  assert.equal(usage.maxAgeDays, 90);
});

test("PATCH /api/retention: unknown resource -> 404", async () => {
  const h = buildHarness({ withAuth: true });
  const admin = await seedAdmin(h);
  const res = await h.request({
    method: "PATCH",
    path: "/api/retention/something_else",
    headers: admin,
    body: { maxCount: 10 }
  });
  assert.equal(res.status, 404);
});

test("PATCH /api/retention: negative cap -> 422", async () => {
  const h = buildHarness({ withAuth: true });
  const admin = await seedAdmin(h);
  const res = await h.request({
    method: "PATCH",
    path: "/api/retention/audit",
    headers: admin,
    body: { maxCount: -5 }
  });
  assert.equal(res.status, 422);
});

test("PATCH /api/retention without config:edit_global -> 403", async () => {
  const h = buildHarness({ withAuth: true });
  const id = randomUUID();
  const now = new Date().toISOString();
  await h.deps.users!.create({
    id,
    email: `viewer-${randomUUID().slice(0, 6)}@x.io`,
    displayName: "v",
    passwordHash: await new PasswordService().hash("password123"),
    status: "active",
    createdAt: now,
    updatedAt: now
  });
  const token = h.sessions.sign({ id, type: "user", roles: [] }, 3600);
  const res = await h.request({
    method: "PATCH",
    path: "/api/retention/executions",
    headers: { authorization: `Bearer ${token}` },
    body: { maxCount: 100 }
  });
  assert.equal(res.status, 403);
});
