/**
 * Dedicated coverage for the pipeline-folder CRUD endpoints
 * (/api/folders, POST/PUT/DELETE). Previously only exercised incidentally
 * via org-versioning / mcp / pipeline-bindings tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildHarness } from "./helpers.ts";
import { PasswordService } from "../../../packages/auth/src/index.ts";

async function seedUser(
  h: ReturnType<typeof buildHarness>,
  opts: { email: string; grants: Array<{ role: string; scope: string }> }
): Promise<Record<string, string>> {
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
  for (const g of opts.grants) {
    await h.deps.rbacPolicies!.addGrant({
      id: randomUUID(),
      userId: id,
      role: g.role,
      scope: g.scope,
      createdAt: now
    });
  }
  return {
    authorization: `Bearer ${h.sessions.sign({ id, type: "user", roles: [] }, 3600)}`
  };
}

test("GET /api/folders returns the tree (empty initially)", async () => {
  const h = buildHarness({ withAuth: true });
  const admin = await seedUser(h, {
    email: `a-${randomUUID().slice(0, 6)}@x.io`,
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const res = await h.request({
    method: "GET",
    path: "/api/folders",
    headers: admin
  });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.folders));
});

test("POST /api/folders creates a root folder", async () => {
  const h = buildHarness({ withAuth: true });
  const admin = await seedUser(h, {
    email: `a-${randomUUID().slice(0, 6)}@x.io`,
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const res = await h.request({
    method: "POST",
    path: "/api/folders",
    headers: admin,
    body: { name: "Workflows" }
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.folder.name, "Workflows");
  assert.equal(res.body.folder.parentId, null);
});

test("POST /api/folders: empty name -> 422", async () => {
  const h = buildHarness({ withAuth: true });
  const admin = await seedUser(h, {
    email: `a-${randomUUID().slice(0, 6)}@x.io`,
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const res = await h.request({
    method: "POST",
    path: "/api/folders",
    headers: admin,
    body: { name: "" }
  });
  assert.equal(res.status, 422);
});

test("POST /api/folders with bad parentId -> 404", async () => {
  const h = buildHarness({ withAuth: true });
  const admin = await seedUser(h, {
    email: `a-${randomUUID().slice(0, 6)}@x.io`,
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const res = await h.request({
    method: "POST",
    path: "/api/folders",
    headers: admin,
    body: { name: "Child", parentId: randomUUID() }
  });
  assert.equal(res.status, 404);
});

test("PUT /api/folders/:id renames + moves between parents", async () => {
  const h = buildHarness({ withAuth: true });
  const admin = await seedUser(h, {
    email: `a-${randomUUID().slice(0, 6)}@x.io`,
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const a = await h.request({
    method: "POST",
    path: "/api/folders",
    headers: admin,
    body: { name: "A" }
  });
  const b = await h.request({
    method: "POST",
    path: "/api/folders",
    headers: admin,
    body: { name: "B" }
  });
  const child = await h.request({
    method: "POST",
    path: "/api/folders",
    headers: admin,
    body: { name: "Child", parentId: a.body.folder.id }
  });
  // Rename + move to B in one PUT.
  const moved = await h.request({
    method: "PUT",
    path: `/api/folders/${child.body.folder.id}`,
    headers: admin,
    body: { name: "ChildRenamed", parentId: b.body.folder.id }
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.folder.name, "ChildRenamed");
  assert.equal(moved.body.folder.parentId, b.body.folder.id);
});

test("PUT /api/folders/:id rejects self as parent -> 422", async () => {
  const h = buildHarness({ withAuth: true });
  const admin = await seedUser(h, {
    email: `a-${randomUUID().slice(0, 6)}@x.io`,
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const f = await h.request({
    method: "POST",
    path: "/api/folders",
    headers: admin,
    body: { name: "F" }
  });
  const res = await h.request({
    method: "PUT",
    path: `/api/folders/${f.body.folder.id}`,
    headers: admin,
    body: { parentId: f.body.folder.id }
  });
  assert.equal(res.status, 422);
});

test("DELETE /api/folders/:id removes an empty folder", async () => {
  const h = buildHarness({ withAuth: true });
  const admin = await seedUser(h, {
    email: `a-${randomUUID().slice(0, 6)}@x.io`,
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const f = await h.request({
    method: "POST",
    path: "/api/folders",
    headers: admin,
    body: { name: "ToDelete" }
  });
  const del = await h.request({
    method: "DELETE",
    path: `/api/folders/${f.body.folder.id}`,
    headers: admin
  });
  assert.equal(del.status, 204);
  // Verify gone.
  const after = await h.request({
    method: "PUT",
    path: `/api/folders/${f.body.folder.id}`,
    headers: admin,
    body: { name: "Resurrect" }
  });
  assert.equal(after.status, 404);
});
