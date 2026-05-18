import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  ConflictError,
  InMemoryApiKeyRepository,
  InMemoryConfigDefinitionRepository,
  InMemoryConfigValueRepository,
  InMemoryExecutionStore,
  InMemoryPipelineDeploymentRepository,
  InMemoryPipelineVersionRepository,
  InMemoryTenantPipelineRepository,
  InMemoryTenantRepository,
  InMemoryUsageRecordRepository,
  NotFoundError
} from "../src/index.ts";
import { defaultMigrationsDir } from "../src/migrate.ts";
import { readdir } from "node:fs/promises";

test("tenant CRUD + findBySlug", async () => {
  const repo = new InMemoryTenantRepository();
  const now = new Date().toISOString();
  const created = await repo.create({
    id: randomUUID(),
    slug: "tenant-a",
    name: "Tenant A",
    status: "active",
    metadata: {},
    createdAt: now,
    updatedAt: now
  });
  assert.equal((await repo.findBySlug("tenant-a"))?.id, created.id);
  const updated = await repo.update(created.id, { name: "Renamed" });
  assert.equal(updated.name, "Renamed");
  await repo.delete(created.id);
  assert.equal(await repo.get(created.id), undefined);
  await assert.rejects(repo.require(created.id), NotFoundError);
});

test("create rejects duplicate id", async () => {
  const repo = new InMemoryTenantRepository();
  const now = new Date().toISOString();
  const row = {
    id: "fixed",
    slug: "s",
    name: "n",
    status: "active",
    metadata: {},
    createdAt: now,
    updatedAt: now
  };
  await repo.create(row);
  await assert.rejects(repo.create(row), ConflictError);
});

test("pipeline version + deployment scoping", async () => {
  const versions = new InMemoryPipelineVersionRepository();
  const deployments = new InMemoryPipelineDeploymentRepository();
  const pipelineId = randomUUID();
  const otherPipeline = randomUUID();
  const now = new Date().toISOString();

  await versions.create({
    id: randomUUID(),
    pipelineId,
    version: "1.0.0",
    status: "published",
    spec: {},
    checksum: "abc",
    createdAt: now
  });
  await versions.create({
    id: randomUUID(),
    pipelineId: otherPipeline,
    version: "1.0.0",
    status: "draft",
    spec: {},
    checksum: "def",
    createdAt: now
  });

  const byPipeline = await versions.listByPipeline(pipelineId);
  assert.equal(byPipeline.length, 1);
  assert.equal(
    (await versions.findByVersion(pipelineId, "1.0.0"))?.checksum,
    "abc"
  );

  const versionId = byPipeline[0].id;
  await deployments.create({
    id: randomUUID(),
    pipelineId,
    pipelineVersionId: versionId,
    environment: "prod",
    tenantId: "tenant-1",
    status: "active",
    deployedAt: now
  });
  const active = await deployments.getActiveDeployment(
    pipelineId,
    "prod",
    "tenant-1"
  );
  assert.equal(active?.pipelineVersionId, versionId);
  assert.equal(
    await deployments.getActiveDeployment(pipelineId, "prod", "tenant-2"),
    undefined
  );
  assert.equal(
    await deployments.getActiveDeployment(pipelineId, "dev", "tenant-1"),
    undefined
  );
});

test("config value upsert is unique by (key, scope, scopeId)", async () => {
  const defs = new InMemoryConfigDefinitionRepository();
  await defs.upsert({
    key: "llm.model",
    type: "string",
    allowedScopes: ["global", "tenant"],
    required: false,
    secret: false,
    sensitive: false,
    overridable: true,
    inherited: true,
    nullable: false,
    tenantOverridable: true,
    runtimeOverridable: false,
    validation: {}
  });
  assert.equal((await defs.require("llm.model")).type, "string");

  const values = new InMemoryConfigValueRepository();
  const first = await values.upsert({
    key: "llm.model",
    value: "gpt-4o-mini",
    scope: "global",
    scopeId: null,
    locked: false
  });
  const second = await values.upsert({
    key: "llm.model",
    value: "gpt-4o",
    scope: "global",
    scopeId: null,
    locked: true
  });
  assert.equal(first.id, second.id, "same id reused for same scope key");
  assert.equal(first.createdAt, second.createdAt, "createdAt preserved");

  const all = await values.listConfigValues({ key: "llm.model" });
  assert.equal(all.length, 1);
  assert.equal(all[0].value, "gpt-4o");
  assert.equal(all[0].locked, true);

  // A different scopeId is a distinct row.
  await values.upsert({
    key: "llm.model",
    value: "claude",
    scope: "tenant",
    scopeId: "tenant-a",
    locked: false
  });
  assert.equal((await values.listConfigValues({ key: "llm.model" })).length, 2);
  assert.equal(
    (await values.listConfigValues({ scope: "tenant", scopeId: "tenant-a" }))
      .length,
    1
  );
});

test("tenant_pipeline composite-key repo", async () => {
  const repo = new InMemoryTenantPipelineRepository();
  const now = new Date().toISOString();
  const key = { tenantId: "t1", pipelineId: "p1", environment: "prod" };
  await repo.upsert({
    ...key,
    enabled: true,
    vectorIsolation: {},
    providerPolicy: {},
    rateLimitPolicy: {},
    createdAt: now,
    updatedAt: now
  });
  assert.equal((await repo.require(key)).enabled, true);
  await repo.upsert({
    ...key,
    enabled: false,
    vectorIsolation: {},
    providerPolicy: {},
    rateLimitPolicy: {},
    createdAt: now,
    updatedAt: now
  });
  assert.equal((await repo.get(key))?.enabled, false);
  assert.equal((await repo.listByTenant("t1")).length, 1);
  await repo.delete(key);
  await assert.rejects(repo.require(key), NotFoundError);
});

test("api key repo create/find/touch/revoke + prefix uniqueness", async () => {
  const repo = new InMemoryApiKeyRepository();
  const id = randomUUID();
  const principalId = randomUUID();
  await repo.create({
    id,
    tenantId: "tenant-a",
    principalId,
    name: "ci-key",
    prefix: "rk_abc",
    hash: "hashed",
    roles: ["pipeline_editor"],
    createdAt: new Date().toISOString()
  });

  const found = await repo.findByPrefix("rk_abc");
  assert.equal(found?.id, id);
  assert.equal(found?.revokedAt ?? null, null);

  await repo.touch(id, "2026-01-01T00:00:00.000Z");
  assert.equal(
    (await repo.findByPrefix("rk_abc"))?.lastUsedAt,
    "2026-01-01T00:00:00.000Z"
  );

  await repo.revoke(id, "2026-02-01T00:00:00.000Z");
  assert.equal(
    (await repo.findByPrefix("rk_abc"))?.revokedAt,
    "2026-02-01T00:00:00.000Z"
  );

  assert.equal((await repo.listByPrincipal(principalId)).length, 1);

  await assert.rejects(
    repo.create({
      id: randomUUID(),
      principalId,
      name: "dup",
      prefix: "rk_abc",
      hash: "x",
      roles: [],
      createdAt: new Date().toISOString()
    }),
    ConflictError
  );
  await assert.rejects(repo.touch(randomUUID()), NotFoundError);
  await assert.rejects(repo.revoke(randomUUID()), NotFoundError);
});

test("in-memory ExecutionStore matches runtime contract behavior", async () => {
  const store = new InMemoryExecutionStore();
  await store.start({
    executionId: "exec-1",
    tenantId: "t1",
    pipelineId: "p1",
    pipelineVersionId: "v1",
    status: "running",
    startedAt: new Date().toISOString()
  });
  assert.equal(store.executions.length, 1);
  await store.complete({
    executionId: "exec-1",
    tenantId: "t1",
    pipelineId: "p1",
    pipelineVersionId: "v1",
    status: "succeeded",
    startedAt: store.executions[0].startedAt,
    completedAt: new Date().toISOString()
  });
  assert.equal(store.executions.length, 1, "complete replaces, not appends");
  assert.equal(store.executions[0].status, "succeeded");

  await store.startNode({
    executionId: "exec-1",
    nodeId: "n1",
    status: "running",
    startedAt: new Date().toISOString()
  });
  await store.completeNode({
    executionId: "exec-1",
    nodeId: "n1",
    status: "succeeded",
    startedAt: store.nodes[0].startedAt,
    completedAt: new Date().toISOString()
  });
  assert.equal(store.nodes.length, 1);
  assert.equal(store.nodes[0].status, "succeeded");

  await store.recordUsage({
    tenantId: "t1",
    pipelineId: "p1",
    executionId: "exec-1",
    success: true
  });
  assert.equal(store.usage.length, 1);
});

test("usage record repo append + filter", async () => {
  const repo = new InMemoryUsageRecordRepository();
  await repo.append({
    tenantId: "t1",
    pipelineId: "p1",
    executionId: "e1",
    inputTokens: 10,
    outputTokens: 5,
    embeddingTokens: 0,
    estimatedCostUsd: 0.001,
    success: true
  });
  await repo.append({
    tenantId: "t2",
    pipelineId: "p2",
    executionId: "e2",
    inputTokens: 1,
    outputTokens: 1,
    embeddingTokens: 0,
    estimatedCostUsd: 0,
    success: false
  });
  assert.equal((await repo.list({ tenantId: "t1" })).length, 1);
  assert.equal((await repo.list({ executionId: "e2" })).length, 1);
  assert.equal((await repo.list()).length, 2);
});

test("migrations directory resolves and contains ordered sql files", async () => {
  const dir = defaultMigrationsDir();
  const files = (await readdir(dir)).filter((f: string) => f.endsWith(".sql")).sort();
  assert.ok(files.includes("001_initial_schema.sql"));
  assert.ok(files.includes("002_auth.sql"));
  assert.deepEqual([...files], files.slice().sort());
});
