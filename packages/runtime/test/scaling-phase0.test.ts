/**
 * Phase 0 scaling guards in the executor:
 *   - output eviction: an intermediate node's output is freed from the in-run
 *     `outputs` map once all its consumers have resolved, so a multi-stage run
 *     doesn't retain every stage's full payload for the whole run;
 *   - doc-count cap: a node that materialises more than `maxNodeOutputDocs`
 *     documents in one step fails loud (NodeOutputTooLargeError) instead of
 *     ballooning worker RAM toward a silent OOM-kill.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DagExecutor, InMemoryExecutionStore, NodeOutputTooLargeError } from "../src/index.ts";
import { PluginRegistry } from "../../plugin-sdk/src/index.ts";
import {
  DatabaseEncryptedSecretProvider,
  InMemorySecretRepository,
  StaticKeyProvider
} from "../../secrets/src/index.ts";
import type { PipelineSpec } from "../../core/src/index.ts";

function registry(): PluginRegistry {
  const reg = new PluginRegistry();
  const mk = (id: string, run: (inputs: Record<string, unknown>, config: Record<string, unknown>) => Record<string, unknown>) => {
    const manifest = { id, name: id, version: "1.0.0" as const, category: "tool" as const, contract: 2 as const, description: id };
    reg.register({
      mode: "in_process",
      manifest,
      implementation: { manifest, async execute(input) { return { outputs: run(input.inputs, input.config) }; } }
    });
  };
  // Generates `count` documents (ignores its inputs).
  mk("gen", (_inputs, config) => ({
    documents: Array.from({ length: Number(config.count ?? 0) }, (_v, i) => ({ id: i }))
  }));
  // Passes the documents straight through.
  mk("pass", (inputs) => ({ documents: (inputs.documents as unknown[]) ?? [] }));
  return reg;
}

function secrets() {
  return new DatabaseEncryptedSecretProvider(new InMemorySecretRepository(), new StaticKeyProvider("k"));
}

// input → a(gen) → b(pass) → output
function spec(count: number): PipelineSpec {
  return {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "chain" },
    spec: {
      nodes: [
        { id: "in", type: "input" },
        { id: "a", plugin: { category: "tool", id: "gen", version: "1.0.0" }, config: { count } },
        { id: "b", plugin: { category: "tool", id: "pass", version: "1.0.0" } },
        { id: "out", type: "output" }
      ],
      edges: [
        { from: "in", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "out" }
      ]
    }
  };
}

const context = {
  requestId: "r",
  executionId: "e1",
  tenantId: "t1",
  pipelineId: "p1",
  pipelineVersionId: "v1",
  environment: "dev",
  resolvedConfig: { pipelineId: "p1", pipelineVersionId: "v1", tenantId: "t1", environment: "dev", values: {}, violations: [] }
};

test("intermediate node outputs are evicted once consumed; terminal output stays correct", async () => {
  const evicted: string[] = [];
  const executor = new DagExecutor({
    pluginRegistry: registry(),
    secretProvider: secrets(),
    store: new InMemoryExecutionStore(),
    onOutputEvicted: (id) => evicted.push(id)
  });
  const res = await executor.execute({ spec: spec(5), context: { ...context }, input: {} });
  // `in` (consumed by a) and `a` (consumed by b) are freed. `b` is a source of
  // the output node → protected; `out` is the terminal leaf → never evicted.
  assert.ok(evicted.includes("in"), `expected 'in' evicted; got ${evicted}`);
  assert.ok(evicted.includes("a"), `expected 'a' evicted; got ${evicted}`);
  assert.ok(!evicted.includes("b"), "b is an output source — must NOT be evicted");
  assert.ok(!evicted.includes("out"), "the output node must NOT be evicted");
  // Correctness: eviction didn't change the result.
  assert.equal(((res as Record<string, unknown>).documents as unknown[]).length, 5);
});

test("a node over maxNodeOutputDocs fails with NodeOutputTooLargeError (attributed to the node)", async () => {
  const executor = new DagExecutor({
    pluginRegistry: registry(),
    secretProvider: secrets(),
    store: new InMemoryExecutionStore(),
    maxNodeOutputDocs: 9
  });
  await assert.rejects(
    () => executor.execute({ spec: spec(10), context: { ...context }, input: {} }),
    (err: unknown) => {
      assert.ok(err instanceof NodeOutputTooLargeError, "typed error");
      assert.equal((err as NodeOutputTooLargeError).nodeId, "a");
      assert.equal((err as NodeOutputTooLargeError).docs, 10);
      assert.equal((err as NodeOutputTooLargeError).limit, 9);
      return true;
    }
  );
});

test("maxNodeOutputDocs = 0 disables the cap (large collections pass)", async () => {
  const executor = new DagExecutor({
    pluginRegistry: registry(),
    secretProvider: secrets(),
    store: new InMemoryExecutionStore(),
    maxNodeOutputDocs: 0
  });
  const res = await executor.execute({ spec: spec(1000), context: { ...context }, input: {} });
  assert.equal(((res as Record<string, unknown>).documents as unknown[]).length, 1000);
});

test("at the cap boundary (docs === limit) the node passes", async () => {
  const executor = new DagExecutor({
    pluginRegistry: registry(),
    secretProvider: secrets(),
    store: new InMemoryExecutionStore(),
    maxNodeOutputDocs: 10
  });
  const res = await executor.execute({ spec: spec(10), context: { ...context }, input: {} });
  assert.equal(((res as Record<string, unknown>).documents as unknown[]).length, 10);
});
