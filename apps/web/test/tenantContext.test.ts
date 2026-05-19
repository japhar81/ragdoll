import test from "node:test";
import assert from "node:assert/strict";
import {
  DEV_ADMIN_ROLE,
  buildAuthHeaders,
  isUuid,
  pickDefaultTenant,
  tenantIdFromScopeKey,
  type TenantLike
} from "../src/lib/tenantContext.ts";

const UUID = "3f1a9c2e-6b7d-4a2f-8e1c-9d0b2a4c6e8f";

const TENANTS: TenantLike[] = [
  { id: "11111111-1111-4111-8111-111111111111", slug: "tenant-a", name: "Acme" },
  { id: UUID, slug: "tenant-local", name: "Local Demo" },
  { id: "22222222-2222-4222-8222-222222222222", slug: "tenant-b", name: "Beta" }
];

// ---- isUuid -------------------------------------------------------------

test("isUuid only accepts canonical UUIDs", () => {
  assert.equal(isUuid(UUID), true);
  assert.equal(isUuid(UUID.toUpperCase()), true);
  assert.equal(isUuid(`  ${UUID}  `), true);
  assert.equal(isUuid("tenant-local"), false);
  assert.equal(isUuid("tenant-a"), false);
  assert.equal(isUuid(""), false);
  assert.equal(isUuid(undefined), false);
  assert.equal(isUuid(123), false);
  assert.equal(isUuid(`${UUID}-extra`), false);
});

// ---- buildAuthHeaders ---------------------------------------------------

test("buildAuthHeaders sends NO x-roles by default (default-deny)", () => {
  const h = buildAuthHeaders();
  assert.equal("x-roles" in h, false);
  assert.deepEqual(Object.keys(h), []);
});

test("buildAuthHeaders emits x-roles only when explicitly set (dev opt-in)", () => {
  assert.equal(buildAuthHeaders({ roles: "viewer" })["x-roles"], "viewer");
  // blank is treated as unset, not defaulted.
  assert.equal("x-roles" in buildAuthHeaders({ roles: "   " }), false);
  // The dev-admin constant is still exported for explicit opt-in tooling.
  assert.equal(buildAuthHeaders({ roles: DEV_ADMIN_ROLE })["x-roles"], "platform_admin");
});

test("buildAuthHeaders includes x-tenant-id ONLY when set and a UUID", () => {
  // a real UUID is forwarded (trimmed)
  assert.equal(
    buildAuthHeaders({ tenantId: ` ${UUID} ` })["x-tenant-id"],
    UUID
  );
  // a slug is NOT sent (would 409/empty downstream)
  const slug = buildAuthHeaders({ tenantId: "tenant-local" });
  assert.equal("x-tenant-id" in slug, false);
  // empty / unset -> absent
  assert.equal("x-tenant-id" in buildAuthHeaders({ tenantId: "" }), false);
  assert.equal("x-tenant-id" in buildAuthHeaders({}), false);
});

test("buildAuthHeaders never emits a slug as x-tenant-id for any plausible slug", () => {
  for (const slug of ["tenant-a", "tenant-b", "tenant-local", "acme", "x"]) {
    const h = buildAuthHeaders({ tenantId: slug });
    assert.equal(
      "x-tenant-id" in h,
      false,
      `slug "${slug}" must not be sent as x-tenant-id`
    );
  }
});

test("buildAuthHeaders carries bearer / api-key when configured, alongside tenant", () => {
  const h = buildAuthHeaders({ token: "tok", apiKey: "ak", tenantId: UUID });
  assert.equal(h.authorization, "Bearer tok");
  assert.equal(h["x-api-key"], "ak");
  assert.equal(h["x-tenant-id"], UUID);
  assert.equal("x-roles" in h, false);
});

test("buildAuthHeaders does not mutate its input and returns a fresh object", () => {
  const ctx = { tenantId: UUID };
  const a = buildAuthHeaders(ctx);
  const b = buildAuthHeaders(ctx);
  assert.notEqual(a, b);
  assert.deepEqual(ctx, { tenantId: UUID });
});

// ---- pickDefaultTenant --------------------------------------------------

test("pickDefaultTenant prefers tenant-local by default", () => {
  const def = pickDefaultTenant(TENANTS);
  assert.equal(def?.slug, "tenant-local");
  assert.equal(def?.id, UUID);
});

test("pickDefaultTenant honours a custom preferred slug", () => {
  assert.equal(pickDefaultTenant(TENANTS, "tenant-b")?.slug, "tenant-b");
});

test("pickDefaultTenant falls back to the first tenant when preferred is absent", () => {
  const def = pickDefaultTenant(TENANTS, "no-such-slug");
  assert.equal(def?.slug, "tenant-a");
  // also falls back when the default preferred slug is missing
  const onlyOther: TenantLike[] = [
    { id: "9", slug: "only", name: "Only" }
  ];
  assert.equal(pickDefaultTenant(onlyOther)?.slug, "only");
});

test("pickDefaultTenant guards empty / missing lists", () => {
  assert.equal(pickDefaultTenant([]), undefined);
  assert.equal(pickDefaultTenant(undefined), undefined);
  assert.equal(pickDefaultTenant(null), undefined);
});

// ---- tenantIdFromScopeKey ----------------------------------------------

test("tenantIdFromScopeKey extracts the tenant id segment", () => {
  assert.equal(tenantIdFromScopeKey("global"), undefined);
  assert.equal(tenantIdFromScopeKey(undefined), undefined);
  assert.equal(tenantIdFromScopeKey(""), undefined);
  assert.equal(tenantIdFromScopeKey(`tenant:${UUID}`), UUID);
  assert.equal(
    tenantIdFromScopeKey(`tenant:${UUID}|pipeline:p1`),
    UUID
  );
});
