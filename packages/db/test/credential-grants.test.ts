import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { InMemoryConnectionCredentialGrantRepository } from "../src/index.ts";
import type { ConnectionCredentialGrantRow } from "../src/index.ts";

function grant(
  patch: Partial<ConnectionCredentialGrantRow> = {}
): ConnectionCredentialGrantRow {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    token: `tok-${randomUUID()}`,
    executionId: randomUUID(),
    nodeId: "node-a",
    tenantId: randomUUID(),
    environment: "prod",
    connectionSlug: "warehouse",
    expiresAt: "2999-01-01T00:00:00.000Z",
    redeemCount: 0,
    createdAt: now,
    ...patch
  };
}

test("create + getByToken round-trip", async () => {
  const repo = new InMemoryConnectionCredentialGrantRepository();
  const row = grant();
  const created = await repo.create(row);
  assert.deepEqual(created, row);
  const fetched = await repo.getByToken(row.token);
  assert.deepEqual(fetched, row);
  // Stored copy is independent of the caller's object.
  fetched!.connectionSlug = "mutated";
  assert.equal((await repo.getByToken(row.token))?.connectionSlug, "warehouse");
});

test("getByToken on unknown token returns undefined", async () => {
  const repo = new InMemoryConnectionCredentialGrantRepository();
  assert.equal(await repo.getByToken("nope"), undefined);
});

test("recordRedemption increments count + stamps lastRedeemedAt", async () => {
  const repo = new InMemoryConnectionCredentialGrantRepository();
  const row = grant();
  await repo.create(row);

  await repo.recordRedemption(row.token, "2026-01-01T00:00:00.000Z");
  let after = await repo.getByToken(row.token);
  assert.equal(after?.redeemCount, 1);
  assert.equal(after?.lastRedeemedAt, "2026-01-01T00:00:00.000Z");

  await repo.recordRedemption(row.token, "2026-01-02T00:00:00.000Z");
  after = await repo.getByToken(row.token);
  assert.equal(after?.redeemCount, 2);
  assert.equal(after?.lastRedeemedAt, "2026-01-02T00:00:00.000Z");
});

test("recordRedemption is a no-op on unknown token", async () => {
  const repo = new InMemoryConnectionCredentialGrantRepository();
  await repo.recordRedemption("nope", "2026-01-01T00:00:00.000Z");
  assert.equal(await repo.getByToken("nope"), undefined);
});

test("revokeForExecution stamps revokedAt, scoped to the execution", async () => {
  const repo = new InMemoryConnectionCredentialGrantRepository();
  const execution = randomUUID();
  const a = grant({ executionId: execution });
  const b = grant({ executionId: execution });
  const other = grant({ executionId: randomUUID() });
  await repo.create(a);
  await repo.create(b);
  await repo.create(other);

  const at = "2026-03-01T00:00:00.000Z";
  const count = await repo.revokeForExecution(execution, at);
  assert.equal(count, 2);
  assert.equal((await repo.getByToken(a.token))?.revokedAt, at);
  assert.equal((await repo.getByToken(b.token))?.revokedAt, at);
  // A grant for a different execution is untouched.
  assert.equal((await repo.getByToken(other.token))?.revokedAt, undefined);
});

test("revokeForExecution does not re-count an already-revoked grant", async () => {
  const repo = new InMemoryConnectionCredentialGrantRepository();
  const execution = randomUUID();
  const live = grant({ executionId: execution });
  const already = grant({
    executionId: execution,
    revokedAt: "2026-02-01T00:00:00.000Z"
  });
  await repo.create(live);
  await repo.create(already);

  const at = "2026-03-01T00:00:00.000Z";
  const count = await repo.revokeForExecution(execution, at);
  assert.equal(count, 1);
  assert.equal((await repo.getByToken(live.token))?.revokedAt, at);
  // The pre-revoked grant keeps its original timestamp.
  assert.equal(
    (await repo.getByToken(already.token))?.revokedAt,
    "2026-02-01T00:00:00.000Z"
  );

  // A second sweep flips nothing.
  assert.equal(await repo.revokeForExecution(execution, at), 0);
});

test("deleteExpired removes only past-expiry rows + returns the count", async () => {
  const repo = new InMemoryConnectionCredentialGrantRepository();
  const past = grant({ expiresAt: "2020-01-01T00:00:00.000Z" });
  const atBoundary = grant({ expiresAt: "2026-06-01T00:00:00.000Z" });
  const future = grant({ expiresAt: "2999-01-01T00:00:00.000Z" });
  await repo.create(past);
  await repo.create(atBoundary);
  await repo.create(future);

  const now = "2026-06-01T00:00:00.000Z";
  const removed = await repo.deleteExpired(now);
  // past (<) and atBoundary (==) go; future stays.
  assert.equal(removed, 2);
  assert.equal(await repo.getByToken(past.token), undefined);
  assert.equal(await repo.getByToken(atBoundary.token), undefined);
  assert.ok(await repo.getByToken(future.token));
});
