import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryVectorStore,
  QdrantVectorStore,
  createVectorStore,
  getInMemoryVectorStore,
  isCollectionMissingError,
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
    embeddingProfile: {},
    chunkSchema: {},
    version: { id: "v1", versionLabel: "v1", status: "ready" as const },
    bindings: {
      vectors: {
        connectionSlug: "test-qdrant",
        connectionKind: "qdrant",
        connectionHost: "memory",
        connectionPort: 6333,
        cascadeReason: "tenant" as const
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

// ---------------------------------------------------------------------------
// "Delete X from a collection that doesn't exist" must be a no-op, not a
// 404 — first-run ingest pipelines hit qdrant_delete BEFORE any upsert
// has created the collection, and a raised error there fails the whole
// pipeline for what is actually a clean state.
// ---------------------------------------------------------------------------

test("isCollectionMissingError detects every Qdrant client error shape we see in practice", () => {
  // HTTP 404 alone — minimum we should always recognise.
  assert.ok(isCollectionMissingError({ status: 404, message: "Not Found" }));
  // Status + structured body with the canonical wording.
  assert.ok(
    isCollectionMissingError({
      status: 404,
      message: "Not Found",
      data: { status: { error: "Not found: Collection `codebase` doesn't exist!" } }
    })
  );
  // No status, only the structured body — newer client versions.
  assert.ok(
    isCollectionMissingError({
      data: { status: { error: "Collection `kb_v1` does not exist!" } }
    })
  );
  // Message-only signal — older proxies that swallow the body.
  assert.ok(isCollectionMissingError(new Error("Collection 'docs' doesn't exist!")));
  // Non-collection errors must NOT trigger the no-op path.
  assert.equal(isCollectionMissingError({ status: 500, message: "internal" }), false);
  assert.equal(isCollectionMissingError(new Error("Bad Request: dim mismatch")), false);
  assert.equal(isCollectionMissingError(undefined), false);
  assert.equal(isCollectionMissingError(null), false);
  assert.equal(isCollectionMissingError("oops"), false);
});

/**
 * Fake-client harness for QdrantVectorStore. The real store lazy-imports
 * `@qdrant/js-client-rest`; here we cheat by populating the private
 * `clientPromise` so `client()` returns our stub. Keeps the test
 * install-free + deterministic.
 *
 * Subtle gotcha: a Proxy that intercepts EVERY property access turns
 * the fake into an unintentional thenable — `await Promise.resolve(fake)`
 * then calls the proxied `.then` and unwraps it. We guard by returning
 * `undefined` for `then`/`catch`/`finally`/Symbol so V8's await/Promise
 * machinery treats the fake as a plain object.
 */
function stubQdrant(store: QdrantVectorStore, calls: Array<{ method: string; args: unknown[]; throws?: unknown }>) {
  const log: Array<{ method: string; args: unknown[] }> = [];
  const fake = new Proxy({}, {
    get(_target, prop) {
      if (prop === "then" || prop === "catch" || prop === "finally" || typeof prop === "symbol") {
        return undefined;
      }
      return (...args: unknown[]) => {
        log.push({ method: String(prop), args });
        const expected = calls.shift();
        if (expected && expected.throws) return Promise.reject(expected.throws);
        return Promise.resolve(undefined);
      };
    }
  });
  // Inject by overwriting the private cache the lazy `client()` reads.
  (store as unknown as { clientPromise: Promise<unknown> }).clientPromise = Promise.resolve(fake);
  return log;
}

test("QdrantVectorStore.deleteByDocIds is a no-op when the collection doesn't exist", async () => {
  const store = new QdrantVectorStore({ url: "http://qdrant.invalid" });
  const log = stubQdrant(store, [
    {
      method: "delete",
      args: [],
      throws: {
        status: 404,
        message: "Not Found",
        data: { status: { error: "Not found: Collection `codebase` doesn't exist!" } }
      }
    }
  ]);
  // The bug was: this used to reject with the enriched 404 error.
  await assert.doesNotReject(
    store.deleteByDocIds("codebase", "tenant-x", ["doc1", "doc2"])
  );
  // Sanity: we DID call delete (i.e. we didn't short-circuit upstream).
  assert.equal(log[0].method, "delete");
});

test("QdrantVectorStore.deleteByIds is a no-op when the collection doesn't exist", async () => {
  const store = new QdrantVectorStore({ url: "http://qdrant.invalid" });
  stubQdrant(store, [
    {
      method: "delete",
      args: [],
      throws: { status: 404, message: "Collection not found" }
    }
  ]);
  await assert.doesNotReject(store.deleteByIds("ghost", ["id1"]));
});

test("QdrantVectorStore.deleteByTenant is a no-op when the collection doesn't exist", async () => {
  const store = new QdrantVectorStore({ url: "http://qdrant.invalid" });
  stubQdrant(store, [
    {
      method: "delete",
      args: [],
      throws: { status: 404, data: { status: { error: "doesn't exist" } } }
    }
  ]);
  await assert.doesNotReject(store.deleteByTenant("ghost", "tenant-x"));
});

test("QdrantVectorStore.deleteByDocIds still PROPAGATES non-missing errors", async () => {
  const store = new QdrantVectorStore({ url: "http://qdrant.invalid" });
  stubQdrant(store, [
    {
      method: "delete",
      args: [],
      throws: { status: 500, message: "Internal Server Error" }
    }
  ]);
  // A real backend error must still surface — the no-op fix is scoped
  // strictly to "collection missing", not "Qdrant is having a bad day".
  await assert.rejects(
    store.deleteByDocIds("docs", "tenant-x", ["doc1"]),
    (err: unknown) => (err as { status?: number }).status === 500
  );
});

// ---------------------------------------------------------------------------
// Same posture as delete: "query a collection that doesn't exist" returns
// empty results, not a 404. Catches the retrieval-side first-run regression:
// a retrieval-only pipeline (e.g. ad-hoc Q&A) pointed at a fresh dataset
// before any ingest has created the collection used to fail with the same
// "Collection X doesn't exist" error qdrant_delete hit.
// ---------------------------------------------------------------------------

test("InMemoryVectorStore.query returns [] when the collection doesn't exist", async () => {
  const store = new InMemoryVectorStore();
  // NOTE: no ensureCollection() — the collection genuinely doesn't exist.
  const results = await store.query("ghost", { vector: [1, 0], topK: 5, tenantId: "t1" });
  assert.deepEqual(results, []);
});

test("QdrantVectorStore.query returns [] when the collection doesn't exist", async () => {
  const store = new QdrantVectorStore({ url: "http://qdrant.invalid" });
  stubQdrant(store, [
    {
      method: "search",
      args: [],
      throws: {
        status: 404,
        message: "Not Found",
        data: { status: { error: "Not found: Collection `ghost` doesn't exist!" } }
      }
    }
  ]);
  const results = await store.query("ghost", { vector: [1, 0], topK: 5, tenantId: "t1" });
  assert.deepEqual(results, []);
});

test("QdrantVectorStore.query still PROPAGATES non-missing errors (e.g. 500)", async () => {
  const store = new QdrantVectorStore({ url: "http://qdrant.invalid" });
  stubQdrant(store, [
    {
      method: "search",
      args: [],
      throws: { status: 500, message: "Internal Server Error" }
    }
  ]);
  await assert.rejects(
    store.query("docs", { vector: [1, 0], topK: 5, tenantId: "t1" }),
    (err: unknown) => (err as { status?: number }).status === 500
  );
});
