/**
 * Pure tests for the per-environment connection cascade.
 *
 * Behaviour:
 *   - A row with `environmentId` matching the lookup env wins.
 *   - Otherwise the row with `environmentId === null` (= tenant-wide
 *     fallback) wins.
 *   - Otherwise the resolver returns undefined.
 *
 * The InMemory repo is the canonical reference implementation here;
 * the postgres repo runs the same semantics through a single
 * `ORDER BY environment_id DESC NULLS LAST LIMIT 1` query.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { InMemoryDatasourceConnectionRepository } from "../src/index.ts";
import type { DatasourceConnectionRow } from "../src/types.ts";

function row(
  partial: Partial<DatasourceConnectionRow> & { tenantId: string; name: string }
): DatasourceConnectionRow {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    tenantId: partial.tenantId,
    environmentId: partial.environmentId ?? null,
    name: partial.name,
    datasourceType: partial.datasourceType ?? "opensearch",
    secretRefId: partial.secretRefId ?? null,
    configRedacted: partial.configRedacted ?? {},
    allowedHosts: partial.allowedHosts ?? [],
    denyPrivateNetworks: partial.denyPrivateNetworks ?? true,
    createdAt: now,
    updatedAt: now
  };
}

test("resolveForEnv: env-specific row wins over tenant-wide fallback", async () => {
  const repo = new InMemoryDatasourceConnectionRepository();
  await repo.create(row({ tenantId: "t1", name: "os", environmentId: null, configRedacted: { host: "tenant-wide" } }));
  await repo.create(row({ tenantId: "t1", name: "os", environmentId: "prod", configRedacted: { host: "prod-host" } }));
  const winner = await repo.resolveForEnv("t1", "prod", "os");
  assert.ok(winner);
  assert.equal(winner.environmentId, "prod");
  assert.equal((winner.configRedacted as { host?: string }).host, "prod-host");
});

test("resolveForEnv: falls through to tenant-wide row when no env-specific match", async () => {
  const repo = new InMemoryDatasourceConnectionRepository();
  await repo.create(row({ tenantId: "t1", name: "os", environmentId: null, configRedacted: { host: "tenant-wide" } }));
  await repo.create(row({ tenantId: "t1", name: "os", environmentId: "prod", configRedacted: { host: "prod-host" } }));
  // Lookup for `dev` — no env-specific row exists, should return the
  // tenant-wide (env=null) row, not the prod row.
  const winner = await repo.resolveForEnv("t1", "dev", "os");
  assert.ok(winner);
  assert.equal(winner.environmentId, null);
  assert.equal((winner.configRedacted as { host?: string }).host, "tenant-wide");
});

test("resolveForEnv: undefined env still picks the tenant-wide row", async () => {
  const repo = new InMemoryDatasourceConnectionRepository();
  await repo.create(row({ tenantId: "t1", name: "os", environmentId: null, configRedacted: { host: "tenant-wide" } }));
  const winner = await repo.resolveForEnv("t1", undefined, "os");
  assert.ok(winner);
  assert.equal(winner.environmentId, null);
});

test("resolveForEnv: returns undefined when nothing matches", async () => {
  const repo = new InMemoryDatasourceConnectionRepository();
  await repo.create(row({ tenantId: "t1", name: "os", environmentId: "prod" }));
  // env-only row exists but we're looking up `dev` and there's no
  // tenant-wide fallback — must return undefined, NOT silently fall
  // through to the prod row.
  const winner = await repo.resolveForEnv("t1", "dev", "os");
  assert.equal(winner, undefined);
});

test("resolveForEnv: scoped per tenant — t1's row doesn't leak to t2", async () => {
  const repo = new InMemoryDatasourceConnectionRepository();
  await repo.create(row({ tenantId: "t1", name: "os", environmentId: null, configRedacted: { host: "t1-wide" } }));
  await repo.create(row({ tenantId: "t2", name: "os", environmentId: null, configRedacted: { host: "t2-wide" } }));
  const t1 = await repo.resolveForEnv("t1", "prod", "os");
  const t2 = await repo.resolveForEnv("t2", "prod", "os");
  assert.equal((t1?.configRedacted as { host?: string }).host, "t1-wide");
  assert.equal((t2?.configRedacted as { host?: string }).host, "t2-wide");
});

test("resolveForEnv: distinct names resolved independently", async () => {
  const repo = new InMemoryDatasourceConnectionRepository();
  await repo.create(row({ tenantId: "t1", name: "os", environmentId: "prod", configRedacted: { host: "os-prod" } }));
  await repo.create(row({ tenantId: "t1", name: "qdrant", environmentId: null, configRedacted: { host: "q-wide" } }));
  const os = await repo.resolveForEnv("t1", "prod", "os");
  const qdrant = await repo.resolveForEnv("t1", "prod", "qdrant");
  assert.equal((os?.configRedacted as { host?: string }).host, "os-prod");
  assert.equal((qdrant?.configRedacted as { host?: string }).host, "q-wide");
});

test("listByTenant returns every row for the tenant regardless of env", async () => {
  const repo = new InMemoryDatasourceConnectionRepository();
  await repo.create(row({ tenantId: "t1", name: "os", environmentId: null }));
  await repo.create(row({ tenantId: "t1", name: "os", environmentId: "prod" }));
  await repo.create(row({ tenantId: "t1", name: "qdrant", environmentId: null }));
  await repo.create(row({ tenantId: "t2", name: "os", environmentId: null }));
  const rows = await repo.listByTenant("t1");
  assert.equal(rows.length, 3);
});
