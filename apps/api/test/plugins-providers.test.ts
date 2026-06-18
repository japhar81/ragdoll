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

// ---------------------------------------------------------------------------
// PLUGIN-ARCH-1: /api/plugins/sources + /api/plugins/refresh
// ---------------------------------------------------------------------------

test("GET /api/plugins/sources always surfaces the built-in rows, even before any refresh has run", async () => {
  // Built-in (`builtin` / `sample-text`) rows are the catalog's
  // safety net — operators need to see them BEFORE the first
  // refresh, because the boot path uses the legacy synchronous
  // loader which doesn't populate holder statuses. The route
  // pulls built-ins from the in-code `BUILTIN_SOURCES` descriptor
  // list so the response is honest at boot.
  const h = buildHarness({ withAuth: true });
  const auth = await seedAuth(h);
  const res = await h.request({
    method: "GET",
    path: "/api/plugins/sources",
    headers: auth
  });
  assert.equal(res.status, 200);
  const ids = (res.body.sources as Array<{ id: string; builtin: boolean }>).map(
    (s) => s.id
  );
  assert.ok(ids.includes("builtin"), "builtin row must be present");
  assert.ok(ids.includes("sample-text"), "sample-text row must be present");
  // And both carry the `builtin: true` flag so the UI knows to
  // render them read-only.
  for (const s of res.body.sources as Array<{ id: string; builtin: boolean }>) {
    if (s.id === "builtin" || s.id === "sample-text") {
      assert.equal(s.builtin, true);
    }
  }
});

test("POST /api/plugins/refresh rebuilds the registry through the source store + returns a diff envelope", async () => {
  const h = buildHarness({ withAuth: true });
  const auth = await seedAuth(h);
  // Refresh against an empty store builds a fresh registry that
  // contains only the built-ins. The seeded fake_echo plugin (added
  // to the harness registry directly, not via the store) gets
  // REMOVED — confirming the swap actually replaces the registry
  // pointer (in-flight requests would see the old; new requests see
  // the new).
  const res = await h.request({
    method: "POST",
    path: "/api/plugins/refresh",
    headers: auth,
    body: {}
  });
  assert.equal(res.status, 200);
  // The two built-in sources both ran. The empty `__memory__/.../local/`
  // import targets DON'T resolve to real plugins, but the lifecycle
  // returns status=failed (no real module) — that's fine for this
  // test: the load-bearing assertion is the envelope shape.
  assert.ok(Array.isArray(res.body.sources));
  assert.ok(res.body.diff);
  assert.ok(Array.isArray(res.body.diff.added));
  assert.ok(Array.isArray(res.body.diff.removed));
  assert.ok(Array.isArray(res.body.diff.updated));
  assert.equal(typeof res.body.pluginCount, "number");
  // The harness's fake_echo plugin was in the OLD registry but the
  // empty-store refresh builds a NEW registry without it → removed.
  assert.ok(
    res.body.diff.removed.some((k: string) => k.includes("fake_echo")),
    "fake_echo must surface in `removed` — the swap really happened"
  );
});

test("POST /api/plugins/refresh requires plugin:manage permission (401/403 without it)", async () => {
  // A viewer-level user has execution:view_logs (so /api/plugins works)
  // but not plugin:manage — refresh must be denied.
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
  await h.deps.rbacPolicies!.addGrant({
    id: randomUUID(),
    userId: id,
    role: "viewer",
    scope: "*",
    createdAt: now
  });
  const auth = {
    authorization: `Bearer ${h.sessions.sign({ id, type: "user", roles: [] }, 3600)}`
  };
  const res = await h.request({
    method: "POST",
    path: "/api/plugins/refresh",
    headers: auth,
    body: {}
  });
  assert.ok(
    res.status === 403 || res.status === 401,
    `viewer must not be allowed to refresh (got ${res.status})`
  );
});

test("plugins surfaced through /api/plugins carry the `source` provenance field (PLUGIN-ARCH-1 wire contract)", async () => {
  // After a refresh the new registry's plugins carry provenance. The
  // harness's seeded fake_echo plugin doesn't (it was registered
  // directly, not via the lifecycle) — so we refresh first, then
  // check that the response contains the `source` field on EVERY
  // surfaced plugin.
  const h = buildHarness({ withAuth: true });
  const auth = await seedAuth(h);
  // Pre-populate the harness's source store with a minimal git
  // source that the lifecycle can satisfy from a stubbed import.
  // (The harness's source store is an InMemoryPluginSourceStore; we
  // could mutate it directly but the API doesn't expose a setter,
  // so this test just asserts shape on the holder's snapshot.)
  // Easier: read the harness's holder directly and exercise the
  // builder seam via the swap helper.
  const holder = h.deps.pluginRegistryHolder!;
  const before = holder.list();
  // Stamp provenance on the existing plugin by re-registering it
  // through a fresh registry — same effect the refresh path
  // produces.
  const { PluginRegistry: PR } = await import(
    "../../../packages/plugin-sdk/src/index.ts"
  );
  const fresh = new PR();
  for (const p of before) {
    fresh.register({
      ...p,
      source: {
        repoId: "builtin",
        kind: "local",
        loadedAt: new Date().toISOString()
      }
    });
  }
  holder.swap(fresh, []);
  const res = await h.request({
    method: "GET",
    path: "/api/plugins",
    headers: auth
  });
  assert.equal(res.status, 200);
  for (const p of res.body.plugins as Array<{ source?: unknown }>) {
    assert.ok(
      p.source,
      `every plugin surfaced via /api/plugins must carry .source provenance`
    );
  }
});

// ---------------------------------------------------------------------------
// PLUGIN-ARCH-1 close-out: CRUD on /api/plugins/sources
// ---------------------------------------------------------------------------

test("POST /api/plugins/sources creates a new git source row (plugin:manage required)", async () => {
  const h = buildHarness({ withAuth: true });
  const auth = await seedAuth(h);
  const res = await h.request({
    method: "POST",
    path: "/api/plugins/sources",
    headers: auth,
    body: {
      id: "ext-acme",
      gitUrl: "https://git.acme.invalid/plugins.git",
      ref: "main",
      subpath: "src",
      enabled: true,
      requireSignature: true,
      allowedSigners: "octocat ssh-ed25519 AAAA"
    }
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.source.id, "ext-acme");
  assert.equal(res.body.source.kind, "git");
  assert.equal(res.body.source.requireSignature, true);
  // And the new row shows up on the listing endpoint.
  const list = await h.request({
    method: "GET",
    path: "/api/plugins/sources",
    headers: auth
  });
  assert.ok(list.body.sources.some((s: { id: string }) => s.id === "ext-acme"));
});

test("POST /api/plugins/sources refuses reserved ids (builtin / sample-text) and malformed ids", async () => {
  const h = buildHarness({ withAuth: true });
  const auth = await seedAuth(h);
  for (const id of ["builtin", "sample-text", "BUILTIN"]) {
    const res = await h.request({
      method: "POST",
      path: "/api/plugins/sources",
      headers: auth,
      body: { id, gitUrl: "https://x.invalid/y.git" }
    });
    assert.equal(res.status, 400, `id=${id} must be rejected as reserved`);
  }
  for (const id of ["", "../escape", "with space", "WAY-TOO-LONG".repeat(20)]) {
    const res = await h.request({
      method: "POST",
      path: "/api/plugins/sources",
      headers: auth,
      body: { id, gitUrl: "https://x.invalid/y.git" }
    });
    assert.equal(res.status, 400, `id=${JSON.stringify(id)} must be rejected as malformed`);
  }
});

test("PATCH /api/plugins/sources/:id updates a subset of fields (the audit-log-friendly minimal-UPDATE shape)", async () => {
  const h = buildHarness({ withAuth: true });
  const auth = await seedAuth(h);
  await h.request({
    method: "POST",
    path: "/api/plugins/sources",
    headers: auth,
    body: {
      id: "ext-patch",
      gitUrl: "https://x.invalid/y.git",
      ref: "main",
      enabled: true
    }
  });
  const res = await h.request({
    method: "PATCH",
    path: "/api/plugins/sources/ext-patch",
    headers: auth,
    body: { enabled: false, ref: "release-1.2" }
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.source.enabled, false);
  assert.equal(res.body.source.ref, "release-1.2");
  // Unmentioned fields are preserved.
  assert.equal(res.body.source.gitUrl, "https://x.invalid/y.git");
});

test("DELETE /api/plugins/sources/:id removes a row; reserved ids are refused", async () => {
  const h = buildHarness({ withAuth: true });
  const auth = await seedAuth(h);
  await h.request({
    method: "POST",
    path: "/api/plugins/sources",
    headers: auth,
    body: { id: "ext-del", gitUrl: "https://x.invalid/y.git" }
  });
  const del = await h.request({
    method: "DELETE",
    path: "/api/plugins/sources/ext-del",
    headers: auth
  });
  assert.equal(del.status, 200);
  const reserved = await h.request({
    method: "DELETE",
    path: "/api/plugins/sources/builtin",
    headers: auth
  });
  assert.equal(reserved.status, 400);
});

test("POST/PATCH/DELETE /api/plugins/sources require plugin:manage (viewer rejected)", async () => {
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
  await h.deps.rbacPolicies!.addGrant({
    id: randomUUID(),
    userId: id,
    role: "viewer",
    scope: "*",
    createdAt: now
  });
  const auth = {
    authorization: `Bearer ${h.sessions.sign({ id, type: "user", roles: [] }, 3600)}`
  };
  for (const op of [
    { method: "POST" as const, path: "/api/plugins/sources", body: { id: "x", gitUrl: "y" } },
    { method: "PATCH" as const, path: "/api/plugins/sources/x", body: { enabled: false } },
    { method: "DELETE" as const, path: "/api/plugins/sources/x", body: {} }
  ]) {
    const res = await h.request({
      method: op.method,
      path: op.path,
      headers: auth,
      body: op.body
    });
    assert.ok(
      res.status === 401 || res.status === 403,
      `${op.method} ${op.path} must require plugin:manage (got ${res.status})`
    );
  }
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
