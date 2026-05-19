/**
 * End-to-end auth + scoped-RBAC behaviour through the real `createApp` router
 * with the full auth stack wired and NO dev provider (strict default-deny).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildHarness } from "./helpers.ts";
import { PasswordService } from "../../../packages/auth/src/index.ts";

/** Insert a user + grants directly (simulates the bootstrap admin) and return
 * a Bearer header for it. */
async function seedUser(
  h: ReturnType<typeof buildHarness>,
  opts: { email: string; password?: string; grants?: Array<{ role: string; scope: string }> }
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

// --- default-deny ----------------------------------------------------------

test("unauthenticated requests are denied (no dev provider)", async () => {
  const { request } = buildHarness({ withAuth: true });
  const res = await request({ method: "GET", path: "/api/pipelines" });
  assert.equal(res.status, 401);
});

test("a session user with no grants is denied everything (default-deny)", async () => {
  const h = buildHarness({ withAuth: true });
  const { bearer } = await seedUser(h, { email: "nobody@x.io" });
  const res = await h.request({
    method: "GET",
    path: "/api/pipelines",
    headers: bearer
  });
  assert.equal(res.status, 403);
});

// --- local login -----------------------------------------------------------

test("local login issues a working session token", async () => {
  const h = buildHarness({ withAuth: true });
  await seedUser(h, {
    email: "admin@x.io",
    password: "supersecret1",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const login = await h.request({
    method: "POST",
    path: "/api/auth/login",
    body: { email: "admin@x.io", password: "supersecret1" }
  });
  assert.equal(login.status, 200);
  assert.ok(login.body.token);
  const me = await h.request({
    method: "GET",
    path: "/api/auth/me",
    headers: { authorization: `Bearer ${login.body.token}` }
  });
  assert.equal(me.status, 200);
  assert.ok(me.body.permissions.includes("config:edit_global"));

  const bad = await h.request({
    method: "POST",
    path: "/api/auth/login",
    body: { email: "admin@x.io", password: "wrong" }
  });
  assert.equal(bad.status, 401);
});

// --- signup modes (the configurable flag) ---------------------------------

test("signup mode admin_only blocks self-service signup", async () => {
  const h = buildHarness({ withAuth: true });
  // Default mode is admin_only.
  const res = await h.request({
    method: "POST",
    path: "/api/auth/signup",
    body: { email: "x@y.io", password: "password123" }
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "signup_disabled");
});

test("signup mode open_no_access creates a usable login with zero access", async () => {
  const h = buildHarness({ withAuth: true });
  await h.deps.authSettings!.set({
    signupMode: "open_no_access",
    defaultRole: null,
    updatedAt: new Date().toISOString()
  });
  const res = await h.request({
    method: "POST",
    path: "/api/auth/signup",
    body: { email: "fresh@y.io", password: "password123" }
  });
  assert.equal(res.status, 201);
  const me = await h.request({
    method: "GET",
    path: "/api/auth/me",
    headers: { authorization: `Bearer ${res.body.token}` }
  });
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.permissions, []);
});

test("signup mode open_default_role grants the configured role", async () => {
  const h = buildHarness({ withAuth: true });
  await h.deps.authSettings!.set({
    signupMode: "open_default_role",
    defaultRole: "viewer",
    updatedAt: new Date().toISOString()
  });
  const res = await h.request({
    method: "POST",
    path: "/api/auth/signup",
    body: { email: "v@y.io", password: "password123" }
  });
  assert.equal(res.status, 201);
  const me = await h.request({
    method: "GET",
    path: "/api/auth/me",
    headers: { authorization: `Bearer ${res.body.token}` }
  });
  assert.deepEqual(me.body.permissions, ["execution:view_logs"]);
});

// --- scoped grants ---------------------------------------------------------

test("tenant_admin grant is confined to its tenant scope", async () => {
  const h = buildHarness({ withAuth: true });
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const { bearer } = await seedUser(h, {
    email: "ta@x.io",
    grants: [{ role: "tenant_admin", scope: `t/${tenantA}` }]
  });

  // config:edit_tenant inside tenant A (selected via x-tenant-id) -> allowed.
  const inA = await h.request({
    method: "GET",
    path: "/api/secrets",
    headers: { ...bearer, "x-tenant-id": tenantA }
  });
  assert.equal(inA.status, 200);

  // Same action targeting tenant B -> denied (scope not covered).
  const inB = await h.request({
    method: "GET",
    path: "/api/secrets",
    headers: { ...bearer, "x-tenant-id": tenantB }
  });
  assert.equal(inB.status, 403);

  // A platform-wide action -> denied (tenant_admin is not platform-wide).
  const global = await h.request({
    method: "GET",
    path: "/api/roles",
    headers: { ...bearer, "x-tenant-id": tenantA }
  });
  assert.equal(global.status, 403);
});

// --- user / grant management is itself scope-checked -----------------------

test("a tenant_admin cannot mint a platform-wide grant", async () => {
  const h = buildHarness({ withAuth: true });
  const tenantA = randomUUID();
  const { bearer } = await seedUser(h, {
    email: "ta2@x.io",
    grants: [{ role: "tenant_admin", scope: `t/${tenantA}` }]
  });
  const target = await seedUser(h, { email: "target@x.io" });

  // Granting within their tenant: allowed.
  const okGrant = await h.request({
    method: "POST",
    path: `/api/users/${target.id}/grants`,
    headers: bearer,
    body: { role: "viewer", tenantId: tenantA }
  });
  assert.equal(okGrant.status, 201);

  // Granting platform_admin at global scope: denied (needs user:manage @ *).
  const escalate = await h.request({
    method: "POST",
    path: `/api/users/${target.id}/grants`,
    headers: bearer,
    body: { role: "platform_admin", scope: "*" }
  });
  assert.equal(escalate.status, 403);
});

// --- role editing takes effect immediately (authorizer.invalidate) ---------

test("editing a role's permissions changes effective access live", async () => {
  const h = buildHarness({ withAuth: true });
  const admin = await seedUser(h, {
    email: "root@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const { id: uid } = await seedUser(h, {
    email: "editor@x.io",
    grants: [{ role: "viewer", scope: "*" }]
  });
  const viewerToken = h.sessions.sign({ id: uid, type: "user", roles: [] }, 3600);
  const viewer = { authorization: `Bearer ${viewerToken}` };

  // viewer cannot create pipelines.
  let res = await h.request({
    method: "POST",
    path: "/api/pipelines",
    headers: viewer,
    body: { slug: "p", name: "P" }
  });
  assert.equal(res.status, 403);

  // Admin grants the viewer role pipeline:create.
  const upd = await h.request({
    method: "PUT",
    path: "/api/roles/viewer/permissions",
    headers: admin.bearer,
    body: { permissions: ["execution:view_logs", "pipeline:create"] }
  });
  assert.equal(upd.status, 200);

  // Now it works — no re-login required.
  res = await h.request({
    method: "POST",
    path: "/api/pipelines",
    headers: viewer,
    body: { slug: "p", name: "P" }
  });
  assert.equal(res.status, 201);
});

// --- session principal reflects resolved grants for data scoping ----------

test("platform admin (session token) sees all tenants", async () => {
  const h = buildHarness({ withAuth: true });
  await h.deps.tenants.create({
    id: randomUUID(),
    slug: "acme",
    name: "Acme",
    status: "active",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const { bearer } = await seedUser(h, {
    email: "padmin@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const res = await h.request({
    method: "GET",
    path: "/api/tenants",
    headers: bearer
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.tenants.length, 1);
});

test("tenant-scoped session user sees only its tenant and cannot spoof", async () => {
  const h = buildHarness({ withAuth: true });
  const tA = randomUUID();
  const tB = randomUUID();
  for (const [id, slug] of [
    [tA, "ten-a"],
    [tB, "ten-b"]
  ]) {
    await h.deps.tenants.create({
      id,
      slug,
      name: slug,
      status: "active",
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }
  // auditor has audit:view (which GET /api/tenants requires), scoped to tA.
  const { bearer } = await seedUser(h, {
    email: "aud@scoped.io",
    grants: [{ role: "auditor", scope: `t/${tA}` }]
  });

  // Selecting the granted tenant -> authorized, and the principal is bound to
  // tA so the list is filtered to exactly that tenant.
  const okRes = await h.request({
    method: "GET",
    path: "/api/tenants",
    headers: { ...bearer, "x-tenant-id": tA }
  });
  assert.equal(okRes.status, 200);
  assert.deepEqual(
    okRes.body.tenants.map((t: { id: string }) => t.id),
    [tA]
  );

  // Spoofing a tenant they hold no grant for: the scoped Casbin check denies
  // it outright (audit:view @ t/tB is not covered) — no data leak.
  const spoof = await h.request({
    method: "GET",
    path: "/api/tenants",
    headers: { ...bearer, "x-tenant-id": tB }
  });
  assert.equal(spoof.status, 403);
});

// --- identity providers + settings ----------------------------------------

test("identity provider CRUD redacts secrets and powers the public list", async () => {
  const h = buildHarness({ withAuth: true });
  const admin = await seedUser(h, {
    email: "idp-admin@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const created = await h.request({
    method: "POST",
    path: "/api/identity-providers",
    headers: admin.bearer,
    body: {
      slug: "okta",
      kind: "oidc",
      displayName: "Okta",
      config: { issuer: "https://example.okta.com", clientId: "abc", clientSecret: "shhh" }
    }
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.provider.config.clientSecret, "REDACTED");

  // Public providers list (no auth) surfaces it for the login page.
  const pub = await h.request({ method: "GET", path: "/api/auth/providers" });
  assert.equal(pub.status, 200);
  assert.equal(pub.body.providers[0].slug, "okta");
  assert.equal(pub.body.providers[0].kind, "oidc");
});
