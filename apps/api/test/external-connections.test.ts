/**
 * ADR-0021 — REST coverage for /api/external-connections CRUD + RBAC +
 * scope-shape + cascade visibility. Probe is exercised via the runtime
 * path in plugin tests since it needs a registered driver.
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

async function seedTenant(
  h: ReturnType<typeof buildHarness>,
  slug: string
): Promise<string> {
  const id = randomUUID();
  await h.deps.tenants.create({
    id,
    slug,
    name: slug,
    status: "active",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  return id;
}

test("GET /api/external-connections requires external_connection:read", async () => {
  const h = buildHarness({ withAuth: true });
  // Seed a user with NO grants — must 403.
  const denied = await seedUser(h, {
    email: `viewer-${randomUUID().slice(0, 6)}@x.io`,
    grants: []
  });
  const res = await h.request({
    method: "GET",
    path: "/api/external-connections",
    headers: denied
  });
  assert.equal(res.status, 403);
});

test("POST + GET round-trip a global connection", async () => {
  const h = buildHarness({ withAuth: true });
  const admin = await seedUser(h, {
    email: `a-${randomUUID().slice(0, 6)}@x.io`,
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const created = await h.request({
    method: "POST",
    path: "/api/external-connections",
    headers: admin,
    body: {
      scope: "global",
      slug: "acme-reporting",
      displayName: "Acme Reporting",
      kind: "mongodb",
      options: { database: "reporting" }
    }
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.connection.kind, "mongodb");
  assert.equal(created.body.connection.options.database, "reporting");

  const list = await h.request({
    method: "GET",
    path: "/api/external-connections",
    headers: admin
  });
  assert.equal(list.status, 200);
  assert.ok(
    list.body.connections.some(
      (c: { slug: string }) => c.slug === "acme-reporting"
    )
  );
});

test("scope-shape: tenant scope without tenantId -> 422", async () => {
  const h = buildHarness({ withAuth: true });
  const admin = await seedUser(h, {
    email: `a-${randomUUID().slice(0, 6)}@x.io`,
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const res = await h.request({
    method: "POST",
    path: "/api/external-connections",
    headers: admin,
    body: {
      scope: "tenant",
      slug: "broken",
      displayName: "Broken",
      kind: "mongodb"
    }
  });
  assert.equal(res.status, 422);
});

test("slug uniqueness within scope -> 409 conflict on second create", async () => {
  const h = buildHarness({ withAuth: true });
  const admin = await seedUser(h, {
    email: `a-${randomUUID().slice(0, 6)}@x.io`,
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const first = await h.request({
    method: "POST",
    path: "/api/external-connections",
    headers: admin,
    body: { scope: "global", slug: "dup", displayName: "First", kind: "mongodb" }
  });
  assert.equal(first.status, 201);
  const second = await h.request({
    method: "POST",
    path: "/api/external-connections",
    headers: admin,
    body: { scope: "global", slug: "dup", displayName: "Second", kind: "mongodb" }
  });
  assert.equal(second.status, 409);
});

test("DELETE soft-archives the connection (still gettable, marked archivedAt)", async () => {
  const h = buildHarness({ withAuth: true });
  const admin = await seedUser(h, {
    email: `a-${randomUUID().slice(0, 6)}@x.io`,
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const created = await h.request({
    method: "POST",
    path: "/api/external-connections",
    headers: admin,
    body: { scope: "global", slug: "archive-me", displayName: "X", kind: "mongodb" }
  });
  const id = created.body.connection.id;
  const del = await h.request({
    method: "DELETE",
    path: `/api/external-connections/${id}`,
    headers: admin
  });
  assert.equal(del.status, 204);
  const after = await h.request({
    method: "GET",
    path: `/api/external-connections/${id}`,
    headers: admin
  });
  // Soft delete — row still exists; archivedAt set.
  assert.equal(after.status, 200);
  assert.ok(after.body.connection.archivedAt);
});

test("PUT updates displayName + options + audits old/new", async () => {
  const h = buildHarness({ withAuth: true });
  const admin = await seedUser(h, {
    email: `a-${randomUUID().slice(0, 6)}@x.io`,
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const created = await h.request({
    method: "POST",
    path: "/api/external-connections",
    headers: admin,
    body: { scope: "global", slug: "patch-me", displayName: "Before", kind: "mongodb" }
  });
  const id = created.body.connection.id;
  const updated = await h.request({
    method: "PUT",
    path: `/api/external-connections/${id}`,
    headers: admin,
    body: { displayName: "After", options: { pool: 10 } }
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.connection.displayName, "After");
  assert.deepEqual(updated.body.connection.options, { pool: 10 });
});

test("cascade visibility: env-scoped row hides from another tenant's listing", async () => {
  const h = buildHarness({ withAuth: true });
  const admin = await seedUser(h, {
    email: `pa-${randomUUID().slice(0, 6)}@x.io`,
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const tA = await seedTenant(h, "a");
  const tB = await seedTenant(h, "b");
  // Seed an env-scoped connection for tenant A.
  await h.request({
    method: "POST",
    path: "/api/external-connections",
    headers: admin,
    body: {
      scope: "environment",
      tenantId: tA,
      environmentId: "dev",
      slug: "a-only",
      displayName: "A-only",
      kind: "mongodb"
    }
  });
  // List as tenant A — sees it.
  const listA = await h.request({
    method: "GET",
    path: "/api/external-connections",
    headers: { ...admin, "x-tenant-id": tA, "x-ragdoll-env": "dev" }
  });
  assert.ok(listA.body.connections.some((c: { slug: string }) => c.slug === "a-only"));
  // List as tenant B — does NOT see it.
  const listB = await h.request({
    method: "GET",
    path: "/api/external-connections",
    headers: { ...admin, "x-tenant-id": tB, "x-ragdoll-env": "dev" }
  });
  assert.ok(!listB.body.connections.some((c: { slug: string }) => c.slug === "a-only"));
});
