import test from "node:test";
import assert from "node:assert/strict";
import {
  DatabaseEncryptedSecretProvider,
  InMemorySecretRepository,
  SecretAccessDeniedError,
  StaticKeyProvider,
  redactedSecretList,
  resolveConnectionSecret
} from "../src/index.ts";

function freshProvider(): DatabaseEncryptedSecretProvider {
  return new DatabaseEncryptedSecretProvider(
    new InMemorySecretRepository(),
    new StaticKeyProvider("dev-secret")
  );
}

test("secrets are encrypted and redacted in list output", async () => {
  const repository = new InMemorySecretRepository();
  const provider = new DatabaseEncryptedSecretProvider(repository, new StaticKeyProvider("dev-secret"));
  await provider.put({ scope: "tenant", tenantId: "tenant-a", key: "openai.api_key" }, "sk-tenant-a");
  const stored = await repository.find({ scope: "tenant", tenantId: "tenant-a", key: "openai.api_key" });
  assert.ok(stored);
  assert.notEqual(stored!.ciphertext, "sk-tenant-a");
  assert.equal(await provider.get({ scope: "tenant", tenantId: "tenant-a", key: "openai.api_key" }, "tenant-a"), "sk-tenant-a");
  const listed = redactedSecretList(await provider.list({ tenantId: "tenant-a" }) as any);
  assert.equal(listed[0].value, "REDACTED");
});

test("tenant A cannot access tenant B secret", async () => {
  const provider = new DatabaseEncryptedSecretProvider(new InMemorySecretRepository(), new StaticKeyProvider("dev-secret"));
  await provider.put({ scope: "tenant", tenantId: "tenant-b", key: "anthropic.api_key" }, "sk-ant-b");
  await assert.rejects(
    provider.get({ scope: "tenant", tenantId: "tenant-b", key: "anthropic.api_key" }, "tenant-a"),
    SecretAccessDeniedError
  );
});

// ---------------------------------------------------------------------------
// resolveConnectionSecret — secret scope is INDEPENDENT of connection scope.
//
// The bug this fixes: secret resolution used to derive its scope from the
// connection (`conn.tenantId ? "tenant" : "global"`), so a tenant
// connection could never reach a global credential and vice versa. The
// cascade resolves the logical key across env → tenant → global keyed off
// the runtime tenant boundary, regardless of where the connection lives.
// ---------------------------------------------------------------------------

test("resolveConnectionSecret: tenant connection inherits a GLOBAL credential (the reported bug)", async () => {
  const p = freshProvider();
  // Credential stored ONLY at global scope — shared org-wide cred.
  await p.put({ scope: "global", key: "NEO4J_CREDS" }, "neo4j:global-pw");
  // A tenant-scoped connection (tenantId set) references it.
  const got = await resolveConnectionSecret(p, {
    key: "NEO4J_CREDS",
    tenantId: "cyb3r1"
  });
  assert.equal(got, "neo4j:global-pw");
});

test("resolveConnectionSecret: global connection (run under a tenant) inherits a TENANT credential (the inverse)", async () => {
  const p = freshProvider();
  // Credential stored ONLY at tenant scope — per-tenant override.
  await p.put({ scope: "tenant", tenantId: "cyb3r1", key: "NEO4J_CREDS" }, "neo4j:tenant-pw");
  // A global connection, but the execution runs under tenant cyb3r1.
  const got = await resolveConnectionSecret(p, {
    key: "NEO4J_CREDS",
    tenantId: "cyb3r1"
  });
  assert.equal(got, "neo4j:tenant-pw");
});

test("resolveConnectionSecret: tenant scope wins over global when BOTH exist (most-specific-first)", async () => {
  const p = freshProvider();
  await p.put({ scope: "global", key: "DUP" }, "global-val");
  await p.put({ scope: "tenant", tenantId: "t1", key: "DUP" }, "tenant-val");
  const got = await resolveConnectionSecret(p, { key: "DUP", tenantId: "t1" });
  assert.equal(got, "tenant-val");
});

test("resolveConnectionSecret: environment scope wins over tenant + global (full cascade order)", async () => {
  const p = freshProvider();
  await p.put({ scope: "global", key: "DUP" }, "global-val");
  await p.put({ scope: "tenant", tenantId: "t1", key: "DUP" }, "tenant-val");
  await p.put(
    { scope: "environment", tenantId: "t1", environment: "prod", key: "DUP" },
    "env-val"
  );
  const got = await resolveConnectionSecret(p, {
    key: "DUP",
    tenantId: "t1",
    environment: "prod"
  });
  assert.equal(got, "env-val");
});

test("resolveConnectionSecret: falls through tenant miss to global hit", async () => {
  const p = freshProvider();
  // No tenant secret; only global.
  await p.put({ scope: "global", key: "ONLY_GLOBAL" }, "g");
  const got = await resolveConnectionSecret(p, {
    key: "ONLY_GLOBAL",
    tenantId: "t1",
    environment: "prod"
  });
  assert.equal(got, "g");
});

test("resolveConnectionSecret: returns undefined when no scope has the key (driver decides if fatal)", async () => {
  const p = freshProvider();
  const got = await resolveConnectionSecret(p, {
    key: "MISSING",
    tenantId: "t1"
  });
  assert.equal(got, undefined);
});

test("resolveConnectionSecret: no tenant boundary → only the global scope is attempted", async () => {
  const p = freshProvider();
  await p.put({ scope: "global", key: "G" }, "g");
  // A tenant secret with the same key must NOT be reachable without a
  // tenant boundary (no cross-tenant leak).
  await p.put({ scope: "tenant", tenantId: "t1", key: "G" }, "t");
  const got = await resolveConnectionSecret(p, { key: "G" });
  assert.equal(got, "g");
});

test("resolveConnectionSecret: a tenant boundary never leaks ANOTHER tenant's secret", async () => {
  const p = freshProvider();
  // Secret lives under tenant-b only.
  await p.put({ scope: "tenant", tenantId: "tenant-b", key: "K" }, "b-secret");
  // A connection running under tenant-a with the same key resolves
  // nothing (the tenant ref is keyed to tenant-a → miss; no global).
  const got = await resolveConnectionSecret(p, { key: "K", tenantId: "tenant-a" });
  assert.equal(got, undefined);
});
