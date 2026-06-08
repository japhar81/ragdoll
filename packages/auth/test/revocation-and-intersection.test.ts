/**
 * ADR-0011 follow-throughs: session revocation store + API-key
 * request-time permission intersection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SessionTokenService,
  InMemorySessionRevocationStore,
  ApiKeyService,
  TokenInvalidError,
  InvalidCredentialsError
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// Session revocation
// ---------------------------------------------------------------------------

test("session revocation: a revoked token fails verify even when its signature is valid", () => {
  const store = new InMemorySessionRevocationStore();
  const sessions = new SessionTokenService("test-secret", store);
  const token = sessions.sign({ id: "u1", type: "user", roles: [] }, 3600);
  // Sanity: token verifies before revoke.
  const p = sessions.verify(token);
  assert.equal(p.id, "u1");
  // Revoke and try again — must throw TokenInvalidError.
  sessions.revoke(token);
  assert.throws(() => sessions.verify(token), TokenInvalidError);
});

test("session revocation: revoking a forged token doesn't crash", async () => {
  const store = new InMemorySessionRevocationStore();
  const sessions = new SessionTokenService("test-secret", store);
  // Malformed token — revoke should be a no-op.
  await sessions.revoke("not.a.token");
  await sessions.revoke("only-one-segment");
});

test("session revocation: a non-revoked token still verifies", () => {
  const store = new InMemorySessionRevocationStore();
  const sessions = new SessionTokenService("test-secret", store);
  const a = sessions.sign({ id: "u1", type: "user", roles: [] }, 3600);
  const b = sessions.sign({ id: "u2", type: "user", roles: [] }, 3600);
  sessions.revoke(a);
  // b is untouched.
  assert.equal(sessions.verify(b).id, "u2");
});

test("session revocation: GC drops expired entries from the in-memory set", () => {
  const store = new InMemorySessionRevocationStore();
  // Set with an expiration in the past — gc on the next consume should
  // make it forgotten.
  store.revoke("hash-1", Date.now() - 1000);
  // Touching the store triggers gc.
  assert.equal(store.isRevoked("hash-1"), false);
});

// ---------------------------------------------------------------------------
// API-key request-time intersection
// ---------------------------------------------------------------------------

function buildApiKeyRepoStub() {
  const records = new Map<string, any>();
  return {
    records,
    repo: {
      async create(r: any) {
        records.set(r.id, r);
        return r;
      },
      async findByPrefix(prefix: string) {
        for (const r of records.values()) if (r.prefix === prefix) return r;
        return undefined;
      },
      async touch() {},
      async listByPrincipal() {
        return [];
      },
      async revoke() {}
    }
  };
}

test("ApiKey: accountStatus hook rejects disabled users", async () => {
  const { repo } = buildApiKeyRepoStub();
  const svc = new ApiKeyService(repo as any, {
    accountStatus: async () => "disabled"
  });
  const issued = await svc.issue({
    principalId: "u1",
    name: "x",
    roles: ["viewer"]
  } as any);
  await assert.rejects(svc.verify(issued.plaintext), InvalidCredentialsError);
});

test("ApiKey: accountStatus=active lets the key through", async () => {
  const { repo } = buildApiKeyRepoStub();
  const svc = new ApiKeyService(repo as any, {
    accountStatus: async () => "active"
  });
  const issued = await svc.issue({
    principalId: "u1",
    name: "x",
    roles: ["platform_admin"]
  } as any);
  const p = await svc.verify(issued.plaintext);
  assert.equal(p.id, "u1");
  assert.deepEqual(p.roles, ["platform_admin"]);
});

test("ApiKey: currentRoles hook intersects the snapshot with present grants", async () => {
  const { repo } = buildApiKeyRepoStub();
  const svc = new ApiKeyService(repo as any, {
    accountStatus: async () => "active",
    // Key was minted with both roles; the user now has only `viewer`.
    currentRoles: async () => ["viewer"]
  });
  const issued = await svc.issue({
    principalId: "u1",
    name: "x",
    roles: ["platform_admin", "viewer"]
  } as any);
  const p = await svc.verify(issued.plaintext);
  // Only the role still held by the user survives.
  assert.deepEqual(p.roles, ["viewer"]);
});

test("ApiKey: intersection of empty current with non-empty snapshot strips all roles", async () => {
  const { repo } = buildApiKeyRepoStub();
  const svc = new ApiKeyService(repo as any, {
    accountStatus: async () => "active",
    currentRoles: async () => []
  });
  const issued = await svc.issue({
    principalId: "u1",
    name: "x",
    roles: ["platform_admin"]
  } as any);
  const p = await svc.verify(issued.plaintext);
  assert.deepEqual(p.roles, []);
});

test("ApiKey: no hooks (back-compat) keeps the snapshot roles", async () => {
  const { repo } = buildApiKeyRepoStub();
  const svc = new ApiKeyService(repo as any);
  const issued = await svc.issue({
    principalId: "u1",
    name: "x",
    roles: ["platform_admin", "viewer"]
  } as any);
  const p = await svc.verify(issued.plaintext);
  assert.deepEqual(p.roles, ["platform_admin", "viewer"]);
});
