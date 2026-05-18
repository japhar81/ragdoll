import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryQueue } from "../src/index.ts";
import type { QueueJob } from "../src/index.ts";
import { createWorker } from "../src/handlers.ts";
import type { WorkerDeps, WorkerRepositories } from "../src/handlers.ts";

import {
  InMemoryExecutionStore,
  InMemoryPipelineVersionRepository,
  InMemoryConfigDefinitionRepository,
  InMemoryConfigValueRepository,
  InMemoryProviderRepository,
  InMemoryProviderModelRepository,
  InMemoryVectorCollectionRepository,
  InMemoryDatasourceConnectionRepository,
  InMemoryUsageRecordRepository
} from "../../../packages/db/src/index.ts";
import {
  InMemoryVectorStore
} from "../../../packages/vector/src/index.ts";
import {
  DatabaseEncryptedSecretProvider,
  InMemorySecretRepository,
  StaticKeyProvider
} from "../../../packages/secrets/src/index.ts";
import {
  PluginRegistry,
  type InProcessPlugin
} from "../../../packages/plugin-sdk/src/index.ts";
import {
  getInMemoryVectorStore,
  resetInMemoryVectorStore
} from "../../../packages/vector/src/index.ts";
import { ProviderRegistry } from "../../../packages/providers/src/index.ts";
import type { ProviderAdapter } from "../../../packages/providers/src/index.ts";
import type { PipelineSpec } from "../../../packages/core/src/index.ts";

/* ------------------------------- fixtures -------------------------------- */

/**
 * The DagExecutor passes node inputs namespaced by upstream node id (e.g.
 * `{ chunk: { chunks: [...] } }`). This flattens one level so fake plugins can
 * read fields regardless of which upstream produced them.
 */
function flatInputs(inputs: Record<string, unknown>): Record<string, unknown> {
  const flat: Record<string, unknown> = { ...inputs };
  for (const value of Object.values(inputs)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(flat, value as Record<string, unknown>);
    }
  }
  return flat;
}

/** Deterministic fake embedder: maps each text to a fixed-dimension vector. */
const fakeEmbedder: InProcessPlugin = {
  manifest: {
    id: "fake_embedder",
    name: "Fake Embedder",
    version: "1.0.0",
    category: "embedder",
    description: "Deterministic test embedder"
  },
  async execute({ inputs: rawInputs }) {
    const inputs = flatInputs(rawInputs);
    const chunks =
      (inputs.chunks as Array<{ text?: string }> | undefined) ??
      (inputs.texts as string[] | undefined)?.map((t) => ({ text: t })) ??
      [];
    const vectors = chunks.map((chunk) => {
      const text = String(chunk?.text ?? "");
      const a = text.length % 7;
      const b = (text.charCodeAt(0) || 0) % 11;
      return [a, b, 1];
    });
    return {
      outputs: { vectors, dimensions: 3, chunks },
      usage: { provider: "fake", model: "fake-embed", embeddingTokens: chunks.length }
    };
  }
};

/** Echo LLM plugin emitting usage so run_pipeline records a usage row. */
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
      usage: {
        provider: "fake",
        model: "fake-chat",
        inputTokens: 3,
        outputTokens: 5
      }
    };
  },
  async healthCheck() {
    return { ok: true, message: "fake chat ready" };
  }
};

/** Chunker mirroring builtin basic_text_chunker for offline DAG tests. */
const fakeChunker: InProcessPlugin = {
  manifest: {
    id: "fake_chunker",
    name: "Fake Chunker",
    version: "1.0.0",
    category: "chunker",
    description: "Splits text into fixed-size chunks"
  },
  async execute({ inputs: rawInputs, config }) {
    const inputs = flatInputs(rawInputs);
    const text = String(inputs.text ?? "");
    const size = Number(config.chunkSize ?? 12);
    const chunks: Array<{ text: string; index: number }> = [];
    for (let start = 0; start < Math.max(text.length, 1); start += size) {
      chunks.push({ text: text.slice(start, start + size), index: chunks.length });
      if (text.length === 0) break;
    }
    return { outputs: { chunks } };
  }
};

/** Sink writing embedded chunks into the process-wide in-memory store. */
const fakeUpsertSink: InProcessPlugin = {
  manifest: {
    id: "fake_upsert",
    name: "Fake Upsert",
    version: "1.0.0",
    category: "sink",
    description: "Upserts vectors into the shared in-memory store"
  },
  async execute({ inputs: rawInputs, config, context }) {
    const inputs = flatInputs(rawInputs);
    const store = getInMemoryVectorStore();
    const collection = String(config.collection ?? "default");
    const vectors = (inputs.vectors as number[][] | undefined) ?? [];
    const chunks =
      (inputs.chunks as Array<{ text?: string; index?: number }> | undefined) ?? [];
    if (vectors.length === 0) return { outputs: { upserted: 0 } };
    await store.ensureCollection(collection, {
      dimensions: vectors[0].length,
      distance: "cosine"
    });
    const points = vectors.map((vector, index) => ({
      id: `${context.executionId}_${index}`,
      vector,
      tenantId: context.tenantId,
      payload: { text: chunks[index]?.text ?? "", chunkIndex: index }
    }));
    await store.upsert(collection, points);
    return { outputs: { upserted: points.length } };
  }
};

/** A plugin whose execute blocks long enough to be cancelled. */
const slowPlugin: InProcessPlugin = {
  manifest: {
    id: "slow_llm",
    name: "Slow LLM",
    version: "1.0.0",
    category: "llm",
    description: "Sleeps so a deadline/cancel can interrupt it"
  },
  async execute() {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { outputs: { text: "done" } };
  },
  async healthCheck() {
    throw new Error("slow plugin unhealthy");
  }
};

function buildRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  for (const plugin of [
    fakeEmbedder,
    fakeChat,
    slowPlugin,
    fakeChunker,
    fakeUpsertSink
  ]) {
    registry.register({
      mode: "in_process",
      manifest: plugin.manifest,
      implementation: plugin
    });
  }
  return registry;
}

const fakeProvider: ProviderAdapter = {
  id: "fake",
  displayName: "Fake Provider",
  async chat() {
    return { text: "", model: "fake-chat", provider: "fake" };
  },
  async models() {
    return [
      { id: "fake-chat", contextWindow: 8192, supportsStreaming: true },
      { id: "fake-embed", supportsEmbeddings: true }
    ];
  },
  async healthCheck() {
    return { ok: true };
  }
};

function buildProviders(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(fakeProvider);
  return registry;
}

async function buildSecretProvider(): Promise<DatabaseEncryptedSecretProvider> {
  return new DatabaseEncryptedSecretProvider(
    new InMemorySecretRepository(),
    new StaticKeyProvider("test-secret")
  );
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
    usageRecords: new InMemoryUsageRecordRepository()
  };
}

async function buildDeps(
  overrides: Partial<WorkerDeps> = {}
): Promise<WorkerDeps & { store: InMemoryExecutionStore; vectorStore: InMemoryVectorStore }> {
  const store = new InMemoryExecutionStore();
  const vectorStore = new InMemoryVectorStore();
  return {
    store,
    vectorStore,
    plugins: buildRegistry(),
    providers: buildProviders(),
    secretProvider: await buildSecretProvider(),
    repositories: buildRepositories(),
    maxRetries: 0,
    // Mirrors the default in-memory production wiring so usage surfaces via
    // the control-plane UsageRecordRepository (what /api/usage reads).
    mirrorUsageToRepository: true,
    ...overrides
  } as WorkerDeps & { store: InMemoryExecutionStore; vectorStore: InMemoryVectorStore };
}

const chatSpec: PipelineSpec = {
  apiVersion: "rag-platform/v1",
  kind: "Pipeline",
  metadata: { name: "chat-rag" },
  spec: {
    nodes: [
      { id: "input", type: "input" },
      {
        id: "llm",
        plugin: { category: "llm", id: "fake_chat", version: "1.0.0" }
      },
      { id: "output", type: "output" }
    ],
    edges: [
      { from: "input", to: "llm" },
      { from: "llm", to: "output" }
    ]
  }
};

const slowSpec: PipelineSpec = {
  apiVersion: "rag-platform/v1",
  kind: "Pipeline",
  metadata: { name: "slow-rag" },
  spec: {
    nodes: [
      { id: "input", type: "input" },
      {
        id: "llm",
        plugin: { category: "llm", id: "slow_llm", version: "1.0.0" }
      },
      { id: "output", type: "output" }
    ],
    edges: [
      { from: "input", to: "llm" },
      { from: "llm", to: "output" }
    ]
  }
};

async function seedVersion(
  deps: WorkerDeps,
  pipelineId: string,
  spec: PipelineSpec,
  versionId = "ver-1"
): Promise<void> {
  await deps.repositories.pipelineVersions.create({
    id: versionId,
    pipelineId,
    version: "1.0.0",
    status: "published",
    spec,
    checksum: "abc",
    createdAt: new Date().toISOString(),
    publishedAt: new Date().toISOString()
  });
}

/* -------------------------------- tests ---------------------------------- */

test("enqueue + drain a run_pipeline job -> execution recorded succeeded + usage", async () => {
  const deps = await buildDeps();
  await seedVersion(deps, "pipe-a", chatSpec);
  const worker = createWorker(deps);
  const queue = new InMemoryQueue();

  const job: QueueJob = {
    id: "job-run-1",
    type: "run_pipeline",
    payload: {
      tenantId: "tenant-a",
      pipelineId: "pipe-a",
      environment: "prod",
      input: { question: "hello" }
    }
  };
  await queue.enqueue(job);

  const results = await queue.drain((j, signal) => worker.handle(j, signal));

  assert.equal(results.get("job-run-1")?.status, "completed");
  assert.equal(await queue.status("job-run-1"), "completed");

  const exec = deps.store.executions.find((e) => e.executionId);
  assert.ok(exec, "execution recorded");
  assert.equal(exec?.status, "succeeded");
  assert.equal(exec?.tenantId, "tenant-a");
  assert.equal(exec?.pipelineId, "pipe-a");

  const usage = deps.store.usage;
  assert.equal(usage.length, 1);
  assert.equal(usage[0].provider, "fake");
  assert.equal(usage[0].model, "fake-chat");
  assert.equal(usage[0].inputTokens, 3);
  assert.equal(usage[0].outputTokens, 5);
  assert.equal(usage[0].success, true);

  // Usage must ALSO surface via the control-plane UsageRecordRepository
  // (what GET /api/usage reads) — not only the runtime ExecutionStore.
  const repoUsage = await deps.repositories.usageRecords.list({
    tenantId: "tenant-a"
  });
  assert.equal(repoUsage.length, 1, "usage mirrored into UsageRecordRepository");
  assert.equal(repoUsage[0].provider, "fake");
  assert.equal(repoUsage[0].model, "fake-chat");
  assert.equal(repoUsage[0].inputTokens, 3);
  assert.equal(repoUsage[0].outputTokens, 5);
  assert.equal(repoUsage[0].executionId, exec?.executionId);
  assert.equal(repoUsage[0].success, true);
  assert.ok(repoUsage[0].id, "repository assigns an id");
  assert.ok(repoUsage[0].createdAt, "repository assigns createdAt");

  // Querying by executionId resolves the same single row (no double-count).
  const byExec = await deps.repositories.usageRecords.list({
    executionId: exec?.executionId
  });
  assert.equal(byExec.length, 1, "exactly one usage row per execution");
});

test("run_pipeline does NOT mirror usage when mirrorUsageToRepository is off (Postgres-mode parity)", async () => {
  // Simulates the Postgres wiring: PostgresExecutionStore would write
  // usage_records itself, so the worker must not also mirror.
  const deps = await buildDeps({ mirrorUsageToRepository: false });
  await seedVersion(deps, "pipe-nomirror", chatSpec);
  const worker = createWorker(deps);

  await worker.handle({
    id: "job-nomirror",
    type: "run_pipeline",
    payload: {
      tenantId: "tenant-z",
      pipelineId: "pipe-nomirror",
      environment: "prod",
      input: {}
    }
  });

  // Runtime store still records usage (single source in Postgres mode).
  assert.equal(deps.store.usage.length, 1);
  // Repository is NOT written by the worker in this mode (the Postgres
  // ExecutionStore + Postgres repo share one table → single write).
  const repoUsage = await deps.repositories.usageRecords.list({
    tenantId: "tenant-z"
  });
  assert.equal(repoUsage.length, 0, "no mirror when flag disabled");
});

test("ingest_datasource with precomputed vectors populates vector store + vector_collections row", async () => {
  const deps = await buildDeps();
  const worker = createWorker(deps);
  const queue = new InMemoryQueue();

  const job: QueueJob = {
    id: "job-ingest-1",
    type: "ingest_datasource",
    payload: {
      tenantId: "tenant-a",
      pipelineId: "pipe-ingest",
      environment: "prod",
      collection: "rag_test_collection",
      documents: [
        { text: "alpha beta gamma", metadata: { source: "doc1" } },
        { text: "delta epsilon zeta", metadata: { source: "doc1" } }
      ],
      vectors: [
        [1, 0, 0],
        [0, 1, 0]
      ],
      embeddingProfile: {
        provider: "fake",
        model: "fake-embed",
        dimensions: 3,
        distanceMetric: "cosine"
      },
      chunkConfig: { chunkSize: 1000, overlap: 0 }
    }
  };
  await queue.enqueue(job);
  const results = await queue.drain((j, signal) => worker.handle(j, signal));

  const res = results.get("job-ingest-1");
  assert.equal(res?.status, "completed");
  const payload = res?.result as { upserted: number; collection: string; vectorCollectionId: string };
  assert.equal(payload.upserted, 2);
  assert.equal(payload.collection, "rag_test_collection");

  // The vectors are queryable for this tenant.
  const hits = await deps.vectorStore.query("rag_test_collection", {
    vector: [1, 0, 0],
    topK: 5,
    tenantId: "tenant-a"
  });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].payload?.text, "alpha beta gamma");

  // vector_collections row recorded.
  const collections = await deps.repositories.vectorCollections.list();
  assert.equal(collections.length, 1);
  assert.equal(collections[0].collectionName, "rag_test_collection");
  assert.equal(collections[0].tenantId, "tenant-a");

  // Execution + usage parity.
  const exec = deps.store.executions.at(-1);
  assert.equal(exec?.status, "succeeded");
  assert.equal(deps.store.usage.length, 1);
});

const ingestionSpec: PipelineSpec = {
  apiVersion: "rag-platform/v1",
  kind: "Pipeline",
  metadata: { name: "fake-ingestion" },
  spec: {
    nodes: [
      { id: "input", type: "input" },
      {
        id: "chunk",
        plugin: { category: "chunker", id: "fake_chunker", version: "1.0.0" },
        config: { chunkSize: 12 }
      },
      {
        id: "embed",
        plugin: { category: "embedder", id: "fake_embedder", version: "1.0.0" }
      },
      {
        id: "upsert",
        plugin: { category: "sink", id: "fake_upsert", version: "1.0.0" },
        config: { collection: "dag_collection" }
      },
      { id: "output", type: "output" }
    ],
    edges: [
      { from: "input", to: "chunk" },
      { from: "chunk", to: "embed" },
      { from: "embed", to: "upsert" },
      { from: "upsert", to: "output" }
    ]
  }
};

test("ingest_datasource through the DAG (fake embedder) embeds chunks into the vector store", async () => {
  resetInMemoryVectorStore();
  const deps = await buildDeps();
  await seedVersion(deps, "pipe-dag", ingestionSpec, "ver-ingest");
  const worker = createWorker(deps);

  const result = (await worker.handle({
    id: "job-ingest-dag",
    type: "ingest_datasource",
    payload: {
      tenantId: "tenant-b",
      pipelineId: "pipe-dag",
      environment: "prod",
      collection: "dag_collection",
      text: "the quick brown fox jumps over the lazy dog",
      embeddingProfile: {
        provider: "fake",
        model: "fake-embed",
        dimensions: 3,
        distanceMetric: "cosine"
      },
      chunkConfig: { chunkSize: 12, overlap: 0 }
    }
  })) as { upserted: number; chunks: number };

  assert.ok(result.upserted > 0, "DAG ingestion upserted points");
  // The fake sink writes to the process-wide in-memory singleton.
  const hits = await getInMemoryVectorStore().query("dag_collection", {
    vector: [1, 1, 1],
    topK: 10,
    tenantId: "tenant-b"
  });
  assert.equal(hits.length, result.upserted);
  resetInMemoryVectorStore();
});

test("delete_tenant_vector_data removes only the targeted tenant's vectors", async () => {
  const deps = await buildDeps();
  const worker = createWorker(deps);

  await deps.vectorStore.ensureCollection("shared", { dimensions: 3, distance: "cosine" });
  await deps.vectorStore.upsert("shared", [
    { id: "a1", vector: [1, 0, 0], tenantId: "tenant-a" },
    { id: "a2", vector: [0, 1, 0], tenantId: "tenant-a" },
    { id: "b1", vector: [0, 0, 1], tenantId: "tenant-b" }
  ]);
  await deps.repositories.vectorCollections.create({
    id: "vc-1",
    tenantId: "tenant-a",
    pipelineId: "p",
    environment: "prod",
    collectionName: "shared",
    isolationMode: "shared_collection_tenant_filter",
    embeddingProfile: {},
    createdAt: new Date().toISOString()
  });

  const res = (await worker.handle({
    id: "job-del-1",
    type: "delete_tenant_vector_data",
    payload: { tenantId: "tenant-a" }
  })) as { collections: string[] };

  assert.deepEqual(res.collections, ["shared"]);
  const aHits = await deps.vectorStore.query("shared", {
    vector: [1, 0, 0],
    topK: 10,
    tenantId: "tenant-a"
  });
  assert.equal(aHits.length, 0, "tenant-a vectors purged");
  const bHits = await deps.vectorStore.query("shared", {
    vector: [0, 0, 1],
    topK: 10,
    tenantId: "tenant-b"
  });
  assert.equal(bHits.length, 1, "tenant-b vectors intact");
});

test("plugin_health_check returns per-plugin status", async () => {
  const deps = await buildDeps();
  const worker = createWorker(deps);

  const res = (await worker.handle({
    id: "job-health",
    type: "plugin_health_check",
    payload: {}
  })) as { plugins: Array<{ key: string; ok: boolean; checked: boolean; message?: string }> };

  assert.equal(res.plugins.length, 5);
  const chat = res.plugins.find((p) => p.key === "llm:fake_chat:1.0.0");
  assert.ok(chat);
  assert.equal(chat?.ok, true);
  assert.equal(chat?.checked, true);
  assert.equal(chat?.message, "fake chat ready");

  const slow = res.plugins.find((p) => p.key === "llm:slow_llm:1.0.0");
  assert.ok(slow);
  assert.equal(slow?.ok, false);
  assert.equal(slow?.checked, true);

  const embed = res.plugins.find((p) => p.key === "embedder:fake_embedder:1.0.0");
  assert.ok(embed);
  // fakeEmbedder has no healthCheck -> reported as not checked, ok=true.
  assert.equal(embed?.checked, false);
  assert.equal(embed?.ok, true);
});

test("rotate_provider_model_metadata upserts ProviderModel rows", async () => {
  const deps = await buildDeps();
  const worker = createWorker(deps);
  await deps.repositories.providers.create({
    id: "prov-uuid-1",
    providerId: "fake",
    displayName: "Fake",
    config: {},
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const res = (await worker.handle({
    id: "job-rotate",
    type: "rotate_provider_model_metadata",
    payload: {}
  })) as { providers: Array<{ providerId: string; models: number }> };

  assert.equal(res.providers.length, 1);
  assert.equal(res.providers[0].models, 2);
  const models = await deps.repositories.providerModels.listByProvider("prov-uuid-1");
  assert.equal(models.length, 2);
  assert.ok(models.some((m) => m.modelId === "fake-embed" && m.supportsEmbeddings));

  // Idempotent: a second rotation updates, not duplicates.
  await worker.handle({ id: "job-rotate-2", type: "rotate_provider_model_metadata", payload: {} });
  const modelsAfter = await deps.repositories.providerModels.listByProvider("prov-uuid-1");
  assert.equal(modelsAfter.length, 2);
});

test("a deadline path yields cancelled", async () => {
  const deps = await buildDeps();
  await seedVersion(deps, "pipe-slow", slowSpec);
  const worker = createWorker(deps);
  const queue = new InMemoryQueue();

  await queue.enqueue({
    id: "job-deadline",
    type: "run_pipeline",
    payload: {
      tenantId: "tenant-a",
      pipelineId: "pipe-slow",
      environment: "prod",
      input: {},
      deadlineMs: Date.now() - 1000
    }
  });
  const results = await queue.drain((j, signal) => worker.handle(j, signal));

  assert.equal(results.get("job-deadline")?.status, "cancelled");
  assert.equal(await queue.status("job-deadline"), "cancelled");
  const exec = deps.store.executions.at(-1);
  assert.equal(exec?.status, "cancelled");
});

test("a cancel/abort signal mid-run yields cancelled", async () => {
  const deps = await buildDeps();
  await seedVersion(deps, "pipe-slow2", slowSpec);
  const worker = createWorker(deps);
  const queue = new InMemoryQueue();

  await queue.enqueue({
    id: "job-cancel",
    type: "run_pipeline",
    payload: {
      tenantId: "tenant-a",
      pipelineId: "pipe-slow2",
      environment: "prod",
      input: {}
    }
  });

  // Cancel shortly after the handler begins running.
  const drainPromise = queue.drain((j, signal) => worker.handle(j, signal));
  setTimeout(() => {
    void queue.cancel("job-cancel");
  }, 25);
  const results = await drainPromise;

  assert.equal(results.get("job-cancel")?.status, "cancelled");
  assert.equal(await queue.status("job-cancel"), "cancelled");
});

test("evaluate_pipeline and batch_run build on run_pipeline", async () => {
  const deps = await buildDeps();
  await seedVersion(deps, "pipe-eval", chatSpec);
  const worker = createWorker(deps);

  const evalRes = (await worker.handle({
    id: "job-eval",
    type: "evaluate_pipeline",
    payload: {
      tenantId: "tenant-a",
      pipelineId: "pipe-eval",
      environment: "prod",
      dataset: [{ input: { q: 1 } }, { input: { q: 2 } }]
    }
  })) as { total: number; cases: unknown[]; pipelineVersionId: string };
  assert.equal(evalRes.total, 2);
  assert.equal(evalRes.cases.length, 2);
  assert.equal(evalRes.pipelineVersionId, "ver-1");

  const batchRes = (await worker.handle({
    id: "job-batch",
    type: "batch_run",
    payload: {
      tenantId: "tenant-a",
      pipelineId: "pipe-eval",
      environment: "prod",
      inputs: [{ q: "x" }, { q: "y" }, { q: "z" }]
    }
  })) as { total: number; results: Array<{ executionId: string }> };
  assert.equal(batchRes.total, 3);
  assert.equal(batchRes.results.length, 3);
  assert.ok(batchRes.results.every((r) => r.executionId));
});

test("reindex_tenant reingests datasource connections", async () => {
  const deps = await buildDeps();
  const worker = createWorker(deps);
  await deps.repositories.datasourceConnections.create({
    id: "ds-1",
    tenantId: "tenant-a",
    name: "docs",
    datasourceType: "manual",
    configRedacted: {
      pipelineId: "pipe-r",
      collection: "reindex_collection",
      documents: [{ text: "hello world" }],
      vectors: [[1, 2, 3]],
      embeddingProfile: { provider: "fake", model: "fake-embed", dimensions: 3 }
    },
    allowedHosts: [],
    denyPrivateNetworks: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const res = (await worker.handle({
    id: "job-reindex",
    type: "reindex_tenant",
    payload: { tenantId: "tenant-a", environment: "prod" }
  })) as { reindexed: Array<{ datasourceConnectionId: string; upserted: number }> };

  assert.equal(res.reindexed.length, 1);
  assert.equal(res.reindexed[0].datasourceConnectionId, "ds-1");
  assert.equal(res.reindexed[0].upserted, 1);
  const hits = await deps.vectorStore.query("reindex_collection", {
    vector: [1, 2, 3],
    topK: 5,
    tenantId: "tenant-a"
  });
  assert.equal(hits.length, 1);
});

test("InMemoryQueue retry + deadLetter transitions", async () => {
  const queue = new InMemoryQueue();
  await queue.enqueue({ id: "j", type: "plugin_health_check", payload: {} });
  await queue.deadLetter("j", "boom");
  assert.equal(await queue.status("j"), "dead_letter");
  assert.equal(queue.reason("j"), "boom");
  await queue.retry("j");
  assert.equal(await queue.status("j"), "queued");
  assert.equal(queue.reason("j"), undefined);
});
