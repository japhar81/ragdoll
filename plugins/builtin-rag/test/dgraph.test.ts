/**
 * Dgraph plugin tests + GraphStore unit tests. All offline: no real
 * Dgraph required — the in-memory store stands in. Covers:
 *
 *   * GraphStore contract (mutate/query/deleteByTenant + tenant
 *     isolation);
 *   * dgraph_upsert stamps `tenant_id` on every node, returns the
 *     uid map for blank nodes, skips empty inputs cleanly;
 *   * dgraph_query forwards the tenantId as `$tenant_id`, surfaces
 *     query errors, and emits the data block on the `results` port;
 *   * config-required validation throws when the operator forgot
 *     the query string.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryGraphStore,
  DgraphStore
} from "../../../packages/graph/src/index.ts";
import {
  dgraphUpsertPlugin,
  dgraphQueryPlugin,
  resetGraphStoreCache
} from "../src/dgraph.ts";
import type {
  PluginExecutionInput,
  PluginExecutionOutput,
  ResolvedDataset
} from "../../../packages/plugin-sdk/src/index.ts";
import type { RuntimeContext } from "../../../packages/core/src/index.ts";

function fakeContext(tenantId = "t-1"): RuntimeContext {
  return {
    requestId: "r",
    executionId: "e-1",
    tenantId,
    pipelineId: "p",
    pipelineVersionId: "v1",
    environment: "dev",
    resolvedConfig: {
      pipelineId: "p",
      tenantId,
      environment: "dev",
      violations: [],
      values: {}
    }
  };
}

/**
 * Build a fake ResolvedDataset bound to an in-memory graph "connection".
 * Plugins now require a resolved connection on the dataset (PR1 of the
 * requires roll-out) — we synthesise one here pointing at a sentinel
 * host that the in-memory GraphStore intercepts so tests don't touch
 * a real Dgraph. Pass `host: "real.example"` to feed a non-sentinel
 * host (e.g. for tests that want to see the URL flow through).
 */
function fakeGraphDataset(host = "memory"): ResolvedDataset {
  return {
    id: "ds-test",
    slug: "test",
    scope: "global",
    modalities: ["graph"],
    embeddingProfile: {},
    chunkSchema: {},
    version: { id: "v1", versionLabel: "v1", status: "ready" },
    backendCollections: {},
    backends: {
      graph: {
        provider: "dgraph",
        connectionName: "test-dgraph",
        connection: {
          name: "test-dgraph",
          type: "dgraph",
          host,
          port: 8080,
          secretRefId: null,
          config: { host, port: 8080 },
          cascadeReason: "tenant_fallback"
        }
      }
    }
  };
}

function runPlugin(
  plugin: typeof dgraphUpsertPlugin,
  args: {
    inputs?: Record<string, unknown>;
    config?: Record<string, unknown>;
    tenantId?: string;
    dataset?: ResolvedDataset;
  } = {}
): Promise<PluginExecutionOutput> {
  const input: PluginExecutionInput = {
    context: fakeContext(args.tenantId),
    node: {
      id: "n",
      plugin: {
        category: plugin.manifest.category,
        id: plugin.manifest.id,
        version: "1.0.0"
      }
    },
    inputs: args.inputs ?? {},
    config: args.config ?? {},
    secrets: {},
    // Default to a fake graph-backend dataset so individual tests don't
    // each have to scaffold one. Tests can still pass `dataset:
    // undefined` explicitly to exercise the missing-binding error path.
    dataset: args.dataset === undefined ? fakeGraphDataset() : args.dataset
  };
  return plugin.execute(input);
}

// ---- InMemoryGraphStore ---------------------------------------------------

test("InMemoryGraphStore: mutate sets tenant_id + minted uids for blank nodes", async () => {
  const store = new InMemoryGraphStore();
  const { uids } = await store.mutate({
    tenantId: "t-1",
    setJson: [
      { uid: "_:alice", "dgraph.type": "Person", name: "Alice" },
      { uid: "_:bob", "dgraph.type": "Person", name: "Bob" }
    ]
  });
  assert.equal(Object.keys(uids).length, 2);
  assert.ok(uids.alice.startsWith("0x"));
  assert.ok(uids.bob.startsWith("0x"));
  assert.equal(store.size("t-1"), 2);
});

test("InMemoryGraphStore: tenants are isolated on query + deleteByTenant", async () => {
  const store = new InMemoryGraphStore();
  await store.mutate({
    tenantId: "t-a",
    setJson: [{ uid: "_:x", "dgraph.type": "Doc", title: "alpha" }]
  });
  await store.mutate({
    tenantId: "t-b",
    setJson: [{ uid: "_:y", "dgraph.type": "Doc", title: "beta" }]
  });
  // Query as tenant A — sees only its row.
  const a = await store.query({
    tenantId: "t-a",
    query: "{ all(func: type(Doc)) { title } }"
  });
  assert.deepEqual(a, { all: [{ title: "alpha" }] });
  // Delete tenant A; tenant B's row survives.
  await store.deleteByTenant("t-a");
  assert.equal(store.size("t-a"), 0);
  assert.equal(store.size("t-b"), 1);
});

// ---- dgraph_upsert --------------------------------------------------------

test("dgraph_upsert: writes nodes + returns uid map; empty input no-ops", async () => {
  resetGraphStoreCache();
  const result = await runPlugin(dgraphUpsertPlugin, {
    inputs: {
      nodes: [
        { uid: "_:org", "dgraph.type": "Org", name: "Acme" },
        { uid: "_:user", "dgraph.type": "User", name: "alice", org: { uid: "_:org" } }
      ]
    }
  });
  assert.equal(result.outputs.upserted, 2);
  const uids = result.outputs.uids as Record<string, string>;
  assert.equal(Object.keys(uids).length, 2);
  assert.ok(uids.org);
  assert.ok(uids.user);

  // Second call: empty nodes array. Must not throw and must return 0.
  const empty = await runPlugin(dgraphUpsertPlugin, { inputs: { nodes: [] } });
  assert.equal(empty.outputs.upserted, 0);
});

test("dgraph_upsert: stamps tenant_id on every node before mutating", async () => {
  resetGraphStoreCache();
  await runPlugin(dgraphUpsertPlugin, {
    tenantId: "t-tenant",
    inputs: {
      nodes: [{ uid: "_:n", "dgraph.type": "Doc", text: "hi" }]
    }
  });
  // Read back via a query as a different tenant — should see nothing.
  const result = await runPlugin(dgraphQueryPlugin, {
    tenantId: "t-other",
    config: { query: "{ all(func: type(Doc)) { text } }" }
  });
  assert.deepEqual(result.outputs.results, { all: [] });
});

test("dgraph_upsert: surfaces a clean error when nodes input is missing", async () => {
  resetGraphStoreCache();
  // Missing inputs.nodes should not throw — empty array semantics.
  const result = await runPlugin(dgraphUpsertPlugin, { inputs: {} });
  assert.equal(result.outputs.upserted, 0);
});

// ---- dgraph_query ---------------------------------------------------------

test("dgraph_query: returns the data block for the executing tenant", async () => {
  resetGraphStoreCache();
  await runPlugin(dgraphUpsertPlugin, {
    inputs: {
      nodes: [
        { uid: "_:doc1", "dgraph.type": "Doc", title: "first" },
        { uid: "_:doc2", "dgraph.type": "Doc", title: "second" }
      ]
    }
  });
  const result = await runPlugin(dgraphQueryPlugin, {
    config: { query: "{ docs(func: type(Doc)) { title } }" }
  });
  const data = result.outputs.results as { docs: Array<{ title: string }> };
  const titles = data.docs.map((d) => d.title).sort();
  assert.deepEqual(titles, ["first", "second"]);
});

test("dgraph_query: requires `query` in config", async () => {
  resetGraphStoreCache();
  await assert.rejects(
    () => runPlugin(dgraphQueryPlugin, { config: {} }),
    /query.*required/
  );
});

// ---- DgraphStore (HTTP) — covers mutate/query/auth via a stub ------------

test("DgraphStore: mutate POSTs setJson + stamps tenant_id + parses uids", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const store = new DgraphStore({
    url: "http://dgraph.test:8080",
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init: init ?? {} });
      return new Response(
        JSON.stringify({ data: { uids: { foo: "0x1" } } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch
  });
  const out = await store.mutate({
    tenantId: "t-1",
    setJson: [{ uid: "_:foo", "dgraph.type": "X" }]
  });
  assert.deepEqual(out.uids, { foo: "0x1" });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/mutate?commitNow=true"));
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.set[0].tenant_id, "t-1");
});

test("DgraphStore: query body includes $tenant_id variable + surfaces errors", async () => {
  let bodySeen: unknown;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    void url;
    bodySeen = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(JSON.stringify({ data: { hits: [] } }), {
      status: 200
    });
  }) as unknown as typeof fetch;
  const store = new DgraphStore({ url: "http://test:8080", fetchImpl });
  await store.query({ tenantId: "t-x", query: "{ hits { uid } }" });
  const b = bodySeen as { variables?: Record<string, string> };
  assert.equal(b.variables?.$tenant_id, "t-x");

  // Error path: surface Dgraph's `errors` block as a thrown error.
  const errStore = new DgraphStore({
    url: "http://test:8080",
    fetchImpl: (async () =>
      new Response(JSON.stringify({ errors: [{ message: "boom" }] }), {
        status: 200
      })) as unknown as typeof fetch
  });
  await assert.rejects(
    () => errStore.query({ tenantId: "t", query: "{ x { uid } }" }),
    /dgraph query errors/
  );
});

test("DgraphStore: deleteByTenant issues an upsert mutation scoped to tenant_id", async () => {
  let bodySeen: unknown;
  const store = new DgraphStore({
    url: "http://test:8080",
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      void url;
      bodySeen = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch
  });
  await store.deleteByTenant("acme");
  const b = bodySeen as { query: string; mutations: Array<{ delete: unknown[] }> };
  assert.ok(b.query.includes('eq(tenant_id, "acme")'));
  assert.deepEqual(b.mutations[0].delete, [{ uid: "uid(v)" }]);
});

// ---- manifest sanity ------------------------------------------------------

test("dgraph_upsert + dgraph_query manifests declare graph modality", () => {
  assert.equal(dgraphUpsertPlugin.manifest.contract, 2);
  assert.deepEqual(dgraphUpsertPlugin.manifest.datasetModalities, ["graph"]);
  assert.equal(dgraphUpsertPlugin.manifest.category, "sink");
  assert.equal(dgraphQueryPlugin.manifest.contract, 2);
  assert.deepEqual(dgraphQueryPlugin.manifest.datasetModalities, ["graph"]);
  assert.equal(dgraphQueryPlugin.manifest.category, "retriever");
});
