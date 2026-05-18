import test from "node:test";
import assert from "node:assert/strict";
import {
  DatabaseEncryptedSecretProvider,
  InMemorySecretRepository,
  SecretAccessDeniedError,
  StaticKeyProvider,
  redactedSecretList
} from "../src/index.ts";

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
