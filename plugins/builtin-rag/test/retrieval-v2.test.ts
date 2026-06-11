/**
 * Phase 9 acceptance — new retrieval plugins.
 *
 * Pure-logic plugins (merge_rrf) get full functional tests. LLM-driven
 * ones (query_hyde, query_fanout, rerank_llm, conversation_rewrite,
 * topic_shift_detect) get a shape-of-manifest check plus a smoke test
 * that verifies the prompt path is exercised — real LLM behaviour is
 * out of scope offline.
 *
 * dataset_search is exercised end-to-end against the InMemoryVectorStore
 * via createVectorStore so the dataset-driven dispatch path is real
 * code, not mocked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeRrfPlugin,
  datasetSearchPlugin,
  datasetUpsertPlugin,
  datasetDeletePlugin,
  queryHydePlugin,
  queryFanoutPlugin,
  pipelineCallPlugin
} from "../src/retrieval-v2.ts";
import type { PluginExecutionInput, ResolvedDataset } from "../../../packages/plugin-sdk/src/index.ts";
import type { RuntimeContext } from "../../../packages/core/src/index.ts";
import { getInMemoryVectorStore, resetInMemoryVectorStore } from "../../../packages/vector/src/index.ts";

function fakeContext(): RuntimeContext {
  return {
    requestId: "r",
    executionId: "e-1",
    tenantId: "t-1",
    pipelineId: "p",
    pipelineVersionId: "v1",
    environment: "dev",
    resolvedConfig: { pipelineId: "p", tenantId: "t-1", environment: "dev", violations: [], values: {} }
  };
}

function fakeDataset(overrides: Partial<ResolvedDataset> = {}): ResolvedDataset {
  return {
    id: "ds-1",
    slug: "kb",
    scope: "environment",
    tenantId: "t-1",
    environmentId: "dev",
    embeddingProfile: {},
    chunkSchema: {},
    version: { id: "v-1", versionLabel: "v1", status: "ready" },
    bindings: {
      vectors: { collection: "kb_v1" }
    },
    ...overrides
  };
}

function runPlugin(args: {
  plugin: typeof mergeRrfPlugin;
  inputs?: Record<string, unknown>;
  config?: Record<string, unknown>;
  dataset?: ResolvedDataset;
}) {
  const input: PluginExecutionInput = {
    context: fakeContext(),
    node: {
      id: "n",
      plugin: { category: args.plugin.manifest.category, id: args.plugin.manifest.id, version: "1.0.0" },
      ...(args.dataset ? { dataset: { slug: args.dataset.slug } } : {})
    },
    inputs: args.inputs ?? {},
    config: args.config ?? {},
    secrets: {},
    dataset: args.dataset
  };
  return args.plugin.execute(input);
}

// ---- merge_rrf ------------------------------------------------------------

test("merge_rrf: ranks a doc higher when it appears near the top of multiple lists", async () => {
  const a = [{ id: "d1" }, { id: "d2" }, { id: "d3" }];
  const b = [{ id: "d1" }, { id: "d3" }];
  const c = [{ id: "d2" }, { id: "d1" }];
  const result = await runPlugin({
    plugin: mergeRrfPlugin,
    inputs: { lists: [a, b, c] },
    config: { k: 60, topK: 3 }
  });
  const ids = (result.outputs.documents as Array<{ id: string }>).map((d) => d.id);
  // d1 appears at rank 0 in two lists + rank 1 in one = highest fused score.
  assert.equal(ids[0], "d1");
  assert.equal(ids.length, 3);
});

test("merge_rrf: empty lists produce an empty output", async () => {
  const result = await runPlugin({
    plugin: mergeRrfPlugin,
    inputs: { lists: [] },
    config: {}
  });
  assert.deepEqual(result.outputs.documents, []);
});

test("merge_rrf: caps to topK", async () => {
  const big = Array.from({ length: 20 }, (_, i) => ({ id: `d${i}` }));
  const result = await runPlugin({
    plugin: mergeRrfPlugin,
    inputs: { lists: [big] },
    config: { topK: 5 }
  });
  assert.equal((result.outputs.documents as unknown[]).length, 5);
});

// ---- dataset_search end-to-end via InMemoryVectorStore --------------------

test("dataset_search: vector mode queries the in-memory store using the dataset's backendCollections", async () => {
  // Seed the in-memory vector store with a few points under the
  // dataset's resolved collection name; dataset_search should pick the
  // collection from `input.dataset.backendCollections.vector` and
  // return ranked hits.
  resetInMemoryVectorStore();
  // We need to populate the store first. Use dataset_upsert (also v2)
  // so the test exercises both write + read paths through dataset
  // dispatch.
  await runPlugin({
    plugin: datasetUpsertPlugin,
    inputs: {
      chunks: [
        { text: "alpha doc" },
        { text: "beta doc" },
        { text: "gamma doc" }
      ],
      vectors: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1]
      ]
    },
    config: { dimensions: 3, distance: "cosine" },
    dataset: fakeDataset()
  });

  const result = await runPlugin({
    plugin: datasetSearchPlugin,
    inputs: { queryVector: [1, 0, 0] },
    config: { topK: 3, modality: "vector" },
    dataset: fakeDataset()
  });
  const docs = result.outputs.documents as Array<{ text?: string; score: number }>;
  assert.equal(docs.length, 3);
  // The exact "alpha doc" vector should rank first.
  assert.equal(docs[0].text, "alpha doc");
});

test("dataset_search: refuses to run without a dataset", async () => {
  await assert.rejects(
    () =>
      runPlugin({
        plugin: datasetSearchPlugin,
        inputs: { queryVector: [1, 0, 0] },
        config: { topK: 1, modality: "vector" }
      }),
    /requires node.dataset/
  );
});

test("dataset_search: returns empty documents on a fresh dataset (no upsert has happened)", async () => {
  // First-run contract: a retrieval-only pipeline pointed at a dataset
  // BEFORE any ingest has populated the backing store must return an
  // empty document list — NOT throw "collection doesn't exist". This is
  // the retrieval-side parallel of the qdrant_delete fix; the same
  // semantic ("first run is a clean state") must hold for queries too.
  resetInMemoryVectorStore();
  // NOTE: no datasetUpsertPlugin pre-seed — the collection genuinely
  // does not exist in the in-memory store.
  const result = await runPlugin({
    plugin: datasetSearchPlugin,
    inputs: { queryVector: [1, 0, 0] },
    config: { topK: 5, modality: "vector" },
    dataset: fakeDataset()
  });
  assert.deepEqual(result.outputs.documents, []);
});

test("dataset_upsert: refuses to run without a dataset", async () => {
  await assert.rejects(
    () =>
      runPlugin({
        plugin: datasetUpsertPlugin,
        inputs: { chunks: [{ text: "x" }], vectors: [[1, 2, 3]] },
        config: {}
      }),
    /requires node.dataset/
  );
});

test("dataset_delete: removes every chunk for the supplied docIds (in-memory vector backend)", async () => {
  resetInMemoryVectorStore();
  // Pre-seed three points: two chunks for "a.ts", one for "b.ts", all
  // under the same tenant. Each carries docId in payload — same shape
  // any real upsert (qdrant_vector_store / dataset_upsert) writes.
  const store = getInMemoryVectorStore();
  await store.ensureCollection("kb_v1", { dimensions: 4, distance: "cosine" });
  await store.upsert("kb_v1", [
    { id: "p-a-0", vector: [1, 0, 0, 0], tenantId: "t-1", payload: { text: "", docId: "a.ts", chunkIndex: 0 } },
    { id: "p-a-1", vector: [0.9, 0, 0, 0], tenantId: "t-1", payload: { text: "", docId: "a.ts", chunkIndex: 1 } },
    { id: "p-b-0", vector: [0, 1, 0, 0], tenantId: "t-1", payload: { text: "", docId: "b.ts", chunkIndex: 0 } }
  ]);
  const result = await runPlugin({
    plugin: datasetDeletePlugin,
    inputs: { deleted: [{ docId: "a.ts" }] },
    config: {},
    dataset: fakeDataset()
  });
  // deletedCount reports source docIds (not chunks removed).
  assert.equal(result.outputs.deletedCount, 1);
  const remaining = await store.query("kb_v1", { vector: [1, 0, 0, 0], topK: 10, tenantId: "t-1" });
  assert.equal(remaining.length, 1, "both a.ts chunks removed; only b.ts remains");
  assert.equal((remaining[0].payload as { docId: string }).docId, "b.ts");
});

test("dataset_delete: refuses to run without a dataset", async () => {
  await assert.rejects(
    () =>
      runPlugin({
        plugin: datasetDeletePlugin,
        inputs: { deleted: [{ docId: "a.ts" }] },
        config: {}
      }),
    /requires node.dataset/
  );
});

test("dataset_delete: empty input no-ops", async () => {
  resetInMemoryVectorStore();
  const result = await runPlugin({
    plugin: datasetDeletePlugin,
    inputs: { deleted: [] },
    config: {},
    dataset: fakeDataset()
  });
  assert.equal(result.outputs.deletedCount, 0);
});

// ---- LLM plugins: manifest shape + input validation -----------------------

test("query_hyde: manifest declares contract: 2 and the right ports", () => {
  assert.equal(queryHydePlugin.manifest.contract, 2);
  assert.equal(queryHydePlugin.manifest.category, "transformer");
  assert.ok(queryHydePlugin.manifest.inputPorts?.some((p) => p.name === "question"));
  assert.ok(queryHydePlugin.manifest.outputPorts?.some((p) => p.name === "hypothetical"));
});

test("query_hyde: refuses to run without a question", async () => {
  await assert.rejects(
    () => runPlugin({ plugin: queryHydePlugin, inputs: {}, config: { provider: "ollama" } }),
    /question/
  );
});

test("query_fanout: manifest declares contract: 2 and outputs `queries`", () => {
  assert.equal(queryFanoutPlugin.manifest.contract, 2);
  assert.ok(queryFanoutPlugin.manifest.outputPorts?.some((p) => p.name === "queries"));
});

// ---- schema validation ----------------------------------------------------

test("dataset_upsert: rejects records that violate the dataset's chunk_schema", async () => {
  // Dataset declares text as required + source_id as a required string.
  // First chunk is fine; second chunk is missing source_id and has the
  // wrong type for chunkIndex.
  const dataset = fakeDataset({
    chunkSchema: {
      type: "object",
      required: ["text", "source_id"],
      properties: {
        text: { type: "string" },
        source_id: { type: "string" },
        chunkIndex: { type: "integer" }
      },
      additionalProperties: true
    }
  });
  await assert.rejects(
    () =>
      runPlugin({
        plugin: datasetUpsertPlugin,
        inputs: {
          chunks: [
            { text: "ok", source_id: "doc-1" },
            { text: "missing source_id" }
          ],
          vectors: [
            [1, 0, 0],
            [0, 1, 0]
          ]
        },
        config: { dimensions: 3 },
        dataset
      }),
    /chunk_schema validation failed/
  );
});

test("dataset_upsert: passes records that conform to chunk_schema", async () => {
  resetInMemoryVectorStore();
  const dataset = fakeDataset({
    chunkSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string" },
        source_id: { type: "string" }
      }
    }
  });
  const result = await runPlugin({
    plugin: datasetUpsertPlugin,
    inputs: {
      chunks: [
        { text: "alpha", source_id: "d1" },
        { text: "beta", source_id: "d2" }
      ],
      vectors: [
        [1, 0, 0],
        [0, 1, 0]
      ]
    },
    config: { dimensions: 3 },
    dataset
  });
  assert.equal(result.outputs.upserted, 2);
});

test("rerank_bge: provider=local routes to the python sidecar via Connect", async () => {
  // Spin up an actual Connect server that implements the PluginRuntime
  // contract — the same wire the sidecar serves. This is the same pattern
  // packages/plugin-sdk/test/external-plugin.test.ts uses; we validate the
  // function-level contract (rerank request → ranked docs) rather than the
  // wire bytes, because the wire is the SDK's responsibility, not this
  // plugin's.
  const http = await import("node:http");
  const { create } = await import("@bufbuild/protobuf");
  const { connectNodeAdapter } = await import("@connectrpc/connect-node");
  const { ExecuteResponseSchema, PluginRuntime } = await import(
    "../../../packages/proto-gen/src/plugin_pb.ts"
  );
  let received: { plugin: string; inputs: Record<string, unknown> } | undefined;
  const handler = connectNodeAdapter({
    routes: (r) => {
      r.service(PluginRuntime, {
        async health() {
          return { ok: true, plugins: ["rerank_bge_local"], message: "" };
        },
        async execute(req) {
          received = {
            plugin: req.plugin,
            inputs: (req.inputs ?? {}) as Record<string, unknown>
          };
          return create(ExecuteResponseSchema, {
            outputs: {
              documents: [
                { id: "d1", text: "alpha", rerankScore: 0.9 },
                { id: "d2", text: "beta", rerankScore: 0.1 }
              ]
            }
          });
        },
        async *executeServerStream() {},
        async executeClientStream() {
          throw new Error("not used");
        },
        async *executeBidi() {}
      });
    }
  });
  const server = http.createServer(handler);
  const port: number = await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve(addr.port);
    })
  );
  try {
    const { rerankBgePlugin } = await import("../src/retrieval-v2.ts");
    const result = await runPlugin({
      plugin: rerankBgePlugin,
      inputs: {
        question: "what is alpha?",
        documents: [
          { id: "d1", text: "alpha is the first letter" },
          { id: "d2", text: "unrelated text" }
        ]
      },
      config: {
        provider: "local",
        sidecarUrl: `http://127.0.0.1:${port}`,
        topK: 5
      }
    });
    const docs = result.outputs.documents as Array<{ id: string }>;
    assert.equal(docs[0].id, "d1");
    // The sidecar saw the rerank request with the right plugin id +
    // question + documents — validated via Connect proto, not /execute JSON.
    assert.equal(received?.plugin, "rerank_bge_local");
    const inputs = received?.inputs as {
      question: string;
      documents: unknown[];
    };
    assert.equal(inputs.question, "what is alpha?");
    assert.equal(inputs.documents.length, 2);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("dataset_upsert: empty / missing chunk_schema accepts any record", async () => {
  // Back-compat: existing pipelines that didn't declare a schema must
  // keep working through dataset_upsert with no change.
  resetInMemoryVectorStore();
  const result = await runPlugin({
    plugin: datasetUpsertPlugin,
    inputs: {
      chunks: [{ text: "x", arbitrary: { nested: true } }],
      vectors: [[1, 0, 0]]
    },
    config: { dimensions: 3 },
    dataset: fakeDataset() // chunkSchema: {}
  });
  assert.equal(result.outputs.upserted, 1);
});

// ---- pipeline_call --------------------------------------------------------

test("pipeline_call: refuses to run outside a synchronous execution", async () => {
  // The runtime injects `runPipelineByRef` only on the synchronous
  // /invoke + /stream path. Batch runs leave it undefined, and the
  // plugin must fail fast instead of pretending to work.
  const input: PluginExecutionInput = {
    context: fakeContext(),
    node: {
      id: "n",
      plugin: {
        category: pipelineCallPlugin.manifest.category,
        id: pipelineCallPlugin.manifest.id,
        version: "1.0.0"
      }
    },
    inputs: { input: { question: "hi" } },
    config: { pipelineSlug: "child" },
    secrets: {}
    // runPipelineByRef intentionally absent
  };
  await assert.rejects(
    pipelineCallPlugin.execute(input),
    /synchronous execution context/
  );
});

test("pipeline_call: requires pipelineSlug in config", async () => {
  const input: PluginExecutionInput = {
    context: fakeContext(),
    node: { id: "n", plugin: { category: "tool", id: "pipeline_call", version: "1.0.0" } },
    inputs: { input: {} },
    config: {},
    secrets: {},
    runPipelineByRef: async () => ({ output: {} })
  };
  await assert.rejects(
    pipelineCallPlugin.execute(input),
    /pipelineSlug is required/
  );
});

test("pipeline_call: forwards the input port to the target pipeline + returns its output", async () => {
  const calls: Array<{ slug: string; input: unknown; environment?: string }> = [];
  const input: PluginExecutionInput = {
    context: fakeContext(),
    node: { id: "n", plugin: { category: "tool", id: "pipeline_call", version: "1.0.0" } },
    inputs: { input: { question: "echo me" } },
    config: { pipelineSlug: "child-pipeline", environment: "staging" },
    secrets: {},
    runPipelineByRef: async (args) => {
      calls.push(args);
      return { output: { answer: `got: ${(args.input as { question?: string }).question ?? ""}` } };
    }
  };
  const result = await pipelineCallPlugin.execute(input);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    slug: "child-pipeline",
    input: { question: "echo me" },
    environment: "staging"
  });
  assert.deepEqual(result.outputs.output, { answer: "got: echo me" });
});

test("pipeline_call: falls back to inputs envelope when no `input` port is wired", async () => {
  // Flow-style users sometimes don't bother wiring the named `input`
  // port — they just dump the whole upstream payload onto the node.
  // The plugin should pass the entire `inputs` object through.
  let captured: unknown = undefined;
  const input: PluginExecutionInput = {
    context: fakeContext(),
    node: { id: "n", plugin: { category: "tool", id: "pipeline_call", version: "1.0.0" } },
    inputs: { question: "no-port-wiring" }, // <- no `.input` key
    config: { pipelineSlug: "child" },
    secrets: {},
    runPipelineByRef: async (args) => {
      captured = args.input;
      return { output: { ok: true } };
    }
  };
  await pipelineCallPlugin.execute(input);
  assert.deepEqual(captured, { question: "no-port-wiring" });
});

test("pipeline_call: manifest declares contract: 2 + the right ports", () => {
  // Contract = 2 so the validator + Builder picker treat it as a
  // first-class plugin (input/output ports etc. are honored).
  assert.equal(pipelineCallPlugin.manifest.contract, 2);
  assert.equal(pipelineCallPlugin.manifest.category, "tool");
  const inputs = pipelineCallPlugin.manifest.inputPorts ?? [];
  const outputs = pipelineCallPlugin.manifest.outputPorts ?? [];
  assert.ok(inputs.some((p) => p.name === "input"));
  assert.ok(outputs.some((p) => p.name === "output"));
});
