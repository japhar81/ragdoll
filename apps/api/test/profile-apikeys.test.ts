/**
 * Self-service profile + API key management through the real `createApp`
 * router with the full auth stack wired (sessions, Authorizer, default-deny).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildHarness } from "./helpers.ts";
import { PasswordService } from "../../../packages/auth/src/index.ts";

/** Insert a user + grants directly and return a Bearer header for it. */
async function seedUser(
  h: ReturnType<typeof buildHarness>,
  opts: {
    email: string;
    password?: string;
    grants?: Array<{ role: string; scope: string }>;
  }
): Promise<{ id: string; bearer: Record<string, string> }> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await h.deps.users!.create({
    id,
    email: opts.email,
    displayName: opts.email,
    passwordHash: opts.password
      ? await new PasswordService().hash(opts.password)
      : null,
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
  const token = h.sessions.sign({ id, type: "user", roles: [] }, 3600);
  return { id, bearer: { authorization: `Bearer ${token}` } };
}

// --- API keys: issue / list / authenticate ---------------------------------

test("a user issues an API key, lists it, and the key authenticates", async () => {
  const h = buildHarness({ withAuth: true });
  const { bearer } = await seedUser(h, {
    email: "admin@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });

  const created = await h.request({
    method: "POST",
    path: "/api/api-keys",
    headers: bearer,
    body: { name: "local MCP", role: "platform_admin" }
  });
  assert.equal(created.status, 201);
  const plaintext: string = created.body.plaintext;
  assert.match(plaintext, /^rgd_[0-9a-f]+_[0-9a-f]+$/);
  assert.equal(created.body.apiKey.status, "active");
  assert.equal(created.body.apiKey.scope, "*");
  // The hash is never exposed.
  assert.equal(created.body.apiKey.hash, undefined);

  const listed = await h.request({
    method: "GET",
    path: "/api/api-keys",
    headers: bearer
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.apiKeys.length, 1);
  assert.equal(listed.body.apiKeys[0].name, "local MCP");

  // The plaintext key authenticates as an api_key principal with the role.
  const me = await h.request({
    method: "GET",
    path: "/api/auth/me",
    headers: { authorization: `ApiKey ${plaintext}` }
  });
  assert.equal(me.status, 200);
  assert.equal(me.body.principal.type, "api_key");

  // ...and that principal can actually act.
  const tenants = await h.request({
    method: "GET",
    path: "/api/tenants",
    headers: { "x-api-key": plaintext }
  });
  assert.equal(tenants.status, 200);
});

test("an API key cannot exceed its issuer's authority", async () => {
  const h = buildHarness({ withAuth: true });
  // A viewer holds only execution:view_logs.
  const { bearer } = await seedUser(h, {
    email: "viewer@x.io",
    grants: [{ role: "viewer", scope: "*" }]
  });

  // Minting a platform_admin key is refused (the viewer lacks those perms).
  const escalate = await h.request({
    method: "POST",
    path: "/api/api-keys",
    headers: bearer,
    body: { name: "too powerful", role: "platform_admin" }
  });
  assert.equal(escalate.status, 403);

  // Minting a key with a role they DO hold is allowed.
  const ok = await h.request({
    method: "POST",
    path: "/api/api-keys",
    headers: bearer,
    body: { name: "fine", role: "viewer" }
  });
  assert.equal(ok.status, 201);
});

test("a revoked API key stops authenticating", async () => {
  const h = buildHarness({ withAuth: true });
  const { bearer } = await seedUser(h, {
    email: "admin@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const created = await h.request({
    method: "POST",
    path: "/api/api-keys",
    headers: bearer,
    body: { name: "throwaway", role: "platform_admin" }
  });
  const plaintext: string = created.body.plaintext;
  const id: string = created.body.apiKey.id;

  const del = await h.request({
    method: "DELETE",
    path: `/api/api-keys/${id}`,
    headers: bearer
  });
  assert.equal(del.status, 204);

  const me = await h.request({
    method: "GET",
    path: "/api/auth/me",
    headers: { "x-api-key": plaintext }
  });
  assert.equal(me.status, 401);

  const listed = await h.request({
    method: "GET",
    path: "/api/api-keys",
    headers: bearer
  });
  assert.equal(listed.body.apiKeys[0].status, "revoked");
});

test("a user sees and revokes only their own keys", async () => {
  const h = buildHarness({ withAuth: true });
  const alice = await seedUser(h, {
    email: "alice@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const bob = await seedUser(h, {
    email: "bob@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });

  const aliceKey = await h.request({
    method: "POST",
    path: "/api/api-keys",
    headers: alice.bearer,
    body: { name: "alice key", role: "platform_admin" }
  });
  const aliceKeyId: string = aliceKey.body.apiKey.id;

  // Bob's list does not include Alice's key.
  const bobList = await h.request({
    method: "GET",
    path: "/api/api-keys",
    headers: bob.bearer
  });
  assert.equal(bobList.body.apiKeys.length, 0);

  // Bob cannot revoke Alice's key.
  const bobRevoke = await h.request({
    method: "DELETE",
    path: `/api/api-keys/${aliceKeyId}`,
    headers: bob.bearer
  });
  assert.equal(bobRevoke.status, 404);
});

// --- self-service profile --------------------------------------------------

test("a user updates their own display name", async () => {
  const h = buildHarness({ withAuth: true });
  const { id, bearer } = await seedUser(h, {
    email: "admin@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const res = await h.request({
    method: "PATCH",
    path: "/api/auth/me",
    headers: bearer,
    body: { displayName: "Renamed Admin" }
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.displayName, "Renamed Admin");
  const stored = await h.deps.users!.get(id);
  assert.equal(stored?.displayName, "Renamed Admin");
});

test("password change requires the correct current password", async () => {
  const h = buildHarness({ withAuth: true });
  const { bearer } = await seedUser(h, {
    email: "admin@x.io",
    password: "originalpass1",
    grants: [{ role: "platform_admin", scope: "*" }]
  });

  // Wrong current password is refused.
  const wrong = await h.request({
    method: "POST",
    path: "/api/auth/password",
    headers: bearer,
    body: { currentPassword: "nope", newPassword: "brandnewpass1" }
  });
  assert.equal(wrong.status, 403);

  // Correct current password succeeds...
  const ok = await h.request({
    method: "POST",
    path: "/api/auth/password",
    headers: bearer,
    body: { currentPassword: "originalpass1", newPassword: "brandnewpass1" }
  });
  assert.equal(ok.status, 200);

  // ...and the new password now logs in.
  const login = await h.request({
    method: "POST",
    path: "/api/auth/login",
    body: { email: "admin@x.io", password: "brandnewpass1" }
  });
  assert.equal(login.status, 200);
  assert.ok(login.body.token);
});

test("password change rejects a too-short new password", async () => {
  const h = buildHarness({ withAuth: true });
  const { bearer } = await seedUser(h, {
    email: "admin@x.io",
    password: "originalpass1",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const res = await h.request({
    method: "POST",
    path: "/api/auth/password",
    headers: bearer,
    body: { currentPassword: "originalpass1", newPassword: "short" }
  });
  assert.equal(res.status, 422);
});
