import test from "node:test";
import assert from "node:assert/strict";
import {
  OpenSearchClient,
  OpenSearchError,
  OpenSearchVectorStore,
  createOpenSearchClient,
  type FetchLike
} from "../src/index.ts";

interface Call {
  url: string;
  method: string;
  body?: string;
}

/** Canned OpenSearch transport. `route(method, path)` -> { status, json }. */
function fakeFetch(
  route: (method: string, path: string, body?: string) => { status: number; json?: unknown }
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const r = route(method, path, init?.body);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (r.json === undefined ? "" : JSON.stringify(r.json))
    };
  };
  return { fetchImpl, calls };
}

const ENDPOINT = "http://os.test:9200";

test("createOpenSearchClient returns undefined without an endpoint", () => {
  const prev = process.env.OPENSEARCH_URL;
  delete process.env.OPENSEARCH_URL;
  try {
    assert.equal(createOpenSearchClient({}), undefined);
    assert.ok(createOpenSearchClient({ endpoint: ENDPOINT }) instanceof OpenSearchClient);
  } finally {
    if (prev !== undefined) process.env.OPENSEARCH_URL = prev;
  }
});

test("client sends basic auth header from username/password", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, json: {} }));
  const client = new OpenSearchClient({
    endpoint: ENDPOINT,
    auth: { username: "admin", password: "secret" },
    fetchImpl
  });
  await client.request("GET", "/_cluster/health");
  // Authorization is computed inside headers(); assert via a follow-up search
  // call that the value round-trips by decoding the recorded request is not
  // exposed here, so re-issue with an injected fetch capturing headers.
  let seenAuth: string | undefined;
  const capturing: FetchLike = async (url, init) => {
    seenAuth = (init as { headers?: Record<string, string> }).headers?.authorization;
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const c2 = new OpenSearchClient({
    endpoint: ENDPOINT,
    auth: { username: "admin", password: "secret" },
    fetchImpl: capturing
  });
  await c2.request("GET", "/");
  assert.equal(seenAuth, `Basic ${Buffer.from("admin:secret").toString("base64")}`);
  assert.equal(calls.length, 1);
});

test("indexExists tolerates 404; request throws on other non-2xx", async () => {
  const { fetchImpl } = fakeFetch((method) =>
    method === "HEAD" ? { status: 404 } : { status: 500, json: { error: "boom" } }
  );
  const client = new OpenSearchClient({ endpoint: ENDPOINT, fetchImpl });
  assert.equal(await client.indexExists("missing"), false);
  await assert.rejects(
    () => client.request("GET", "/x"),
    (e: unknown) => {
      assert.ok(e instanceof OpenSearchError);
      assert.equal((e as OpenSearchError).status, 500);
      return true;
    }
  );
});

test("ensureIndex skips create when the index already exists", async () => {
  const { fetchImpl, calls } = fakeFetch((method) =>
    method === "HEAD" ? { status: 200 } : { status: 200, json: {} }
  );
  const client = new OpenSearchClient({ endpoint: ENDPOINT, fetchImpl });
  await client.ensureIndex("kb", { mappings: {} });
  assert.deepEqual(
    calls.map((c) => c.method),
    ["HEAD"]
  );
});

test("bulkIndex builds NDJSON action/doc pairs and reports errors", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, json: { errors: false } }));
  const client = new OpenSearchClient({ endpoint: ENDPOINT, fetchImpl });
  const out = await client.bulkIndex(
    "kb",
    [
      { id: "a", doc: { text: "hello" } },
      { doc: { text: "world" } }
    ],
    true
  );
  assert.deepEqual(out, { indexed: 2 });
  const bulk = calls[0];
  assert.match(bulk.url, /\/_bulk\?refresh=true$/);
  const lines = (bulk.body as string).trim().split("\n");
  assert.equal(lines.length, 4);
  assert.deepEqual(JSON.parse(lines[0]), { index: { _index: "kb", _id: "a" } });
  assert.deepEqual(JSON.parse(lines[1]), { text: "hello" });
  assert.deepEqual(JSON.parse(lines[2]), { index: { _index: "kb" } });

  const failing = fakeFetch(() => ({ status: 200, json: { errors: true, items: [] } }));
  const c2 = new OpenSearchClient({ endpoint: ENDPOINT, fetchImpl: failing.fetchImpl });
  await assert.rejects(() => c2.bulkIndex("kb", [{ doc: { x: 1 } }]), OpenSearchError);
});

test("bulkIndex splits large batches into ~5 MiB chunks", async () => {
  // Build a doc whose JSON ~ 12 KiB; 1000 of these would be ~12 MB → must split.
  const big = "x".repeat(12 * 1024);
  const docs = Array.from({ length: 1000 }, (_, i) => ({ id: `d${i}`, doc: { text: big } }));
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, json: { errors: false } }));
  const client = new OpenSearchClient({ endpoint: ENDPOINT, fetchImpl });
  const out = await client.bulkIndex("kb", docs);
  assert.equal(out.indexed, 1000);
  assert.ok(calls.length >= 2, `expected multiple bulk requests, got ${calls.length}`);
  for (const c of calls) {
    assert.ok((c.body as string).length <= 5 * 1024 * 1024 + 14 * 1024, "chunk under 5 MiB + slack");
  }
});

test("bulkIndex retries once on 429, then succeeds", async () => {
  let attempts = 0;
  const fetchImpl = (async (_url: string, _init: { method?: string }) => {
    attempts += 1;
    if (attempts === 1) {
      return new Response(JSON.stringify({ error: "throttled" }), {
        status: 429,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ errors: false }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
  const client = new OpenSearchClient({ endpoint: ENDPOINT, fetchImpl });
  const out = await client.bulkIndex("kb", [{ doc: { x: 1 } }]);
  assert.equal(out.indexed, 1);
  assert.equal(attempts, 2, "first 429 retried");
});

test("bulkIndex re-throws on second 429", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: "throttled" }), {
      status: 429,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
  const client = new OpenSearchClient({ endpoint: ENDPOINT, fetchImpl });
  await assert.rejects(() => client.bulkIndex("kb", [{ doc: { x: 1 } }]), /429/);
});

test("search parses hits + total shape", async () => {
  const { fetchImpl } = fakeFetch(() => ({
    status: 200,
    json: {
      hits: {
        total: { value: 2 },
        hits: [
          { _id: "1", _score: 1.5, _source: { text: "a" } },
          { _id: "2", _score: null }
        ]
      }
    }
  }));
  const client = new OpenSearchClient({ endpoint: ENDPOINT, fetchImpl });
  const { total, hits } = await client.search("kb", { query: { match_all: {} } });
  assert.equal(total, 2);
  assert.deepEqual(hits, [
    { id: "1", score: 1.5, source: { text: "a" } },
    { id: "2", score: 0, source: {} }
  ]);
});

test("OpenSearchVectorStore round-trips with tenant isolation in the query body", async () => {
  let lastSearchBody: any;
  const { fetchImpl, calls } = fakeFetch((method, path, body) => {
    if (method === "HEAD") return { status: 404 };
    if (method === "PUT") return { status: 200, json: {} };
    if (path.endsWith("/_bulk?refresh=true")) return { status: 200, json: { errors: false } };
    if (path.endsWith("/_search")) {
      lastSearchBody = JSON.parse(body as string);
      return {
        status: 200,
        json: {
          hits: {
            total: { value: 1 },
            hits: [{ _id: "p1", _score: 0.9, _source: { vector: [1, 0], tenantId: "t1", text: "doc" } }]
          }
        }
      };
    }
    if (path.includes("_delete_by_query")) return { status: 200, json: {} };
    if (method === "DELETE") return { status: 200, json: {} };
    return { status: 200, json: {} };
  });
  const store = new OpenSearchVectorStore({ endpoint: ENDPOINT, fetchImpl });

  await store.ensureCollection("docs", { dimensions: 2, distance: "cosine" });
  const put = calls.find((c) => c.method === "PUT");
  assert.ok(put, "ensureCollection should PUT the index");
  const mapping = JSON.parse(put!.body as string);
  assert.equal(mapping.settings.index.knn, true);
  assert.equal(mapping.mappings.properties.vector.dimension, 2);
  assert.equal(mapping.mappings.properties.vector.method.space_type, "cosinesimil");

  await store.upsert("docs", [{ id: "p1", vector: [1, 0], payload: { text: "doc" }, tenantId: "t1" }]);

  const results = await store.query("docs", { vector: [1, 0], topK: 3, tenantId: "t1" });
  assert.equal(lastSearchBody.query.knn.vector.k, 3);
  // kNN filter must be a leaf `term` (Lucene engine rejects compound
  // bool.should with "Rewrite first"). The BM25 path keeps the OR shape; kNN
  // does not.
  assert.deepEqual(lastSearchBody.query.knn.vector.filter.bool.must[0], {
    term: { tenantId: "t1" }
  });
  assert.deepEqual(results, [{ id: "p1", score: 0.9, payload: { text: "doc" } }]);

  await store.deleteByTenant("docs", "t1");
  await store.deleteCollection("docs");
  assert.ok(calls.some((c) => c.url.includes("_delete_by_query")));
  assert.ok(calls.some((c) => c.method === "DELETE"));
});
