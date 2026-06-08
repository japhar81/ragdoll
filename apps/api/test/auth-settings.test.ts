/**
 * Coverage for GET/PUT /api/auth/settings — the singleton row that drives
 * SSO signup behaviour. Previously untested.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildHarness } from "./helpers.ts";
import { PasswordService } from "../../../packages/auth/src/index.ts";

async function seedUser(
  h: ReturnType<typeof buildHarness>,
  opts: { email: string; grants?: Array<{ role: string; scope: string }> }
): Promise<{ id: string; bearer: Record<string, string> }> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await h.deps.users!.create({
    id,
    email: opts.email,
    displayName: opts.email,
    passwordHash: await new PasswordService().hash("password123"),
    status: "active",
    createdAt: now,
    updatedAt: now
  });
  for (const g of opts.grants ?? []) {
    await h.deps.rbacPolicies!.addGrant({
      id: randomUUID(),
      userId: id,
      role: g.role,
      scope: g.scope,
      createdAt: now
    });
  }
  return {
    id,
    bearer: {
      authorization: `Bearer ${h.sessions.sign({ id, type: "user", roles: [] }, 3600)}`
    }
  };
}

test("GET /api/auth/settings returns the singleton", async () => {
  const h = buildHarness({ withAuth: true });
  const admin = await seedUser(h, {
    email: `a-${randomUUID().slice(0, 6)}@x.io`,
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const res = await h.request({
    method: "GET",
    path: "/api/auth/settings",
    headers: admin.bearer
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.settings);
  assert.ok(["admin_only", "open_default_role", "open_no_access"].includes(res.body.settings.signupMode));
});

test("PUT /api/auth/settings: valid signupMode persists + GET reflects it", async () => {
  const h = buildHarness({ withAuth: true });
  const admin = await seedUser(h, {
    email: `a-${randomUUID().slice(0, 6)}@x.io`,
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const put = await h.request({
    method: "PUT",
    path: "/api/auth/settings",
    headers: admin.bearer,
    body: { signupMode: "open_default_role", defaultRole: "viewer" }
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.settings.signupMode, "open_default_role");
  assert.equal(put.body.settings.defaultRole, "viewer");
  const get = await h.request({
    method: "GET",
    path: "/api/auth/settings",
    headers: admin.bearer
  });
  assert.equal(get.body.settings.signupMode, "open_default_role");
});

test("PUT /api/auth/settings: invalid signupMode -> 422", async () => {
  const h = buildHarness({ withAuth: true });
  const admin = await seedUser(h, {
    email: `a-${randomUUID().slice(0, 6)}@x.io`,
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const res = await h.request({
    method: "PUT",
    path: "/api/auth/settings",
    headers: admin.bearer,
    body: { signupMode: "wide_open" }
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, "validation_failed");
});

test("PUT /api/auth/settings without auth:settings permission -> 403", async () => {
  const h = buildHarness({ withAuth: true });
  // Seed a user with NO grants — should be denied.
  const viewer = await seedUser(h, {
    email: `v-${randomUUID().slice(0, 6)}@x.io`,
    grants: []
  });
  const res = await h.request({
    method: "PUT",
    path: "/api/auth/settings",
    headers: viewer.bearer,
    body: { signupMode: "admin_only" }
  });
  assert.equal(res.status, 403);
});
