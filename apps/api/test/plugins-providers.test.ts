/**
 * Coverage for the plugin + provider catalog routes
 * (apps/api/src/app/routes/plugins-providers.ts). The plugin manifests
 * surfaced here drive the Builder's palette; this test pins their shape.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildHarness } from "./helpers.ts";
import { PasswordService } from "../../../packages/auth/src/index.ts";

async function seedAuth(h: ReturnType<typeof buildHarness>): Promise<Record<string, string>> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await h.deps.users!.create({
    id,
    email: `user-${randomUUID().slice(0, 6)}@x.io`,
    displayName: "u",
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

test("GET /api/plugins returns the harness echo plugin manifest", async () => {
  const h = buildHarness({ withAuth: true });
  const auth = await seedAuth(h);
  const res = await h.request({ method: "GET", path: "/api/plugins", headers: auth });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.plugins));
  // The harness registers a fake_echo plugin by default — see helpers.ts.
  const echo = res.body.plugins.find((p: { id: string }) => p.id === "fake_echo");
  assert.ok(echo, "fake_echo plugin should be in the catalog");
  assert.ok(echo.name);
  assert.ok(echo.category);
});

test("GET /api/plugins/:category/:id/:version 404s for unknown id", async () => {
  const h = buildHarness({ withAuth: true });
  const auth = await seedAuth(h);
  const res = await h.request({
    method: "GET",
    path: "/api/plugins/transform/does_not_exist/1.0.0",
    headers: auth
  });
  assert.equal(res.status, 404);
});

test("GET /api/plugins/:id/docs returns 404 for plugin without doc file", async () => {
  const h = buildHarness({ withAuth: true });
  const auth = await seedAuth(h);
  // The harness fake_echo plugin has no markdown doc file.
  const res = await h.request({
    method: "GET",
    path: "/api/plugins/fake_echo/docs",
    headers: auth
  });
  assert.equal(res.status, 404);
});

test("GET /api/plugins/:id/docs rejects path traversal attempts", async () => {
  const h = buildHarness({ withAuth: true });
  const auth = await seedAuth(h);
  // Any non-[a-z0-9_]+ id must 404 before touching the filesystem.
  const res = await h.request({
    method: "GET",
    path: "/api/plugins/..%2Fetc%2Fpasswd/docs",
    headers: auth
  });
  assert.equal(res.status, 404);
});

test("GET /api/providers lists registered model-provider adapters", async () => {
  const h = buildHarness({ withAuth: true });
  const auth = await seedAuth(h);
  const res = await h.request({ method: "GET", path: "/api/providers", headers: auth });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.providers));
});

test("GET /api/providers/:id/models 404s for unknown provider id", async () => {
  const h = buildHarness({ withAuth: true });
  const auth = await seedAuth(h);
  const res = await h.request({
    method: "GET",
    path: "/api/providers/not-a-real-provider/models",
    headers: auth
  });
  assert.equal(res.status, 404);
});
