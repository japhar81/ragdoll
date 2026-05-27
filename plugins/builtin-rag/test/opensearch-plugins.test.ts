import test from "node:test";
import assert from "node:assert/strict";
import {
  fuseHybridResults,
  openSearchInputPlugin,
  openSearchOutputPlugin,
  openSearchBm25RetrieverPlugin,
  openSearchVectorRetrieverPlugin,
  openSearchHybridRetrieverPlugin
} from "../src/index.ts";
import type { RuntimeContext } from "../../../packages/core/src/index.ts";

function ctx(tenantId = "t1"): RuntimeContext {
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

interface Recorded {
  url: string;
  method: string;
  body?: string;
}

/**
 * Install a fake `globalThis.fetch` for the duration of a test. `router`
 * returns the JSON body for a given (method, path, body); status defaults 200.
 */
function stubFetch(
  t: { after(fn: () => void): void },
  router: (method: string, path: string, body?: string) => { status?: number; json?: unknown }
): Recorded[] {
  const recorded: Recorded[] = [];
  const prev = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (
    url: string,
    init?: { method?: string; body?: string }
  ) => {
    const method = init?.method ?? "GET";
    recorded.push({ url, method, body: init?.body });
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const r = router(method, path, init?.body);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (r.json === undefined ? "" : JSON.stringify(r.json))
    };
  };
  t.after(() => {
    (globalThis as { fetch: unknown }).fetch = prev;
  });
  return recorded;
}

const CFG = { endpoint: "http://os.test:9200" };

test("fuseHybridResults: RRF rewards items ranked high in either arm", () => {
  const lexical = [
    { id: "a", score: 9, source: { t: "a" } },
    { id: "b", score: 8, source: { t: "b" } }
  ];
  const vector = [
    { id: "b", score: 0.9, source: { t: "b" } },
    { id: "c", score: 0.8, source: { t: "c" } }
  ];
  const fused = fuseHybridResults(lexical, vector, { mode: "rrf", rrfK: 60, topK: 3 });
  // b appears top-ish in both arms -> highest fused score.
  assert.equal(fused[0].id, "b");
  assert.equal(fused.length, 3);
  assert.ok(fused[0].score >= fused[1].score && fused[1].score >= fused[2].score);
});

test("fuseHybridResults: weighted blend honors alpha", () => {
  const lexical = [
    { id: "a", score: 10, source: {} },
    { id: "b", score: 0, source: {} }
  ];
  const vector = [
    { id: "b", score: 10, source: {} },
    { id: "a", score: 0, source: {} }
  ];
  const lexHeavy = fuseHybridResults(lexical, vector, { mode: "weighted", alpha: 0, topK: 2 });
  assert.equal(lexHeavy[0].id, "a");
  const vecHeavy = fuseHybridResults(lexical, vector, { mode: "weighted", alpha: 1, topK: 2 });
  assert.equal(vecHeavy[0].id, "b");
});

test("opensearch_input maps hits to documents and filters by tenant when configured", async (t) => {
  let searchBody: any;
  const calls = stubFetch(t, (method, path, body) => {
    if (path.endsWith("/_search")) {
      searchBody = JSON.parse(body as string);
      return {
        json: {
          hits: {
            total: { value: 1 },
            hits: [{ _id: "d1", _score: 1, _source: { text: "hello", lang: "en" } }]
          }
        }
      };
    }
    return { json: {} };
  });
  const out = await openSearchInputPlugin.execute({
    context: ctx(),
    node: { id: "src", plugin: { category: "datasource", id: "opensearch_input", version: "1.0.0" } },
    inputs: {},
    config: { ...CFG, index: "kb", query: "hello", textField: "text", tenantField: "tenantId" },
    secrets: {}
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(searchBody.query.bool.must[0], { query_string: { query: "hello" } });
  assert.deepEqual(searchBody.query.bool.filter[0], {
    bool: {
      should: [
        { term: { tenantId: "t1" } },
        { term: { "tenantId.keyword": "t1" } }
      ],
      minimum_should_match: 1
    }
  });
  assert.deepEqual(out.outputs.documents, [{ id: "d1", text: "hello", metadata: { lang: "en" } }]);
});

test("opensearch_output bulk-indexes documents, stamps tenantId, provisions kNN index", async (t) => {
  const calls = stubFetch(t, (method, path) => {
    if (method === "HEAD") return { status: 404 };
    if (method === "PUT") return { json: {} };
    if (path.includes("/_bulk")) return { json: { errors: false } };
    return { json: {} };
  });
  const out = await openSearchOutputPlugin.execute({
    context: ctx(),
    node: { id: "sink", plugin: { category: "sink", id: "opensearch_output", version: "1.0.0" } },
    inputs: { documents: [{ id: "x1", text: "a" }], vectors: [[1, 0]] },
    config: {
      ...CFG,
      index: "kb",
      vectorField: "vector",
      createKnnIndex: true,
      dimensions: 2,
      distance: "cosine"
    },
    secrets: {}
  });
  assert.deepEqual(out.outputs, { indexed: 1 });
  const put = calls.find((c) => c.method === "PUT")!;
  assert.equal(JSON.parse(put.body as string).mappings.properties.vector.method.space_type, "cosinesimil");
  const bulk = calls.find((c) => c.url.includes("/_bulk"))!;
  const lines = (bulk.body as string).trim().split("\n");
  const doc = JSON.parse(lines[1]);
  assert.equal(doc.tenantId, "t1");
  assert.deepEqual(doc.vector, [1, 0]);
});

test("opensearch_bm25_retriever issues multi_match with tenant filter", async (t) => {
  let body: any;
  stubFetch(t, (method, path, b) => {
    if (path.endsWith("/_search")) {
      body = JSON.parse(b as string);
      return {
        json: { hits: { total: { value: 1 }, hits: [{ _id: "1", _score: 3.2, _source: { text: "ans" } }] } }
      };
    }
    return { json: {} };
  });
  const out = await openSearchBm25RetrieverPlugin.execute({
    context: ctx(),
    node: { id: "r", plugin: { category: "retriever", id: "opensearch_bm25_retriever", version: "1.0.0" } },
    inputs: { question: "how do I reset?" },
    config: { ...CFG, index: "kb", fields: ["text", "title"], topK: 4 },
    secrets: {}
  });
  assert.equal(body.size, 4);
  assert.deepEqual(body.query.bool.must[0].multi_match.fields, ["text", "title"]);
  assert.deepEqual(body.query.bool.filter[0], {
    bool: {
      should: [
        { term: { tenantId: "t1" } },
        { term: { "tenantId.keyword": "t1" } }
      ],
      minimum_should_match: 1
    }
  });
  assert.deepEqual(out.outputs.documents, [{ id: "1", score: 3.2, text: "ans" }]);
});

test("opensearch_vector_retriever queries kNN and strips vector/tenant from payload", async (t) => {
  stubFetch(t, (method, path) => {
    if (path.endsWith("/_search"))
      return {
        json: {
          hits: {
            total: { value: 1 },
            hits: [{ _id: "p1", _score: 0.8, _source: { vector: [1, 0], tenantId: "t1", text: "doc" } }]
          }
        }
      };
    return { json: {} };
  });
  const out = await openSearchVectorRetrieverPlugin.execute({
    context: ctx(),
    node: { id: "r", plugin: { category: "retriever", id: "opensearch_vector_retriever", version: "1.0.0" } },
    inputs: { queryVector: [1, 0] },
    config: { ...CFG, index: "kb", topK: 5 },
    secrets: {}
  });
  assert.deepEqual(out.outputs.documents, [{ id: "p1", score: 0.8, text: "doc" }]);
});

test("opensearch_hybrid_retriever fuses lexical + kNN arms", async (t) => {
  const calls = stubFetch(t, (method, path, b) => {
    if (path.endsWith("/_search")) {
      const parsed = JSON.parse(b as string);
      const isKnn = !!parsed.query?.knn;
      return {
        json: {
          hits: {
            total: { value: 2 },
            hits: isKnn
              ? [
                  { _id: "b", _score: 0.9, _source: { text: "b", vector: [1, 0] } },
                  { _id: "c", _score: 0.7, _source: { text: "c", vector: [0, 1] } }
                ]
              : [
                  { _id: "a", _score: 5, _source: { text: "a" } },
                  { _id: "b", _score: 4, _source: { text: "b" } }
                ]
          }
        }
      };
    }
    return { json: {} };
  });
  const out = await openSearchHybridRetrieverPlugin.execute({
    context: ctx(),
    node: { id: "r", plugin: { category: "retriever", id: "opensearch_hybrid_retriever", version: "1.0.0" } },
    inputs: { queryVector: [1, 0], question: "q" },
    config: { ...CFG, index: "kb", mode: "rrf", topK: 3 },
    secrets: {}
  });
  // Two _search calls (lexical + knn).
  assert.equal(calls.filter((c) => c.url.endsWith("/_search")).length, 2);
  const docs = out.outputs.documents as Array<{ id: string; score: number }>;
  // "b" is present in both arms -> ranks first under RRF; vector field stripped.
  assert.equal(docs[0].id, "b");
  assert.ok(!("vector" in docs[0]));
  assert.equal(docs.length, 3);
});
