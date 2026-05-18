/**
 * Offline scheduler + effective-version resolution tests.
 *
 * node:test + InMemory repositories + InMemoryQueue only — no install, no
 * network, no bullmq/ioredis/pg on this path.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryQueue } from "../src/index.ts";
import type { QueueJob } from "../src/index.ts";
import { createScheduler } from "../src/scheduler.ts";
import { createWorker, resolveRunVersion } from "../src/handlers.ts";
import type {
  WorkerDeps,
  WorkerRepositories,
  RunPipelineJob
} from "../src/handlers.ts";

import {
  InMemoryExecutionStore,
  InMemoryPipelineRepository,
  InMemoryPipelineVersionRepository,
  InMemoryPipelineActivationRepository,
  InMemoryConfigDefinitionRepository,
  InMemoryConfigValueRepository,
  InMemoryProviderRepository,
  InMemoryProviderModelRepository,
  InMemoryVectorCollectionRepository,
  InMemoryDatasourceConnectionRepository,
  InMemoryUsageRecordRepository,
  InMemoryScheduleRepository
} from "../../../packages/db/src/index.ts";
import type {
  PipelineRow,
  ScheduleRow
} from "../../../packages/db/src/index.ts";
import { InMemoryVectorStore } from "../../../packages/vector/src/index.ts";
import {
  DatabaseEncryptedSecretProvider,
  InMemorySecretRepository,
  StaticKeyProvider
} from "../../../packages/secrets/src/index.ts";
import {
  PluginRegistry,
  type InProcessPlugin
} from "../../../packages/plugin-sdk/src/index.ts";
import { ProviderRegistry } from "../../../packages/providers/src/index.ts";
import type { ProviderAdapter } from "../../../packages/providers/src/index.ts";
import type { PipelineSpec } from "../../../packages/core/src/index.ts";
import type { PipelineDeployment } from "../../../packages/pipeline-spec/src/index.ts";

/* ------------------------------- fixtures -------------------------------- */

const fakeChat: InProcessPlugin = {
  manifest: {
    id: "fake_chat",
    name: "Fake Chat",
    version: "1.0.0",
    category: "llm",
    description: "Deterministic test chat"
  },
  async execute({ inputs }) {
    return {
      outputs: { text: `answer:${JSON.stringify(inputs)}` },
      usage: { provider: "fake", model: "fake-chat", inputTokens: 1, outputTokens: 1 }
    };
  }
};

const fakeProvider: ProviderAdapter = {
  id: "fake",
  displayName: "Fake Provider",
  async chat() {
    return { text: "", model: "fake-chat", provider: "fake" };
  },
  async models() {
    return [{ id: "fake-chat" }];
  },
  async healthCheck() {
    return { ok: true };
  }
};

function chatSpec(name: string): PipelineSpec {
  return {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name },
    spec: {
      nodes: [
        { id: "input", type: "input" },
        { id: "llm", plugin: { category: "llm", id: "fake_chat", version: "1.0.0" } },
        { id: "output", type: "output" }
      ],
      edges: [
        { from: "input", to: "llm" },
        { from: "llm", to: "output" }
      ]
    }
  };
}

function buildRepositories(): WorkerRepositories {
  return {
    pipelineVersions: new InMemoryPipelineVersionRepository(),
    configDefinitions: new InMemoryConfigDefinitionRepository(),
    configValues: new InMemoryConfigValueRepository(),
    providers: new InMemoryProviderRepository(),
    providerModels: new InMemoryProviderModelRepository(),
    vectorCollections: new InMemoryVectorCollectionRepository(),
    datasourceConnections: new InMemoryDatasourceConnectionRepository(),
    usageRecords: new InMemoryUsageRecordRepository(),
    pipelines: new InMemoryPipelineRepository(),
    activations: new InMemoryPipelineActivationRepository()
  };
}

async function buildDeps(
  overrides: Partial<WorkerDeps> = {}
): Promise<WorkerDeps & { store: InMemoryExecutionStore }> {
  const store = new InMemoryExecutionStore();
  const registry = new PluginRegistry();
  registry.register({
    mode: "in_process",
    manifest: fakeChat.manifest,
    implementation: fakeChat
  });
  const providers = new ProviderRegistry();
  providers.register(fakeProvider);
  return {
    store,
    vectorStore: new InMemoryVectorStore(),
    plugins: registry,
    providers,
    secretProvider: new DatabaseEncryptedSecretProvider(
      new InMemorySecretRepository(),
      new StaticKeyProvider("test-secret")
    ),
    repositories: buildRepositories(),
    maxRetries: 0,
    mirrorUsageToRepository: true,
    ...overrides
  } as WorkerDeps & { store: InMemoryExecutionStore };
}

function schedule(overrides: Partial<ScheduleRow>): ScheduleRow {
  return {
    id: overrides.id ?? "sched-1",
    tenantId: overrides.tenantId ?? "tenant-a",
    pipelineId: overrides.pipelineId ?? "pipe-a",
    environment: overrides.environment ?? "prod",
    activationLabel: overrides.activationLabel ?? null,
    cron: overrides.cron ?? "*/5 * * * *",
    timezone: overrides.timezone ?? "UTC",
    input: overrides.input ?? {},
    enabled: overrides.enabled ?? true,
    lastRunAt: overrides.lastRunAt ?? null,
    nextRunAt: overrides.nextRunAt ?? null,
    createdAt: overrides.createdAt ?? "2026-05-18T00:00:00.000Z"
  };
}

/* ------------------------------ scheduler -------------------------------- */

test("scheduler.tick enqueues a run_pipeline for a due schedule and advances next_run_at", async () => {
  const schedules = new InMemoryScheduleRepository();
  const queue = new InMemoryQueue();
  const now = new Date("2026-05-18T12:00:00.000Z");

  const due = await schedules.create(
    schedule({
      id: "sched-due",
      cron: "*/5 * * * *",
      activationLabel: "stable",
      input: { q: "hi" },
      nextRunAt: "2026-05-18T11:59:00.000Z"
    })
  );

  const scheduler = createScheduler({ schedules, queue, now: () => now });
  const res = await scheduler.tick();

  assert.equal(res.enqueued, 1);
  const jobs = queue.list();
  assert.equal(jobs.length, 1);
  const job = jobs[0] as QueueJob<RunPipelineJob>;
  assert.equal(job.type, "run_pipeline");
  assert.equal(job.payload.tenantId, "tenant-a");
  assert.equal(job.payload.pipelineId, "pipe-a");
  assert.equal(job.payload.environment, "prod");
  assert.equal(job.payload.activationLabel, "stable");
  assert.deepEqual(job.payload.input, { q: "hi" });
  assert.equal(job.payload.source, "schedule");
  // No version pin: the worker resolves the effective version at run time.
  assert.equal(job.payload.pipelineVersionId, undefined);

  // next_run_at advanced past `now` (next */5 boundary is 12:05); last_run_at set.
  const after = await schedules.require(due.id);
  assert.equal(after.lastRunAt, now.toISOString());
  assert.equal(after.nextRunAt, "2026-05-18T12:05:00.000Z");
  // No longer due at the same `now`.
  assert.equal((await schedules.listDue(now.toISOString())).length, 0);
});

test("scheduler.tick skips a not-yet-due schedule", async () => {
  const schedules = new InMemoryScheduleRepository();
  const queue = new InMemoryQueue();
  const now = new Date("2026-05-18T12:00:00.000Z");
  await schedules.create(
    schedule({ id: "sched-future", nextRunAt: "2026-05-18T13:00:00.000Z" })
  );

  const res = await createScheduler({ schedules, queue, now: () => now }).tick();
  assert.equal(res.enqueued, 0);
  assert.equal(queue.list().length, 0);
});

test("scheduler.tick skips a disabled schedule even when past due", async () => {
  const schedules = new InMemoryScheduleRepository();
  const queue = new InMemoryQueue();
  const now = new Date("2026-05-18T12:00:00.000Z");
  await schedules.create(
    schedule({
      id: "sched-disabled",
      enabled: false,
      nextRunAt: "2026-05-18T00:00:00.000Z"
    })
  );

  const res = await createScheduler({ schedules, queue, now: () => now }).tick();
  assert.equal(res.enqueued, 0);
  assert.equal(queue.list().length, 0);
});

test("scheduler.tick skips a due schedule with a malformed cron without throwing", async () => {
  const schedules = new InMemoryScheduleRepository();
  const queue = new InMemoryQueue();
  const now = new Date("2026-05-18T12:00:00.000Z");
  const bad = await schedules.create(
    schedule({
      id: "sched-bad",
      cron: "not a cron",
      nextRunAt: "2026-05-18T11:00:00.000Z"
    })
  );
  // A second, valid due schedule must still be processed in the same tick.
  await schedules.create(
    schedule({
      id: "sched-ok",
      cron: "*/5 * * * *",
      nextRunAt: "2026-05-18T11:00:00.000Z"
    })
  );

  const res = await createScheduler({ schedules, queue, now: () => now }).tick();

  assert.equal(res.enqueued, 1, "only the valid schedule enqueued");
  assert.equal(queue.list().length, 1);
  // The malformed schedule was untouched (not markRun'd, still due).
  const badAfter = await schedules.require(bad.id);
  assert.equal(badAfter.nextRunAt, "2026-05-18T11:00:00.000Z");
  assert.equal(badAfter.lastRunAt, null);
});

test("scheduler.prime() sets next_run_at for enabled schedules with null next_run_at", async () => {
  const schedules = new InMemoryScheduleRepository();
  const queue = new InMemoryQueue();
  const now = new Date("2026-05-18T12:00:00.000Z");

  const fresh = await schedules.create(
    schedule({ id: "sched-fresh", cron: "*/5 * * * *", nextRunAt: null })
  );
  // Already-scheduled row must NOT be re-primed.
  const existing = await schedules.create(
    schedule({
      id: "sched-existing",
      cron: "0 0 * * *",
      nextRunAt: "2026-06-01T00:00:00.000Z"
    })
  );
  // Disabled row with null next_run_at must NOT be primed.
  const disabled = await schedules.create(
    schedule({ id: "sched-off", enabled: false, nextRunAt: null })
  );

  const res = await createScheduler({ schedules, queue, now: () => now }).prime();

  assert.equal(res.primed, 1);
  assert.equal(
    (await schedules.require(fresh.id)).nextRunAt,
    "2026-05-18T12:05:00.000Z"
  );
  assert.equal(
    (await schedules.require(existing.id)).nextRunAt,
    "2026-06-01T00:00:00.000Z",
    "already-scheduled row left untouched"
  );
  assert.equal(
    (await schedules.require(disabled.id)).nextRunAt,
    null,
    "disabled row not primed"
  );
  // Priming does not enqueue anything.
  assert.equal(queue.list().length, 0);
});

test("scheduler.start primes, runs an initial tick, and returns a working stop fn", async () => {
  const schedules = new InMemoryScheduleRepository();
  const queue = new InMemoryQueue();
  const now = new Date("2026-05-18T12:00:00.000Z");
  // Due at start (next_run_at already in the past).
  await schedules.create(
    schedule({ id: "sched-start", nextRunAt: "2026-05-18T11:00:00.000Z" })
  );

  const scheduler = createScheduler({ schedules, queue, now: () => now });
  const stop = scheduler.start(60_000);
  // start() kicks prime().then(tick()) asynchronously; let microtasks flush.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  stop();

  assert.equal(queue.list().length, 1, "initial tick enqueued the due schedule");
  assert.equal(typeof stop, "function");
});

/* ----------------------- effective-version resolution -------------------- */

async function seedVersion(
  deps: WorkerDeps,
  pipelineId: string,
  versionId: string,
  spec: PipelineSpec
): Promise<void> {
  await deps.repositories.pipelineVersions.create({
    id: versionId,
    pipelineId,
    version: versionId,
    status: "published",
    spec,
    checksum: "c",
    createdAt: "2026-05-18T00:00:00.000Z",
    publishedAt: "2026-05-18T00:00:00.000Z"
  });
}

async function seedPipeline(
  deps: WorkerDeps,
  pipelineId: string,
  latestVersionId: string | null
): Promise<void> {
  const row: PipelineRow = {
    id: pipelineId,
    slug: pipelineId,
    name: pipelineId,
    labels: {},
    latestVersionId,
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z"
  };
  await deps.repositories.pipelines!.create(row);
}

test("resolveRunVersion: pinned activation -> its own version (no pipelineVersionId on job)", async () => {
  const deps = await buildDeps();
  await seedPipeline(deps, "pipe-a", "v-latest");
  await deps.repositories.activations!.create({
    id: "act-1",
    tenantId: "tenant-a",
    pipelineId: "pipe-a",
    environment: "prod",
    label: "default",
    pipelineVersionId: "v-pinned",
    trackLatest: false,
    enabled: true,
    createdAt: "2026-05-18T00:00:00.000Z"
  });

  const resolved = await resolveRunVersion(deps, {
    tenantId: "tenant-a",
    pipelineId: "pipe-a",
    environment: "prod"
  });
  assert.equal(resolved, "v-pinned");
});

test("resolveRunVersion: track_latest activation -> pipeline.latestVersionId", async () => {
  const deps = await buildDeps();
  await seedPipeline(deps, "pipe-a", "v-latest");
  await deps.repositories.activations!.create({
    id: "act-2",
    tenantId: "tenant-a",
    pipelineId: "pipe-a",
    environment: "prod",
    label: "default",
    pipelineVersionId: "v-old",
    trackLatest: true,
    enabled: true,
    createdAt: "2026-05-18T00:00:00.000Z"
  });

  const resolved = await resolveRunVersion(deps, {
    tenantId: "tenant-a",
    pipelineId: "pipe-a",
    environment: "prod",
    activationLabel: "default"
  });
  assert.equal(resolved, "v-latest");
});

test("resolveRunVersion: explicit pipelineVersionId on the job wins (back-compat)", async () => {
  const deps = await buildDeps();
  await seedPipeline(deps, "pipe-a", "v-latest");
  await deps.repositories.activations!.create({
    id: "act-3",
    tenantId: "tenant-a",
    pipelineId: "pipe-a",
    environment: "prod",
    label: "default",
    pipelineVersionId: "v-pinned",
    trackLatest: false,
    enabled: true,
    createdAt: "2026-05-18T00:00:00.000Z"
  });

  const resolved = await resolveRunVersion(deps, {
    tenantId: "tenant-a",
    pipelineId: "pipe-a",
    environment: "prod",
    pipelineVersionId: "v-explicit"
  });
  assert.equal(resolved, "v-explicit", "explicit pin short-circuits activations");
});

test("resolveRunVersion: no activations -> undefined (defer to deployment fallback)", async () => {
  const deps = await buildDeps();
  await seedPipeline(deps, "pipe-a", "v-latest");

  const resolved = await resolveRunVersion(deps, {
    tenantId: "tenant-a",
    pipelineId: "pipe-a",
    environment: "prod"
  });
  assert.equal(resolved, undefined);
});

test("run_pipeline resolves via track_latest activation when no pipelineVersionId on the job", async () => {
  const deps = await buildDeps();
  await seedPipeline(deps, "pipe-a", "v2");
  await seedVersion(deps, "pipe-a", "v1", chatSpec("v1"));
  await seedVersion(deps, "pipe-a", "v2", chatSpec("v2"));
  await deps.repositories.activations!.create({
    id: "act-run",
    tenantId: "tenant-a",
    pipelineId: "pipe-a",
    environment: "prod",
    label: "default",
    pipelineVersionId: null,
    trackLatest: true,
    enabled: true,
    createdAt: "2026-05-18T00:00:00.000Z"
  });
  const worker = createWorker(deps);

  const result = (await worker.handle({
    id: "job-act",
    type: "run_pipeline",
    payload: {
      tenantId: "tenant-a",
      pipelineId: "pipe-a",
      environment: "prod",
      input: {},
      source: "schedule"
    }
  })) as { pipelineVersionId: string; status: string };

  assert.equal(result.status, "succeeded");
  assert.equal(result.pipelineVersionId, "v2", "tracked the pipeline latest pointer");
});

test("run_pipeline resolves via pinned activation when no pipelineVersionId on the job", async () => {
  const deps = await buildDeps();
  await seedPipeline(deps, "pipe-a", "v2");
  await seedVersion(deps, "pipe-a", "v1", chatSpec("v1"));
  await seedVersion(deps, "pipe-a", "v2", chatSpec("v2"));
  await deps.repositories.activations!.create({
    id: "act-pin",
    tenantId: "tenant-a",
    pipelineId: "pipe-a",
    environment: "prod",
    label: "stable",
    pipelineVersionId: "v1",
    trackLatest: false,
    enabled: true,
    createdAt: "2026-05-18T00:00:00.000Z"
  });
  const worker = createWorker(deps);

  const result = (await worker.handle({
    id: "job-pin",
    type: "run_pipeline",
    payload: {
      tenantId: "tenant-a",
      pipelineId: "pipe-a",
      environment: "prod",
      activationLabel: "stable",
      input: {},
      source: "schedule"
    }
  })) as { pipelineVersionId: string };

  assert.equal(result.pipelineVersionId, "v1", "used the pinned activation version");
});

test("run_pipeline still honors an explicit pipelineVersionId over activations (back-compat)", async () => {
  const deps = await buildDeps();
  await seedPipeline(deps, "pipe-a", "v2");
  await seedVersion(deps, "pipe-a", "v1", chatSpec("v1"));
  await seedVersion(deps, "pipe-a", "v2", chatSpec("v2"));
  await deps.repositories.activations!.create({
    id: "act-bc",
    tenantId: "tenant-a",
    pipelineId: "pipe-a",
    environment: "prod",
    label: "default",
    pipelineVersionId: "v2",
    trackLatest: false,
    enabled: true,
    createdAt: "2026-05-18T00:00:00.000Z"
  });
  const worker = createWorker(deps);

  const result = (await worker.handle({
    id: "job-bc",
    type: "run_pipeline",
    payload: {
      tenantId: "tenant-a",
      pipelineId: "pipe-a",
      environment: "prod",
      pipelineVersionId: "v1",
      input: {}
    }
  })) as { pipelineVersionId: string };

  assert.equal(result.pipelineVersionId, "v1", "explicit pin overrides activation");
});

test("run_pipeline falls back to deployment selection when neither pin nor activation applies", async () => {
  const deployments: PipelineDeployment[] = [
    { pipelineId: "pipe-a", environment: "prod", version: "v1" }
  ];
  const deps = await buildDeps({ deployments });
  await seedPipeline(deps, "pipe-a", "v2");
  await seedVersion(deps, "pipe-a", "v1", chatSpec("v1"));
  await seedVersion(deps, "pipe-a", "v2", chatSpec("v2"));
  // No activations for this (tenant,pipeline,env).
  const worker = createWorker(deps);

  const result = (await worker.handle({
    id: "job-fallback",
    type: "run_pipeline",
    payload: {
      tenantId: "tenant-a",
      pipelineId: "pipe-a",
      environment: "prod",
      input: {}
    }
  })) as { pipelineVersionId: string };

  assert.equal(
    result.pipelineVersionId,
    "v1",
    "deployment selection picked the deployed version"
  );
});
