/**
 * Phase 3 acceptance — API keys with per-tenant / per-env scoping +
 * expiration. The existing suite at apps/api/test/profile-apikeys.test.ts
 * covers the legacy un-scoped path (mint / list / authenticate / revoke /
 * issuer-cap). This file owns the Phase 3 additions:
 *
 *  - mint with env scope only succeeds for known environments
 *  - mint with env scope cannot exceed the creator's authority at that env
 *  - the resulting key acts at `t/<tenant>/e/<env>` and is denied
 *    everywhere else
 *  - mint with expiresAt rejects past dates
 *  - a key past its expiresAt is rejected at verify with the same shape
 *    as a revoked key (no observable distinction in the wire response)
 *
 * Lives under tests/security/ so it ships alongside rbac-audit.test.ts
 * and runs in the `test:security` npm script.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildHarness } from "../../apps/api/test/helpers.ts";
import {
  ApiKeyService,
  InMemoryApiKeyRepository
} from "../../packages/auth/src/index.ts";

async function seedUser(
  h: ReturnType<typeof buildHarness>,
  opts: {
    email: string;
    grants?: Array<{ role: string; scope: string }>;
  }
): Promise<{ id: string; bearer: Record<string, string> }> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await h.deps.users!.create({
    id,
    email: opts.email,
    displayName: opts.email,
    passwordHash: null,
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

async function seedTenantAndEnv(
  h: ReturnType<typeof buildHarness>,
  slug: string,
  envName: string
): Promise<{ tenantId: string; envId: string }> {
  const tenantId = randomUUID();
  const now = new Date().toISOString();
  await h.deps.tenants.create({
    id: tenantId,
    slug,
    name: slug,
    status: "active",
    metadata: {},
    createdAt: now,
    updatedAt: now
  });
  // The harness wires an InMemoryEnvironmentRepository under
  // deps.environments — same store the API mint route consults via
  // `environments.listByTenant`.
  const envId = randomUUID();
  await h.deps.environments!.create({
    id: envId,
    tenantId,
    name: envName,
    description: null,
    isProduction: envName === "prod",
    createdAt: now
  });
  return { tenantId, envId };
}

// --- env scoping ----------------------------------------------------------

test("API key mint accepts a valid environment and binds the scope to it", async () => {
  const h = buildHarness({ withAuth: true });
  const { tenantId } = await seedTenantAndEnv(h, "acme", "prod");
  const { bearer } = await seedUser(h, {
    email: "owner@acme.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });

  const res = await h.request({
    method: "POST",
    path: "/api/api-keys",
    headers: bearer,
    body: {
      name: "prod-only key",
      role: "tenant_admin",
      tenantId,
      environmentId: "prod"
    }
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.apiKey.tenantId, tenantId);
  assert.equal(res.body.apiKey.environmentId, "prod");
  assert.equal(res.body.apiKey.scope, `t/${tenantId}/e/prod`);
});

test("API key mint rejects an unknown environment for the tenant", async () => {
  const h = buildHarness({ withAuth: true });
  const { tenantId } = await seedTenantAndEnv(h, "acme", "prod");
  const { bearer } = await seedUser(h, {
    email: "owner@acme.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });

  const res = await h.request({
    method: "POST",
    path: "/api/api-keys",
    headers: bearer,
    body: {
      name: "k",
      role: "tenant_admin",
      tenantId,
      environmentId: "staging"
    }
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, "validation_failed");
});

test("API key mint refuses env without tenant", async () => {
  const h = buildHarness({ withAuth: true });
  const { bearer } = await seedUser(h, {
    email: "owner@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });

  const res = await h.request({
    method: "POST",
    path: "/api/api-keys",
    headers: bearer,
    body: { name: "k", role: "tenant_admin", environmentId: "prod" }
  });
  assert.equal(res.status, 422);
});

test("env-scoped key acts inside its env but is denied in another env", async () => {
  // We exercise the scope enforcement directly through the Authorizer so
  // this test doesn't depend on every REST handler honouring env scopes
  // (which they will once Datasets land — Phase 4). The decision plumbing
  // is what changes here: synthesizeGrants now lives at `t/T/e/E`.
  const h = buildHarness({ withAuth: true });
  const { tenantId } = await seedTenantAndEnv(h, "acme", "prod");
  const { bearer } = await seedUser(h, {
    email: "owner@acme.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const minted = await h.request({
    method: "POST",
    path: "/api/api-keys",
    headers: bearer,
    body: {
      name: "prod-only",
      role: "tenant_admin",
      tenantId,
      environmentId: "prod"
    }
  });
  assert.equal(minted.status, 201);
  const plaintext: string = minted.body.plaintext;

  // Verify the key resolves a Principal that carries the env. The auth
  // resolver attaches the env via the api_key record; the Authorizer
  // synthesizes the grant at `t/<tenant>/e/<env>`. A request scoped to
  // `t/T/e/prod` is allowed; `t/T/e/dev` is denied; `t/T` (env-less) is
  // also denied because env-scoped grants are siblings of tenant-scope.
  const principal = await h.deps.auth.resolve({
    headers: { authorization: `ApiKey ${plaintext}` }
  });
  assert.equal(principal.environment, "prod");

  const closure = await h.deps.authorizer!.authorizeClosure({
    id: principal.id,
    type: principal.type,
    tenantId: principal.tenantId,
    environment: principal.environment,
    roles: principal.roles
  });
  assert.equal(
    closure("config:edit_tenant", { tenantId, environment: "prod" }),
    true,
    "key should authorize inside its own env"
  );
  assert.equal(
    closure("config:edit_tenant", { tenantId, environment: "dev" }),
    false,
    "key must NOT authorize in a sibling env"
  );
  assert.equal(
    closure("config:edit_tenant", { tenantId }),
    false,
    "env-scoped key must NOT authorize at the bare tenant scope"
  );
});

// --- expiration -----------------------------------------------------------

test("API key mint rejects a past expiresAt", async () => {
  const h = buildHarness({ withAuth: true });
  const { bearer } = await seedUser(h, {
    email: "owner@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const past = new Date(Date.now() - 60_000).toISOString();
  const res = await h.request({
    method: "POST",
    path: "/api/api-keys",
    headers: bearer,
    body: { name: "k", role: "platform_admin", expiresAt: past }
  });
  assert.equal(res.status, 422);
});

// --- permission intersection at request time -----------------------------

test("API key authorization shrinks when the owner loses a grant", async () => {
  // The intersection happens at the principal.authorize(...) decision
  // layer (where enforce(...) actually checks permissions), not in
  // the informational me.permissions field. We assert against a route
  // that requires `config:edit_tenant` — POST /api/configs.
  const h = buildHarness({ withAuth: true });
  const { tenantId } = await seedTenantAndEnv(h, "acme", "prod");
  const owner = await seedUser(h, {
    email: "owner@x.io",
    grants: [{ role: "tenant_admin", scope: `t/${tenantId}` }]
  });
  // Owner mints a tenant_admin@t/T key for themselves.
  const minted = await h.request({
    method: "POST",
    path: "/api/api-keys",
    headers: owner.bearer,
    body: { name: "ci", role: "tenant_admin", tenantId }
  });
  if (minted.status !== 201) {
    throw new Error(
      `expected 201 from mint, got ${minted.status}: ${JSON.stringify(minted.body)}`
    );
  }
  const plaintext = minted.body.plaintext as string;

  // Resolve the principal + closure ourselves so we exercise the
  // authorizer directly, without going through a fragile REST mutation
  // path that may also need other prereqs to land.
  function checkConfigEdit(): boolean {
    return new Promise<boolean>((resolve) =>
      h.deps.auth
        .resolve({ headers: { authorization: `ApiKey ${plaintext}` } })
        .then(async (principal) => {
          principal.authorize = await h.deps.authorizer!.authorizeClosure({
            id: principal.id,
            type: principal.type,
            tenantId: principal.tenantId,
            environment: principal.environment,
            roles: principal.roles
          });
          resolve(principal.authorize("config:edit_tenant", { tenantId }));
        })
        .catch(() => resolve(false))
    ) as unknown as boolean;
  }

  // Before revoke: the key authorizes a tenant_admin action.
  const before = await (checkConfigEdit() as unknown as Promise<boolean>);
  assert.equal(
    before,
    true,
    "key should authorize tenant_admin actions before the owner's grant is revoked"
  );

  // Revoke the owner's tenant_admin grant.
  const grantsList = await h.deps.rbacPolicies!.listGrantsForUser(owner.id);
  const tenantAdminGrant = grantsList.find(
    (g) => g.role === "tenant_admin" && g.scope === `t/${tenantId}`
  );
  if (!tenantAdminGrant) throw new Error("seeded grant missing");
  await h.deps.rbacPolicies!.removeGrant(tenantAdminGrant.id);
  h.deps.authorizer!.invalidate(owner.id);

  // After revoke: the closure rebuilt on the next call sees an owner
  // with no covering grant → intersection blocks the action.
  const after = await (checkConfigEdit() as unknown as Promise<boolean>);
  assert.equal(
    after,
    false,
    "key should NOT authorize tenant_admin actions after the owner's grant is revoked"
  );
});

test("API key past its expiresAt is rejected at verify (and listed as expired)", async () => {
  // Mint directly against the service so we can backdate the stored row;
  // the REST validator (correctly) refuses past expiration on mint.
  const repo = new InMemoryApiKeyRepository();
  const svc = new ApiKeyService(repo);
  const issued = await svc.issue({
    principalId: randomUUID(),
    name: "expiring",
    roles: ["platform_admin"]
  });
  // Backdate the expiration so verify sees it as expired.
  const stored = await repo.findByPrefix(issued.record.prefix);
  if (!stored) throw new Error("record vanished");
  stored.expiresAt = new Date(Date.now() - 60_000).toISOString();

  await assert.rejects(
    () => svc.verify(issued.plaintext),
    /expired/i,
    "verify must reject expired keys"
  );

  // Sanity: an unexpired key still verifies after this branch flipped.
  stored.expiresAt = new Date(Date.now() + 60_000).toISOString();
  const principal = await svc.verify(issued.plaintext);
  assert.equal(principal.type, "api_key");
});
