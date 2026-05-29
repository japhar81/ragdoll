import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryVectorStore,
  createVectorStore,
  getInMemoryVectorStore,
  resetInMemoryVectorStore,
  score
} from "../src/index.ts";
import { vectorUpsertPlugin, qdrantRetrieverPlugin } from "../../../plugins/builtin-rag/src/index.ts";
import type { RuntimeContext } from "../../core/src/index.ts";

function makeContext(tenantId: string): RuntimeContext {
  return {
    requestId: "req-1",
    executionId: "exec-1",
    tenantId,
    pipelineId: "pipe-1",
    pipelineVersionId: "v1",
    environment: "test",
    resolvedConfig: {
      pipelineId: "pipe-1",
      pipelineVersionId: "v1",
      tenantId,
      environment: "test",
      values: {},
      violations: []
    }
  };
}

test("score ranks cosine similarity correctly", () => {
  assert.equal(score("cosine", [1, 0], [1, 0]), 1);
  assert.ok(score("cosine", [1, 0], [1, 1]) > score("cosine", [1, 0], [0, 1]));
  // dot rewards magnitude
  assert.equal(score("dot", [1, 2], [3, 4]), 11);
  // euclidean: closer points score higher (less negative)
  assert.ok(score("euclidean", [0, 0], [1, 0]) > score("euclidean", [0, 0], [3, 4]));
});

test("InMemoryVectorStore similarity ranking returns nearest first", async () => {
  const store = new InMemoryVectorStore();
  await store.ensureCollection("docs", { dimensions: 2, distance: "cosine" });
  await store.upsert("docs", [
    { id: "a", vector: [1, 0], payload: { text: "a" }, tenantId: "t1" },
    { id: "b", vector: [0.9, 0.1], payload: { text: "b" }, tenantId: "t1" },
    { id: "c", vector: [0, 1], payload: { text: "c" }, tenantId: "t1" }
  ]);
  const results = await store.query("docs", { vector: [1, 0], topK: 2, tenantId: "t1" });
  assert.equal(results.length, 2);
  assert.equal(results[0].id, "a");
  assert.equal(results[1].id, "b");
  assert.ok(results[0].score >= results[1].score);
});

test("InMemoryVectorStore isolates query results by tenant", async () => {
  const store = new InMemoryVectorStore();
  await store.ensureCollection("docs", { dimensions: 2, distance: "cosine" });
  await store.upsert("docs", [
    { id: "a", vector: [1, 0], payload: { text: "tenant1" }, tenantId: "t1" },
    { id: "b", vector: [1, 0], payload: { text: "tenant2" }, tenantId: "t2" }
  ]);
  const t1 = await store.query("docs", { vector: [1, 0], topK: 10, tenantId: "t1" });
  assert.equal(t1.length, 1);
  assert.equal(t1[0].id, "a");
  const t2 = await store.query("docs", { vector: [1, 0], topK: 10, tenantId: "t2" });
  assert.equal(t2.length, 1);
  assert.equal(t2[0].id, "b");
});

test("deleteByTenant only removes the targeted tenant's points", async () => {
  const store = new InMemoryVectorStore();
  await store.ensureCollection("docs", { dimensions: 2, distance: "dot" });
  await store.upsert("docs", [
    { id: "a", vector: [1, 0], tenantId: "t1" },
    { id: "b", vector: [0, 1], tenantId: "t1" },
    { id: "c", vector: [1, 1], tenantId: "t2" }
  ]);
  await store.deleteByTenant("docs", "t1");
  assert.equal((await store.query("docs", { vector: [1, 0], topK: 10, tenantId: "t1" })).length, 0);
  const t2 = await store.query("docs", { vector: [1, 1], topK: 10, tenantId: "t2" });
  assert.equal(t2.length, 1);
  assert.equal(t2[0].id, "c");
});

test("createVectorStore returns process-wide in-memory singleton offline", () => {
  resetInMemoryVectorStore();
  const a = createVectorStore();
  const b = createVectorStore();
  assert.equal(a, b);
  assert.equal(a, getInMemoryVectorStore());
});

test("vectorUpsert -> qdrantRetriever end-to-end via in-memory singleton", async () => {
  resetInMemoryVectorStore();
  const tenantId = "tenant-x";
  // PR1 of the requires roll-out: every storage plugin requires a
  // resolved connection. The `memory` sentinel host on a vector
  // backend tells createVectorStore to route to the in-memory
  // singleton, so this test exercises the same hard-fail-on-missing-
  // connection path the production runtime does, without a Qdrant.
  const fakeVecDataset = {
    id: "ds-test",
    slug: "test",
    scope: "global" as const,
    modalities: ["vector"],
    embeddingProfile: {},
    chunkSchema: {},
    version: { id: "v1", versionLabel: "v1", status: "ready" as const },
    backendCollections: {},
    backends: {
      vector: {
        provider: "qdrant",
        connectionName: "test-qdrant",
        connection: {
          name: "test-qdrant",
          type: "qdrant",
          host: "memory",
          port: 6333,
          secretRefId: null,
          config: { host: "memory", port: 6333 },
          cascadeReason: "tenant_fallback" as const
        }
      }
    }
  };

  const upsert = await vectorUpsertPlugin.execute({
    context: makeContext(tenantId),
    node: { id: "sink", plugin: { category: "sink", id: "vector_upsert", version: "1.0.0" } },
    inputs: {
      chunks: [
        { text: "the cat sat on the mat", index: 0 },
        { text: "dogs love to run in the park", index: 1 },
        { text: "quantum physics is fascinating", index: 2 }
      ],
      vectors: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1]
      ]
    },
    config: { collection: "e2e", distance: "cosine", dimensions: 3 },
    secrets: {},
    dataset: fakeVecDataset
  });
  assert.deepEqual(upsert.outputs, { upserted: 3 });

  const retrieve = await qdrantRetrieverPlugin.execute({
    context: makeContext(tenantId),
    node: { id: "retriever", plugin: { category: "retriever", id: "qdrant_retriever", version: "1.0.0" } },
    inputs: { queryVector: [0.95, 0.05, 0] },
    config: { collection: "e2e", topK: 2 },
    secrets: {},
    dataset: fakeVecDataset
  });
  const documents = retrieve.outputs.documents as Array<{ id: string; text: string; score: number }>;
  assert.equal(documents.length, 2);
  assert.equal(documents[0].text, "the cat sat on the mat");

  // Tenant isolation: a different tenant sees nothing in the shared singleton.
  const otherTenant = await qdrantRetrieverPlugin.execute({
    context: makeContext("tenant-y"),
    node: { id: "retriever", plugin: { category: "retriever", id: "qdrant_retriever", version: "1.0.0" } },
    inputs: { queryVector: [1, 0, 0] },
    config: { collection: "e2e", topK: 5 },
    secrets: {},
    dataset: fakeVecDataset
  });
  assert.equal((otherTenant.outputs.documents as unknown[]).length, 0);
});
