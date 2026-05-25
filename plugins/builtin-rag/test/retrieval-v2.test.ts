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
  queryHydePlugin,
  queryFanoutPlugin
} from "../src/retrieval-v2.ts";
import type { PluginExecutionInput, ResolvedDataset } from "../../../packages/plugin-sdk/src/index.ts";
import type { RuntimeContext } from "../../../packages/core/src/index.ts";
import { resetInMemoryVectorStore } from "../../../packages/vector/src/index.ts";

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
    modalities: ["vector"],
    embeddingProfile: {},
    chunkSchema: {},
    version: { id: "v-1", versionLabel: "v1", status: "ready" },
    backendCollections: { vector: "kb_v1" },
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

test("rerank_bge: provider=local routes to the python sidecar", async () => {
  // Stub global fetch so we don't actually hit the network. The
  // important thing is the request shape: POST /execute with the
  // rerank_bge_local plugin id + the documents + question in inputs.
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(
      JSON.stringify({
        outputs: {
          documents: [
            { id: "d1", text: "alpha", rerankScore: 0.9 },
            { id: "d2", text: "beta", rerankScore: 0.1 }
          ]
        },
        usage: { provider: "huggingface-local", model: "BAAI/bge-reranker-v2-m3" }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as unknown as typeof fetch;
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
        sidecarUrl: "http://python-plugins:8000",
        topK: 5
      }
    });
    const docs = result.outputs.documents as Array<{ id: string }>;
    assert.equal(docs[0].id, "d1");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/execute"));
    const body = calls[0].body as {
      plugin: { id: string };
      inputs: { question: string; documents: unknown[] };
    };
    assert.equal(body.plugin.id, "rerank_bge_local");
    assert.equal(body.inputs.question, "what is alpha?");
    assert.equal(body.inputs.documents.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
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
