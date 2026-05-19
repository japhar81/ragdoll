import test from "node:test";
import assert from "node:assert/strict";
import {
  Authorizer,
  BuiltinPolicyEngine,
  DEFAULT_ROLE_PERMISSIONS,
  buildCatalog,
  defaultCatalogRows,
  evaluate,
  parseScope,
  resourceToScope,
  scopeCovers,
  scopeToString,
  type AuthorizablePrincipal,
  type Grant,
  type PolicyStore
} from "../src/index.ts";

// --- scope strings ---------------------------------------------------------

test("scopeToString builds the canonical hierarchy", () => {
  assert.equal(scopeToString({}), "*");
  assert.equal(scopeToString({ tenantId: "T" }), "t/T");
  assert.equal(scopeToString({ tenantId: "T", environment: "prod" }), "t/T/e/prod");
  assert.equal(scopeToString({ tenantId: "T", pipelineId: "P" }), "t/T/p/P");
  // Pipeline beats environment when both present (action targets a pipeline).
  assert.equal(
    scopeToString({ tenantId: "T", environment: "prod", pipelineId: "P" }),
    "t/T/p/P"
  );
  // No tenant => global, even if env/pipeline supplied.
  assert.equal(scopeToString({ environment: "prod" }), "*");
});

test("parseScope round-trips", () => {
  for (const s of ["*", "t/T", "t/T/e/prod", "t/T/p/P"]) {
    assert.equal(scopeToString(parseScope(s)), s);
  }
});

// --- scope coverage (the inheritance heart) --------------------------------

test("scopeCovers: global covers everything", () => {
  for (const r of ["*", "t/A", "t/A/e/prod", "t/A/p/P1"]) {
    assert.equal(scopeCovers("*", r), true);
  }
});

test("scopeCovers: tenant grant covers its envs and pipelines", () => {
  assert.equal(scopeCovers("t/A", "t/A"), true);
  assert.equal(scopeCovers("t/A", "t/A/e/prod"), true);
  assert.equal(scopeCovers("t/A", "t/A/p/P1"), true);
  // ...but not other tenants, nor the global plane.
  assert.equal(scopeCovers("t/A", "t/B"), false);
  assert.equal(scopeCovers("t/A", "*"), false);
});

test("scopeCovers: env/pipeline grants do NOT widen", () => {
  assert.equal(scopeCovers("t/A/e/prod", "t/A/e/prod"), true);
  assert.equal(scopeCovers("t/A/e/prod", "t/A"), false); // not tenant-wide
  assert.equal(scopeCovers("t/A/e/prod", "t/A/e/dev"), false);
  assert.equal(scopeCovers("t/A/p/P1", "t/A/p/P1"), true);
  assert.equal(scopeCovers("t/A/p/P1", "t/A"), false);
  assert.equal(scopeCovers("t/A/p/P1", "t/A/p/P2"), false);
});

// --- evaluate --------------------------------------------------------------

const catalog = buildCatalog(defaultCatalogRows());

test("evaluate: tenant_admin grant authorizes only inside its tenant", () => {
  const grants: Grant[] = [{ role: "tenant_admin", scope: "t/A" }];
  assert.equal(
    evaluate(grants, catalog, "config:edit_tenant", resourceToScope({ tenantId: "A" })),
    true
  );
  // Pipeline inside the tenant inherits the grant.
  assert.equal(
    evaluate(grants, catalog, "pipeline:run", resourceToScope({ tenantId: "A", pipelineId: "P" })),
    true
  );
  // Other tenant: denied.
  assert.equal(
    evaluate(grants, catalog, "config:edit_tenant", resourceToScope({ tenantId: "B" })),
    false
  );
  // Global action (no tenant): denied — tenant_admin is not platform-wide.
  assert.equal(evaluate(grants, catalog, "config:edit_global", "*"), false);
});

test("evaluate: platform_admin @ global is all-powerful", () => {
  const grants: Grant[] = [{ role: "platform_admin", scope: "*" }];
  assert.equal(evaluate(grants, catalog, "config:edit_global", "*"), true);
  assert.equal(
    evaluate(grants, catalog, "pipeline:delete", resourceToScope({ tenantId: "Z", pipelineId: "Q" })),
    true
  );
});

test("evaluate: default-deny with no grants", () => {
  assert.equal(evaluate([], catalog, "execution:view_logs", "*"), false);
});

test("evaluate: a wildcard permission row grants everything for that role", () => {
  const wild = buildCatalog([{ role: "superuser", permission: "*" }]);
  assert.equal(
    evaluate([{ role: "superuser", scope: "t/A" }], wild, "pipeline:delete", "t/A/p/P"),
    true
  );
});

// --- Authorizer: synthesized (API key / dev) principals --------------------

test("Authorizer synthesises grants from carried roles at the principal scope", async () => {
  const authz = new Authorizer({ engine: new BuiltinPolicyEngine() });

  const tenantOp: AuthorizablePrincipal = {
    id: "k1",
    type: "api_key",
    tenantId: "A",
    roles: ["tenant_operator"]
  };
  const can = await authz.authorizeClosure(tenantOp);
  assert.equal(can("pipeline:run", { tenantId: "A" }), true);
  assert.equal(can("pipeline:run", { tenantId: "B" }), false); // cross-tenant
  assert.equal(can("config:edit_global"), false); // not platform-wide

  const root: AuthorizablePrincipal = {
    id: "svc",
    type: "service",
    roles: ["platform_admin"]
  };
  const godmode = await authz.authorizeClosure(root);
  assert.equal(godmode("config:edit_global"), true);
  assert.equal(godmode("pipeline:delete", { tenantId: "anything", pipelineId: "p" }), true);
});

// --- Authorizer: real users via a policy store -----------------------------

class FakeStore implements PolicyStore {
  grants: Grant[] = [];
  rolePerms = defaultCatalogRows();
  async listRolePermissions() {
    return this.rolePerms;
  }
  async listGrantsForUser() {
    return this.grants;
  }
}

test("Authorizer reads real-user grants from the store and honours invalidate()", async () => {
  const store = new FakeStore();
  const authz = new Authorizer({ engine: new BuiltinPolicyEngine(), store });
  const user: AuthorizablePrincipal = { id: "u1", type: "user", roles: [] };

  let can = await authz.authorizeClosure(user);
  assert.equal(can("pipeline:run", { tenantId: "A" }), false); // no grants yet

  store.grants = [{ role: "tenant_admin", scope: "t/A" }];
  // Cached — still denied until invalidated.
  can = await authz.authorizeClosure(user);
  assert.equal(can("pipeline:run", { tenantId: "A" }), false);

  authz.invalidate("u1");
  can = await authz.authorizeClosure(user);
  assert.equal(can("pipeline:run", { tenantId: "A" }), true);
  assert.equal(can("pipeline:run", { tenantId: "A", pipelineId: "P" }), true);
  assert.equal(can("pipeline:run", { tenantId: "B" }), false);
});

test("Authorizer falls back to built-in catalog when the store is empty", async () => {
  const store = new FakeStore();
  store.rolePerms = []; // empty store
  const authz = new Authorizer({ engine: new BuiltinPolicyEngine(), store });
  const user: AuthorizablePrincipal = { id: "u2", type: "user", roles: [] };
  store.grants = [{ role: "viewer", scope: "*" }];
  const can = await authz.authorizeClosure(user);
  assert.equal(can("execution:view_logs"), true);
  assert.equal(can("pipeline:delete"), false);
});

test("DEFAULT_ROLE_PERMISSIONS covers the new access-control permissions", () => {
  assert.ok(DEFAULT_ROLE_PERMISSIONS.platform_admin.includes("user:manage"));
  assert.ok(DEFAULT_ROLE_PERMISSIONS.platform_admin.includes("role:manage"));
  assert.ok(DEFAULT_ROLE_PERMISSIONS.platform_admin.includes("idp:manage"));
  assert.ok(DEFAULT_ROLE_PERMISSIONS.platform_admin.includes("auth:settings"));
  // tenant_admin can manage users (scoped), but not instance settings.
  assert.ok(DEFAULT_ROLE_PERMISSIONS.tenant_admin.includes("user:manage"));
  assert.ok(!DEFAULT_ROLE_PERMISSIONS.tenant_admin.includes("auth:settings"));
});
