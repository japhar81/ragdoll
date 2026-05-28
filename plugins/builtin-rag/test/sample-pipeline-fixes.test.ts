/**
 * Tests for the four sample-pipeline-failure fixes:
 *
 *   1. opensearch_output: empty / wrong-length / null vectors are dropped
 *      with the field omitted (rather than written as a poison value that
 *      OpenSearch reports as `null` in its bulk-error preview).
 *   2. opensearch_hybrid_retriever: when the kNN arm 400s with the
 *      "missing vector field" error shape, fall back to BM25-only and
 *      surface the degradation in output metadata.
 *   3. looksLikeMissingVectorField: only matches the error shapes we've
 *      actually seen, not every 400.
 *   4. enrichQdrantError: bare `Bad Request` is enriched with operation
 *      + collection + ids preview so the trace tells the operator what
 *      to fix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  openSearchOutputPlugin,
  openSearchHybridRetrieverPlugin,
  looksLikeMissingVectorField,
  enrichQdrantError
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

// ---------------------------------------------------------------------------
// 1. opensearch_output: vector hygiene
// ---------------------------------------------------------------------------

test("opensearch_output omits the vector field when vectors[i] is undefined", async (t) => {
  const calls = stubFetch(t, (method, path) => {
    if (method === "HEAD") return { status: 200 };
    if (path.includes("/_bulk")) return { json: { errors: false } };
    return { json: {} };
  });
  await openSearchOutputPlugin.execute({
    context: ctx(),
    node: { id: "sink", plugin: { category: "sink", id: "opensearch_output", version: "1.0.0" } },
    inputs: { documents: [{ id: "a" }, { id: "b" }], vectors: [[1, 0]] },
    config: { ...CFG, index: "kb", vectorField: "vector", dimensions: 2 },
    secrets: {}
  });
  const bulk = calls.find((c) => c.url.includes("/_bulk"))!;
  const lines = (bulk.body as string).trim().split("\n");
  // doc-a has a vector; doc-b should be indexed WITHOUT a `vector` key.
  assert.deepEqual(JSON.parse(lines[1]).vector, [1, 0]);
  assert.equal("vector" in JSON.parse(lines[3]), false);
});

test("opensearch_output drops empty-array vectors and counts them as skippedVectors", async (t) => {
  stubFetch(t, (method, path) => {
    if (method === "HEAD") return { status: 200 };
    if (path.includes("/_bulk")) return { json: { errors: false } };
    return { json: {} };
  });
  const out = await openSearchOutputPlugin.execute({
    context: ctx(),
    node: { id: "sink", plugin: { category: "sink", id: "opensearch_output", version: "1.0.0" } },
    inputs: {
      documents: [{ id: "a" }, { id: "b" }, { id: "c" }],
      vectors: [[1, 0], [], [0, 1]]
    },
    config: { ...CFG, index: "kb", vectorField: "vector", dimensions: 2 },
    secrets: {}
  });
  // The empty-array vector is the poison shape that earlier rendered as
  // `null` in the OpenSearch bulk error preview. We dropped it instead.
  assert.equal(out.outputs.skippedVectors, 1);
  assert.equal(out.outputs.indexed, 3);
});

test("opensearch_output drops wrong-length vectors when dimensions is declared", async (t) => {
  stubFetch(t, (method, path) => {
    if (method === "HEAD") return { status: 200 };
    if (path.includes("/_bulk")) return { json: { errors: false } };
    return { json: {} };
  });
  const out = await openSearchOutputPlugin.execute({
    context: ctx(),
    node: { id: "sink", plugin: { category: "sink", id: "opensearch_output", version: "1.0.0" } },
    inputs: {
      documents: [{ id: "a" }, { id: "b" }],
      // First vector matches dimensions=2; second has length 3 which
      // would explode at OpenSearch's mapper. We drop it instead.
      vectors: [[1, 0], [1, 0, 0]]
    },
    config: { ...CFG, index: "kb", vectorField: "vector", dimensions: 2 },
    secrets: {}
  });
  assert.equal(out.outputs.skippedVectors, 1);
});

// ---------------------------------------------------------------------------
// 2. opensearch_hybrid_retriever: graceful BM25 fallback
// ---------------------------------------------------------------------------

test("opensearch_hybrid_retriever degrades to BM25-only when kNN arm 400s on missing vector field", async (t) => {
  stubFetch(t, (method, path, b) => {
    if (!path.endsWith("/_search")) return { json: {} };
    const body = JSON.parse(b as string);
    if (body.query && body.query.knn) {
      // Real OpenSearch shape for "the index has no knn_vector field".
      return {
        status: 400,
        json: {
          error: {
            type: "query_shard_exception",
            reason: "failed to create query: [vector] field is not knn_vector",
            root_cause: [
              { reason: "[vector] field is not knn_vector" }
            ]
          }
        }
      };
    }
    // Lexical arm returns one hit.
    return {
      json: {
        hits: {
          total: { value: 1 },
          hits: [{ _id: "h1", _score: 1.5, _source: { text: "bm25 only" } }]
        }
      }
    };
  });
  const out = await openSearchHybridRetrieverPlugin.execute({
    context: ctx(),
    node: { id: "ret", plugin: { category: "retriever", id: "opensearch_hybrid_retriever", version: "1.0.0" } },
    inputs: { question: "anything", queryVector: [0.1, 0.2] },
    config: { ...CFG, index: "email_corpus", topK: 5, fields: ["text"] },
    secrets: {}
  });
  // Pipeline did NOT throw. Result includes the BM25 hit and signals
  // the degradation in output + metadata.
  const docs = out.outputs.documents as Array<{ id: string }>;
  assert.equal(docs.length, 1);
  assert.equal(docs[0].id, "h1");
  assert.ok(out.outputs.degraded, "degraded marker should be present in outputs");
  assert.equal(out.metadata?.vectorArmSkipped, true);
});

test("opensearch_hybrid_retriever still throws on unrelated 400s (real query bugs)", async (t) => {
  stubFetch(t, (method, path, b) => {
    if (!path.endsWith("/_search")) return { json: {} };
    const body = JSON.parse(b as string);
    if (body.query && body.query.knn) {
      // Some OTHER 400 — e.g. malformed query. We must NOT silently
      // degrade; that would hide a real bug. The matcher heuristic
      // ignores this shape.
      return {
        status: 400,
        json: {
          error: {
            type: "parsing_exception",
            reason: "Unknown key for a START_OBJECT"
          }
        }
      };
    }
    return { json: { hits: { total: { value: 0 }, hits: [] } } };
  });
  await assert.rejects(
    openSearchHybridRetrieverPlugin.execute({
      context: ctx(),
      node: { id: "ret", plugin: { category: "retriever", id: "opensearch_hybrid_retriever", version: "1.0.0" } },
      inputs: { question: "x", queryVector: [0.1] },
      config: { ...CFG, index: "email_corpus", topK: 5, fields: ["text"] },
      secrets: {}
    }),
    /HTTP 400/
  );
});

// ---------------------------------------------------------------------------
// 3. looksLikeMissingVectorField — direct unit tests on the matcher
// ---------------------------------------------------------------------------

test("looksLikeMissingVectorField matches known kNN-field-missing shapes", () => {
  // shape from a real OpenSearch 400 when the index has no knn_vector
  assert.equal(
    looksLikeMissingVectorField({
      error: {
        type: "query_shard_exception",
        reason: "failed to create query"
      }
    }),
    true
  );
  // shape that mentions the vector field name explicitly
  assert.equal(
    looksLikeMissingVectorField({
      error: {
        type: "x_content_parse_exception",
        reason: "[knn] field [vector] required"
      }
    }),
    true
  );
});

test("looksLikeMissingVectorField rejects unrelated 400s", () => {
  assert.equal(
    looksLikeMissingVectorField({
      error: { type: "parsing_exception", reason: "Unknown key for a START_OBJECT" }
    }),
    false
  );
  // Defensive: garbage / undefined returns false.
  assert.equal(looksLikeMissingVectorField(undefined), false);
  assert.equal(looksLikeMissingVectorField("not-an-object"), false);
  assert.equal(looksLikeMissingVectorField({}), false);
  assert.equal(looksLikeMissingVectorField({ error: "string" }), false);
});

// ---------------------------------------------------------------------------
// 4. enrichQdrantError
// ---------------------------------------------------------------------------

test("enrichQdrantError adds operation + collection + ids preview to bare error", () => {
  const bare = new Error("Bad Request");
  const enriched = enrichQdrantError(bare, {
    operation: "delete",
    collection: "codebase",
    ids: ["a", "b", "c"]
  });
  assert.match(enriched.message, /qdrant delete on "codebase"/);
  assert.match(enriched.message, /Bad Request/);
  assert.match(enriched.message, /ids\[3\]/);
  assert.equal((enriched as { cause?: unknown }).cause, bare);
});

test("enrichQdrantError surfaces server detail from err.data when present", () => {
  const apiErr = Object.assign(new Error("Bad Request"), {
    status: 400,
    data: { status: { error: "Vector dimension mismatch (got 768, expected 1536)" } }
  });
  const enriched = enrichQdrantError(apiErr, {
    operation: "upsert",
    collection: "kb",
    dim: 768,
    count: 100
  });
  assert.match(enriched.message, /HTTP 400/);
  assert.match(enriched.message, /dim=768/);
  assert.match(enriched.message, /count=100/);
  assert.match(enriched.message, /Vector dimension mismatch/);
});

test("enrichQdrantError truncates very large server payloads", () => {
  const big = { reason: "x".repeat(2000) };
  const enriched = enrichQdrantError(
    Object.assign(new Error("Bad Request"), { data: big }),
    { operation: "delete", collection: "kb" }
  );
  // Preview is capped at ~300 chars; assert the message stays bounded
  // so a giant payload can't blow the trace.
  assert.ok(
    enriched.message.length < 500,
    `enriched message should be bounded, got ${enriched.message.length} chars`
  );
});

test("enrichQdrantError truncates id list preview to first 5", () => {
  const enriched = enrichQdrantError(new Error("nope"), {
    operation: "delete",
    collection: "kb",
    ids: Array.from({ length: 20 }, (_, i) => `id-${i}`)
  });
  // Includes the count + first few ids, with an ellipsis.
  assert.match(enriched.message, /ids\[20\]/);
  assert.match(enriched.message, /id-0/);
  assert.match(enriched.message, /id-4/);
  assert.ok(!enriched.message.includes("id-10"), "should NOT include the long tail");
});
