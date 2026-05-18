import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  ConflictError,
  InMemoryPipelineActivationRepository,
  InMemoryPipelineFolderRepository,
  InMemoryPipelineRepository,
  InMemoryPipelineVersionRepository,
  InMemoryScheduleRepository,
  NotFoundError
} from "../src/index.ts";
import type { PoolLike, QueryResultLike } from "../src/pool.ts";
import { defaultMigrationsDir } from "../src/migrate.ts";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

test("migration 003 is ordered after 001/002 and is additive", async () => {
  const dir = defaultMigrationsDir();
  const files = (await readdir(dir))
    .filter((f: string) => f.endsWith(".sql"))
    .sort((a: string, b: string) => a.localeCompare(b));
  assert.deepEqual(files, [
    "001_initial_schema.sql",
    "002_auth.sql",
    "003_org_and_scheduler.sql"
  ]);
  const sql = await readFile(join(dir, "003_org_and_scheduler.sql"), "utf8");
  assert.match(sql, /CREATE TABLE pipeline_folders/);
  assert.match(sql, /CREATE TABLE pipeline_activations/);
  assert.match(sql, /CREATE TABLE schedules/);
  assert.match(sql, /ALTER TABLE pipelines\s+ADD COLUMN folder_id/);
  assert.match(sql, /ADD COLUMN latest_version_id/);
  assert.match(sql, /ALTER TABLE pipeline_versions\s+ADD COLUMN parent_version_id/);
  // Must not touch existing tables destructively / drop pipeline_deployments.
  assert.doesNotMatch(sql, /DROP TABLE/i);
  assert.doesNotMatch(sql, /ALTER TABLE tenant_pipelines ADD COLUMN enabled/i);
});

test("pipeline folder tree + delete blocks when non-empty", async () => {
  const folders = new InMemoryPipelineFolderRepository();
  const now = new Date().toISOString();

  const root = await folders.create({
    id: randomUUID(),
    parentId: null,
    name: "root",
    createdAt: now
  });
  const childA = await folders.create({
    id: randomUUID(),
    parentId: root.id,
    name: "a",
    createdAt: now
  });
  const childB = await folders.create({
    id: randomUUID(),
    parentId: root.id,
    name: "b",
    createdAt: now
  });
  const grandchild = await folders.create({
    id: randomUUID(),
    parentId: childA.id,
    name: "deep",
    createdAt: now
  });

  // Duplicate (parentId, name) is a conflict.
  await assert.rejects(
    folders.create({
      id: randomUUID(),
      parentId: root.id,
      name: "a",
      createdAt: now
    }),
    ConflictError
  );

  const children = await folders.listChildren(root.id);
  assert.equal(children.length, 2);
  assert.equal((await folders.listChildren(null)).length, 1);

  const tree = await folders.tree();
  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, root.id);
  assert.equal(tree[0].children.length, 2);
  assert.deepEqual(
    tree[0].children.map((c) => c.name),
    ["a", "b"]
  );
  assert.equal(tree[0].children[0].children[0].id, grandchild.id);

  // Cannot delete a folder that has child folders.
  await assert.rejects(folders.delete(root.id), ConflictError);
  await assert.rejects(folders.delete(childA.id), ConflictError);

  // Cannot delete a folder that has pipelines.
  folders.trackPipelineFolder("pipeline-1", childB.id);
  await assert.rejects(folders.delete(childB.id), ConflictError);

  // Detach the pipeline, then deletion in leaf->root order succeeds.
  folders.trackPipelineFolder("pipeline-1", null);
  await folders.delete(grandchild.id);
  await folders.delete(childA.id);
  await folders.delete(childB.id);
  await folders.delete(root.id);
  assert.equal((await folders.list()).length, 0);

  // rename guards uniqueness too.
  const f1 = await folders.create({
    id: randomUUID(),
    parentId: null,
    name: "one",
    createdAt: now
  });
  await folders.create({
    id: randomUUID(),
    parentId: null,
    name: "two",
    createdAt: now
  });
  await assert.rejects(folders.rename(f1.id, "two"), ConflictError);
  const renamed = await folders.rename(f1.id, "uno");
  assert.equal(renamed.name, "uno");
});

test("pipeline setLatestVersion / setFolder", async () => {
  const pipelines = new InMemoryPipelineRepository();
  const versions = new InMemoryPipelineVersionRepository();
  const now = new Date().toISOString();
  const pipelineId = randomUUID();

  await pipelines.create({
    id: pipelineId,
    slug: "p",
    name: "P",
    labels: {},
    createdAt: now,
    updatedAt: now
  });
  const v1 = await versions.create({
    id: randomUUID(),
    pipelineId,
    version: "1.0.0",
    status: "published",
    spec: {},
    checksum: "c1",
    createdAt: now
  });
  const v2 = await versions.create({
    id: randomUUID(),
    pipelineId,
    version: "2.0.0",
    status: "draft",
    spec: {},
    checksum: "c2",
    parentVersionId: v1.id,
    createdAt: now
  });
  assert.equal(v2.parentVersionId, v1.id);

  const withLatest = await pipelines.setLatestVersion(pipelineId, v2.id);
  assert.equal(withLatest.latestVersionId, v2.id);

  const folderId = randomUUID();
  const withFolder = await pipelines.setFolder(pipelineId, folderId);
  assert.equal(withFolder.folderId, folderId);

  const cleared = await pipelines.setFolder(pipelineId, null);
  assert.equal(cleared.folderId, null);

  await assert.rejects(
    pipelines.setLatestVersion(randomUUID(), v1.id),
    NotFoundError
  );
});

test("activations: concurrent labels + duplicate conflict + update/delete", async () => {
  const repo = new InMemoryPipelineActivationRepository();
  const now = new Date().toISOString();
  const tenantId = randomUUID();
  const pipelineId = randomUUID();
  const otherPipeline = randomUUID();
  const vStable = randomUUID();
  const vCanary = randomUUID();

  const stable = await repo.create({
    id: randomUUID(),
    tenantId,
    pipelineId,
    environment: "prod",
    label: "stable",
    pipelineVersionId: vStable,
    trackLatest: false,
    enabled: true,
    createdAt: now
  });
  const canary = await repo.create({
    id: randomUUID(),
    tenantId,
    pipelineId,
    environment: "prod",
    label: "canary",
    pipelineVersionId: vCanary,
    trackLatest: false,
    enabled: true,
    createdAt: now
  });
  // A third concurrent label tracking latest.
  await repo.create({
    id: randomUUID(),
    tenantId,
    pipelineId,
    environment: "prod",
    label: "edge",
    pipelineVersionId: null,
    trackLatest: true,
    enabled: true,
    createdAt: now
  });
  // Same label but different environment is allowed.
  await repo.create({
    id: randomUUID(),
    tenantId,
    pipelineId,
    environment: "dev",
    label: "stable",
    pipelineVersionId: vStable,
    trackLatest: false,
    enabled: true,
    createdAt: now
  });
  // Unrelated pipeline.
  await repo.create({
    id: randomUUID(),
    tenantId,
    pipelineId: otherPipeline,
    environment: "prod",
    label: "stable",
    pipelineVersionId: vStable,
    trackLatest: false,
    enabled: true,
    createdAt: now
  });

  const prod = await repo.listByTenantPipelineEnv(
    tenantId,
    pipelineId,
    "prod"
  );
  assert.equal(prod.length, 3, "3 concurrent labels in prod");
  assert.deepEqual(
    prod.map((a) => a.label).sort(),
    ["canary", "edge", "stable"]
  );
  assert.equal((await repo.listByTenant(tenantId)).length, 5);
  assert.equal((await repo.listByPipeline(pipelineId)).length, 4);

  // Duplicate (tenant,pipeline,env,label) -> conflict.
  await assert.rejects(
    repo.create({
      id: randomUUID(),
      tenantId,
      pipelineId,
      environment: "prod",
      label: "stable",
      pipelineVersionId: vCanary,
      trackLatest: false,
      enabled: true,
      createdAt: now
    }),
    ConflictError
  );

  const updated = await repo.update(canary.id, {
    enabled: false,
    trackLatest: true,
    pipelineVersionId: null,
    label: "canary-2"
  });
  assert.equal(updated.enabled, false);
  assert.equal(updated.trackLatest, true);
  assert.equal(updated.pipelineVersionId, null);
  assert.equal(updated.label, "canary-2");

  await repo.delete(stable.id);
  assert.equal(
    (await repo.listByTenantPipelineEnv(tenantId, pipelineId, "prod")).length,
    2
  );
});

test("schedules: listDue / listEnabled / markRun", async () => {
  const repo = new InMemoryScheduleRepository();
  const now = "2026-05-18T12:00:00.000Z";
  const tenantId = randomUUID();
  const pipelineId = randomUUID();

  const due = await repo.create({
    id: randomUUID(),
    tenantId,
    pipelineId,
    environment: "prod",
    activationLabel: "stable",
    cron: "*/5 * * * *",
    timezone: "UTC",
    input: { q: "hello" },
    enabled: true,
    lastRunAt: null,
    nextRunAt: "2026-05-18T11:59:00.000Z",
    createdAt: now
  });
  // Enabled but not yet due.
  await repo.create({
    id: randomUUID(),
    tenantId,
    pipelineId,
    environment: "prod",
    activationLabel: null,
    cron: "0 0 * * *",
    timezone: "UTC",
    input: {},
    enabled: true,
    lastRunAt: null,
    nextRunAt: "2026-05-19T00:00:00.000Z",
    createdAt: now
  });
  // Disabled even though past due.
  await repo.create({
    id: randomUUID(),
    tenantId,
    pipelineId,
    environment: "prod",
    activationLabel: null,
    cron: "0 0 * * *",
    timezone: "UTC",
    input: {},
    enabled: false,
    lastRunAt: null,
    nextRunAt: "2026-05-18T00:00:00.000Z",
    createdAt: now
  });
  // Enabled but next_run_at null (never scheduled).
  await repo.create({
    id: randomUUID(),
    tenantId,
    pipelineId,
    environment: "prod",
    activationLabel: null,
    cron: "0 0 * * *",
    timezone: "UTC",
    input: {},
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: now
  });

  assert.equal((await repo.listEnabled()).length, 3);
  const dueRows = await repo.listDue(now);
  assert.equal(dueRows.length, 1);
  assert.equal(dueRows[0].id, due.id);
  assert.deepEqual(dueRows[0].input, { q: "hello" });

  const ran = await repo.markRun(
    due.id,
    now,
    "2026-05-18T12:05:00.000Z"
  );
  assert.equal(ran.lastRunAt, now);
  assert.equal(ran.nextRunAt, "2026-05-18T12:05:00.000Z");
  assert.equal((await repo.listDue(now)).length, 0, "no longer due after markRun");

  // markRun can also clear next_run_at (one-shot schedule).
  const cleared = await repo.markRun(due.id, now, null);
  assert.equal(cleared.nextRunAt, null);
  await assert.rejects(repo.markRun(randomUUID(), now, null), NotFoundError);
});

/** Scripted fake pool: records SQL, replays canned rows, no `pg` import. */
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

test("PostgresScheduleRepository.listDue targets schedules with bound now", async () => {
  // Lazy import keeps the Postgres path off the default require graph.
  const { PostgresScheduleRepository } = await import("../src/index.ts");
  const pool = new FakePool([
    {
      rows: [
        {
          id: "s1",
          tenant_id: "t1",
          pipeline_id: "p1",
          environment: "prod",
          activation_label: "stable",
          cron: "*/5 * * * *",
          timezone: "UTC",
          input: { q: "x" },
          enabled: true,
          last_run_at: null,
          next_run_at: "2026-05-18T11:00:00.000Z",
          created_at: "2026-05-18T00:00:00.000Z"
        }
      ],
      rowCount: 1
    }
  ]);
  const repo = new PostgresScheduleRepository(pool);
  const due = await repo.listDue("2026-05-18T12:00:00.000Z");
  assert.equal(due.length, 1);
  assert.equal(due[0].id, "s1");
  assert.deepEqual(due[0].input, { q: "x" });
  assert.match(pool.calls[0].text, /FROM schedules[\s\S]*next_run_at <= \$1/);
  assert.deepEqual(pool.calls[0].params, ["2026-05-18T12:00:00.000Z"]);
});

test("PostgresPipelineActivationRepository.listByTenantPipelineEnv maps table", async () => {
  const { PostgresPipelineActivationRepository } = await import(
    "../src/index.ts"
  );
  const pool = new FakePool([
    {
      rows: [
        {
          id: "a1",
          tenant_id: "t1",
          pipeline_id: "p1",
          environment: "prod",
          label: "stable",
          pipeline_version_id: "v1",
          track_latest: false,
          enabled: true,
          created_at: "2026-05-18T00:00:00.000Z"
        }
      ],
      rowCount: 1
    }
  ]);
  const repo = new PostgresPipelineActivationRepository(pool);
  const rows = await repo.listByTenantPipelineEnv("t1", "p1", "prod");
  assert.equal(rows[0].label, "stable");
  assert.equal(rows[0].pipelineVersionId, "v1");
  assert.match(
    pool.calls[0].text,
    /FROM pipeline_activations\s+WHERE tenant_id = \$1 AND pipeline_id = \$2 AND environment = \$3/
  );
});

test("PostgresTenantPipelineRepository upsert/get/require/delete/listByTenant", async () => {
  const { PostgresTenantPipelineRepository, NotFoundError: NotFound } =
    await import("../src/index.ts");
  const dbRow = {
    tenant_id: "t1",
    pipeline_id: "p1",
    environment: "prod",
    enabled: true,
    vector_isolation: { mode: "collection_per_tenant_pipeline" },
    provider_policy: { allow: ["openai"] },
    rate_limit_policy: {},
    created_at: "2026-05-18T00:00:00.000Z",
    updated_at: "2026-05-18T00:00:00.000Z"
  };
  const pool = new FakePool([
    { rows: [dbRow], rowCount: 1 }, // upsert RETURNING *
    { rows: [dbRow], rowCount: 1 }, // get
    { rows: [], rowCount: 0 }, // require miss
    { rows: [], rowCount: 0 }, // delete
    { rows: [dbRow], rowCount: 1 } // listByTenant
  ]);
  const repo = new PostgresTenantPipelineRepository(pool);

  const saved = await repo.upsert({
    tenantId: "t1",
    pipelineId: "p1",
    environment: "prod",
    enabled: true,
    vectorIsolation: { mode: "collection_per_tenant_pipeline" },
    providerPolicy: { allow: ["openai"] },
    rateLimitPolicy: {},
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z"
  });
  assert.equal(saved.tenantId, "t1");
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.providerPolicy, { allow: ["openai"] });
  assert.match(
    pool.calls[0].text,
    /INSERT INTO tenant_pipelines[\s\S]*ON CONFLICT \(tenant_id, pipeline_id, environment\) DO UPDATE/
  );

  const key = { tenantId: "t1", pipelineId: "p1", environment: "prod" };
  const got = await repo.get(key);
  assert.equal(got?.pipelineId, "p1");
  assert.deepEqual(got?.vectorIsolation, {
    mode: "collection_per_tenant_pipeline"
  });
  assert.match(
    pool.calls[1].text,
    /FROM tenant_pipelines\s+WHERE tenant_id = \$1 AND pipeline_id = \$2 AND environment = \$3/
  );

  await assert.rejects(repo.require(key), NotFound);

  await repo.delete(key);
  assert.match(pool.calls[3].text, /DELETE FROM tenant_pipelines/);
  assert.deepEqual(pool.calls[3].params, ["t1", "p1", "prod"]);

  const list = await repo.listByTenant("t1");
  assert.equal(list.length, 1);
  assert.equal(list[0].tenantId, "t1");
  assert.match(
    pool.calls[4].text,
    /FROM tenant_pipelines WHERE tenant_id = \$1/
  );
});

test("PostgresTenantPipelineRepository upsert maps PK duplicate to ConflictError", async () => {
  const { PostgresTenantPipelineRepository } = await import("../src/index.ts");
  const failing: PoolLike = {
    async query() {
      throw new Error('duplicate key value violates unique constraint "tenant_pipelines_pkey"');
    },
    async connect(): Promise<never> {
      throw new Error("unused");
    },
    async end() {}
  };
  const repo = new PostgresTenantPipelineRepository(failing);
  await assert.rejects(
    repo.upsert({
      tenantId: "t1",
      pipelineId: "p1",
      environment: "prod",
      enabled: true,
      vectorIsolation: {},
      providerPolicy: {},
      rateLimitPolicy: {},
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z"
    }),
    ConflictError
  );
});

/**
 * For a generic `INSERT INTO t (c1, c2, ...) VALUES ($1, $2, ...)` call,
 * return the bound param value for `column` so we can assert a non-UUID
 * principal id was coerced to NULL (never bound raw into a uuid column).
 */
function paramForColumn(
  call: { text: string; params: unknown[] },
  column: string
): unknown {
  const cols = call.text
    .replace(/[\s\S]*?\(([^)]*)\)[\s\S]*/, "$1")
    .split(",")
    .map((c) => c.trim());
  const idx = cols.indexOf(column);
  assert.notEqual(idx, -1, `column ${column} present in INSERT`);
  return call.params[idx];
}

const NON_UUID = "dev-user";

test("PostgresPipelineRepository.create coerces non-UUID createdBy to NULL", async () => {
  const { PostgresPipelineRepository } = await import("../src/index.ts");
  const pool = new FakePool([
    { rows: [{ id: "p1", slug: "s", name: "n", labels: {} }], rowCount: 1 }
  ]);
  const repo = new PostgresPipelineRepository(pool);
  await repo.create({
    id: "p1",
    slug: "s",
    name: "n",
    labels: {},
    createdBy: NON_UUID,
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z"
  });
  assert.match(pool.calls[0].text, /INSERT INTO pipelines/);
  assert.equal(paramForColumn(pool.calls[0], "created_by"), null);
  assert.ok(
    !pool.calls[0].params.includes(NON_UUID),
    "raw non-UUID principal id never bound"
  );
});

test("PostgresPipelineVersionRepository.create coerces non-UUID createdBy", async () => {
  const { PostgresPipelineVersionRepository } = await import(
    "../src/index.ts"
  );
  const pool = new FakePool([{ rows: [{ id: "v1" }], rowCount: 1 }]);
  const repo = new PostgresPipelineVersionRepository(pool);
  await repo.create({
    id: "v1",
    pipelineId: "p1",
    version: "1.0.0",
    status: "draft",
    spec: {},
    checksum: "c1",
    createdBy: NON_UUID,
    createdAt: "2026-05-18T00:00:00.000Z"
  });
  assert.match(pool.calls[0].text, /INSERT INTO pipeline_versions/);
  assert.equal(paramForColumn(pool.calls[0], "created_by"), null);
  // A real UUID still passes through untouched.
  const uuid = "11111111-2222-4333-8444-555555555555";
  const pool2 = new FakePool([{ rows: [{ id: "v2" }], rowCount: 1 }]);
  const repo2 = new PostgresPipelineVersionRepository(pool2);
  await repo2.create({
    id: "v2",
    pipelineId: "p1",
    version: "2.0.0",
    status: "draft",
    spec: {},
    checksum: "c2",
    createdBy: uuid,
    createdAt: "2026-05-18T00:00:00.000Z"
  });
  assert.equal(paramForColumn(pool2.calls[0], "created_by"), uuid);
});

test("PostgresPipelineDeploymentRepository.create coerces non-UUID deployedBy", async () => {
  const { PostgresPipelineDeploymentRepository } = await import(
    "../src/index.ts"
  );
  const pool = new FakePool([{ rows: [{ id: "d1" }], rowCount: 1 }]);
  const repo = new PostgresPipelineDeploymentRepository(pool);
  await repo.create({
    id: "d1",
    pipelineId: "p1",
    pipelineVersionId: "v1",
    environment: "prod",
    tenantId: "t1",
    status: "active",
    deployedBy: NON_UUID,
    deployedAt: "2026-05-18T00:00:00.000Z"
  });
  assert.match(pool.calls[0].text, /INSERT INTO pipeline_deployments/);
  assert.equal(paramForColumn(pool.calls[0], "deployed_by"), null);
  // Real entity ids must NOT be coerced.
  assert.equal(paramForColumn(pool.calls[0], "pipeline_id"), "p1");
  assert.equal(paramForColumn(pool.calls[0], "pipeline_version_id"), "v1");
  assert.equal(paramForColumn(pool.calls[0], "tenant_id"), "t1");
});

test("PostgresConfigValueRepository.upsert coerces non-UUID createdBy to NULL", async () => {
  const { PostgresConfigValueRepository } = await import("../src/index.ts");
  const dbRow = {
    id: "cv1",
    key: "llm.model",
    value: "gpt",
    scope: "tenant",
    scope_id: "t1",
    locked: false,
    created_by: null,
    created_at: "2026-05-18T00:00:00.000Z",
    updated_at: "2026-05-18T00:00:00.000Z"
  };
  const pool = new FakePool([{ rows: [dbRow], rowCount: 1 }]);
  const repo = new PostgresConfigValueRepository(pool);
  await repo.upsert({
    key: "llm.model",
    value: "gpt",
    scope: "tenant",
    scopeId: "t1",
    locked: false,
    createdBy: NON_UUID
  });
  assert.match(pool.calls[0].text, /INSERT INTO config_values/);
  // params order: key, value, scope, scope_id, locked, created_by
  assert.equal(pool.calls[0].params[5], null);
  assert.ok(!pool.calls[0].params.includes(NON_UUID));
});
