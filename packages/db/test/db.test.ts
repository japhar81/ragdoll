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
  NotFoundError,
  PostgresAuditLogRepository,
  PostgresConfigDefinitionRepository,
  PostgresExecutionStore,
  stringifyForTrace,
  PostgresPipelineRepository,
  PostgresProviderRepository,
  PostgresVectorCollectionRepository,
  toUuidOrNull
} from "../src/index.ts";
import type { PoolLike, QueryResultLike } from "../src/pool.ts";
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
    environment: "test",
    status: "running",
    startedAt: new Date().toISOString()
  });
  assert.equal(store.executions.length, 1);
  await store.complete({
    executionId: "exec-1",
    tenantId: "t1",
    pipelineId: "p1",
    pipelineVersionId: "v1",
    environment: "test",
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

/**
 * A scripted fake `PoolLike` that records every SQL call and replays canned
 * result rows. Lets the Postgres repos be unit-tested for table name + column
 * mapping with no `pg` import (keeps `npm test` install-free / offline).
 */
class FakePool implements PoolLike {
  calls: Array<{ text: string; params: unknown[] }> = [];
  private results: QueryResultLike[];
  private cursor = 0;

  constructor(results: QueryResultLike[]) {
    this.results = results;
  }

  async query<R = Record<string, unknown>>(
    text: string,
    params: unknown[] = []
  ): Promise<QueryResultLike<R>> {
    this.calls.push({ text, params });
    const next = this.results[this.cursor] ?? { rows: [], rowCount: 0 };
    this.cursor += 1;
    return next as QueryResultLike<R>;
  }

  async connect(): Promise<never> {
    throw new Error("connect not used in these tests");
  }

  async end(): Promise<void> {}
}

test("PostgresPipelineRepository maps table/columns and findBySlug", async () => {
  const pool = new FakePool([
    {
      rows: [
        {
          id: "p1",
          slug: "local-demo",
          name: "Local Demo",
          description: null,
          labels: {},
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z"
        }
      ],
      rowCount: 1
    }
  ]);
  const repo = new PostgresPipelineRepository(pool);
  const found = await repo.findBySlug("local-demo");
  assert.equal(found?.id, "p1");
  assert.equal(found?.slug, "local-demo");
  assert.match(pool.calls[0].text, /FROM pipelines WHERE slug = \$1/);
  assert.deepEqual(pool.calls[0].params, ["local-demo"]);
});

test("PostgresProviderRepository.findByProviderId targets providers table", async () => {
  const pool = new FakePool([
    {
      rows: [
        {
          id: "pr1",
          provider_id: "ollama",
          display_name: "Ollama-compatible",
          config: {},
          enabled: true,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z"
        }
      ],
      rowCount: 1
    }
  ]);
  const repo = new PostgresProviderRepository(pool);
  const found = await repo.findByProviderId("ollama");
  assert.equal(found?.providerId, "ollama");
  assert.equal(found?.displayName, "Ollama-compatible");
  assert.match(pool.calls[0].text, /FROM providers WHERE provider_id = \$1/);
});

test("PostgresVectorCollectionRepository.findByName maps embeddingProfile", async () => {
  const pool = new FakePool([
    {
      rows: [
        {
          id: "vc1",
          tenant_id: "t1",
          pipeline_id: "p1",
          environment: "dev",
          collection_name: "rag_dev",
          isolation_mode: "shared_collection_tenant_filter",
          embedding_profile: { provider: "ollama", dimensions: 768 },
          created_at: "2026-01-01T00:00:00.000Z"
        }
      ],
      rowCount: 1
    }
  ]);
  const repo = new PostgresVectorCollectionRepository(pool);
  const found = await repo.findByName("rag_dev");
  assert.equal(found?.collectionName, "rag_dev");
  assert.deepEqual(found?.embeddingProfile, {
    provider: "ollama",
    dimensions: 768
  });
  assert.match(
    pool.calls[0].text,
    /FROM vector_collections WHERE collection_name = \$1/
  );
});

test("PostgresConfigDefinitionRepository upsert/list maps key-scoped rows", async () => {
  const dbRow = {
    key: "llm.provider",
    type: "string",
    default_value: "openai",
    allowed_scopes: ["global", "tenant"],
    required: false,
    secret: false,
    sensitive: false,
    overridable: true,
    inherited: true,
    nullable: false,
    tenant_overridable: true,
    runtime_overridable: true,
    validation: {},
    description: "Default chat provider"
  };
  const pool = new FakePool([
    { rows: [dbRow], rowCount: 1 },
    { rows: [dbRow], rowCount: 1 }
  ]);
  const repo = new PostgresConfigDefinitionRepository(pool);
  const saved = await repo.upsert({
    key: "llm.provider",
    type: "string",
    defaultValue: "openai",
    allowedScopes: ["global", "tenant"],
    required: false,
    secret: false,
    sensitive: false,
    overridable: true,
    inherited: true,
    nullable: false,
    tenantOverridable: true,
    runtimeOverridable: true,
    validation: {},
    description: "Default chat provider"
  });
  assert.equal(saved.key, "llm.provider");
  assert.equal(saved.tenantOverridable, true);
  assert.match(
    pool.calls[0].text,
    /INSERT INTO config_definitions[\s\S]*ON CONFLICT \(key\) DO UPDATE/
  );
  const all = await repo.list();
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].allowedScopes, ["global", "tenant"]);
});

test("toUuidOrNull coerces non-UUID actor ids to null", () => {
  const uuid = "11111111-2222-4333-8444-555555555555";
  assert.equal(toUuidOrNull(uuid), uuid);
  assert.equal(toUuidOrNull("smoke"), null);
  assert.equal(toUuidOrNull("dev-user"), null);
  assert.equal(toUuidOrNull(undefined), null);
  assert.equal(toUuidOrNull(null), null);
});

test("PostgresAuditLogRepository.append nulls non-UUID actor/tenant/pipeline", async () => {
  const pool = new FakePool([
    {
      rows: [
        {
          id: "a1",
          actor_id: null,
          tenant_id: null,
          pipeline_id: null,
          action: "pipeline.run",
          target_type: "execution",
          target_id: "exec-1",
          before_redacted: null,
          after_redacted: null,
          request_id: null,
          source_ip: null,
          user_agent: null,
          created_at: "2026-01-01T00:00:00.000Z"
        }
      ],
      rowCount: 1
    }
  ]);
  const repo = new PostgresAuditLogRepository(pool);
  await repo.append({
    actorId: "smoke",
    tenantId: "tenant-local",
    pipelineId: "not-a-uuid",
    action: "pipeline.run",
    targetType: "execution",
    targetId: "exec-1",
    requestId: null,
    sourceIp: null,
    userAgent: null,
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  assert.match(pool.calls[0].text, /INSERT INTO audit_logs/);
  // params: actor_id, tenant_id, pipeline_id, action, ...
  assert.equal(pool.calls[0].params[0], null);
  assert.equal(pool.calls[0].params[1], null);
  assert.equal(pool.calls[0].params[2], null);
});

test("PostgresExecutionStore reader maps execution + node rows", async () => {
  const pool = new FakePool([
    {
      rows: [
        {
          execution_id: "exec-1",
          tenant_id: "t1",
          pipeline_id: "p1",
          pipeline_version_id: "v1",
          environment: "dev",
          status: "succeeded",
          input_redacted: { question: "hi" },
          output_redacted: { answer: "ok" },
          error: null,
          started_at: "2026-01-01T00:00:00.000Z",
          completed_at: "2026-01-01T00:00:05.000Z"
        }
      ],
      rowCount: 1
    },
    {
      rows: [
        {
          execution_id: "exec-1",
          node_id: "llm",
          status: "succeeded",
          input_redacted: null,
          output_redacted: { text: "ok" },
          error: null,
          latency_ms: 1200,
          started_at: "2026-01-01T00:00:01.000Z",
          completed_at: "2026-01-01T00:00:04.000Z"
        }
      ],
      rowCount: 1
    },
    {
      rows: [
        {
          execution_id: "exec-1",
          tenant_id: "t1",
          pipeline_id: "p1",
          pipeline_version_id: "v1",
          environment: "dev",
          status: "running",
          input_redacted: null,
          output_redacted: null,
          error: null,
          started_at: "2026-01-01T00:00:00.000Z",
          completed_at: null
        }
      ],
      rowCount: 1
    }
  ]);
  const store = new PostgresExecutionStore(pool);

  const one = await store.getExecution("exec-1");
  assert.equal(one?.executionId, "exec-1");
  assert.equal(one?.status, "succeeded");
  assert.deepEqual(one?.output, { answer: "ok" });
  assert.equal(one?.completedAt, "2026-01-01T00:00:05.000Z");
  assert.match(pool.calls[0].text, /FROM executions WHERE execution_id = \$1/);

  const nodes = await store.listNodes("exec-1");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].nodeId, "llm");
  assert.equal(nodes[0].latencyMs, 1200);
  assert.match(
    pool.calls[1].text,
    /FROM execution_nodes WHERE execution_id = \$1/
  );

  const scoped = await store.listExecutions("t1");
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].tenantId, "t1");
  assert.match(
    pool.calls[2].text,
    /FROM executions WHERE tenant_id = \$1/
  );
});

test("stringifyForTrace passes small payloads through unchanged", () => {
  assert.equal(stringifyForTrace(undefined), null);
  assert.equal(stringifyForTrace({ a: 1 }), JSON.stringify({ a: 1 }));
  assert.equal(stringifyForTrace([1, 2, 3]), JSON.stringify([1, 2, 3]));
});

test("stringifyForTrace replaces oversize array with a length sentinel", () => {
  // Build a payload whose JSON well exceeds the default 8 MiB cap.
  const bigStr = "x".repeat(10_000);
  const arr = Array.from({ length: 1000 }, (_, i) => ({ id: i, blob: bigStr }));
  const out = stringifyForTrace(arr);
  assert.ok(out !== null);
  const parsed = JSON.parse(out!);
  assert.equal(parsed.__truncated, true);
  assert.equal(parsed.kind, "array");
  assert.equal(parsed.length, 1000);
  assert.ok(parsed.originalBytes > 8 * 1024 * 1024);
  // Sentinel itself must be tiny so it never blows the cap a second time.
  assert.ok(out!.length < 1024);
});

test("stringifyForTrace replaces oversize object with a keys sentinel", () => {
  const bigStr = "x".repeat(10_000_000);
  const obj = { hugeBlob: bigStr, k2: 2, k3: 3 };
  const out = stringifyForTrace(obj);
  assert.ok(out !== null);
  const parsed = JSON.parse(out!);
  assert.equal(parsed.__truncated, true);
  assert.equal(parsed.kind, "object");
  assert.deepEqual(parsed.keys, ["hugeBlob", "k2", "k3"]);
});
