/**
 * End-to-end: a real DagExecutor runs
 *   input → gen(25 docs) → stage_collection → foreach_batch(body: sink)
 * proving the whole batch-by-reference path cooperates — the source output is
 * staged to a handle, foreach_batch reads it one page at a time and runs a
 * sub-pipeline per page via the runtime's runSubgraph, and every document is
 * processed in bounded batches without the main pipeline holding them all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DagExecutor, InMemoryExecutionStore } from "../../../packages/runtime/src/index.ts";
import { PluginRegistry } from "../../../packages/plugin-sdk/src/index.ts";
import {
  DatabaseEncryptedSecretProvider,
  InMemorySecretRepository,
  StaticKeyProvider
} from "../../../packages/secrets/src/index.ts";
import type { PipelineSpec } from "../../../packages/core/src/index.ts";
import { stageCollectionPlugin, forEachBatchPlugin } from "../src/plugins/batching.ts";

test("input → gen → stage_collection → foreach_batch(body: sink) processes every doc in bounded batches", async () => {
  const root = mkdtempSync(join(tmpdir(), "rd-batch-e2e-"));
  const recorded: number[] = [];
  let maxBatchSeen = 0;

  const reg = new PluginRegistry();
  reg.register({ mode: "in_process", manifest: stageCollectionPlugin.manifest, implementation: stageCollectionPlugin });
  reg.register({ mode: "in_process", manifest: forEachBatchPlugin.manifest, implementation: forEachBatchPlugin });
  const gen = { id: "gen", name: "gen", version: "1.0.0" as const, category: "tool" as const, contract: 2 as const, description: "gen" };
  reg.register({
    mode: "in_process",
    manifest: gen,
    implementation: { manifest: gen, async execute(input) {
      return { outputs: { documents: Array.from({ length: Number(input.config.count ?? 0) }, (_v, i) => ({ id: i })) } };
    } }
  });
  // The per-batch sink: records each doc id it sees + the batch size.
  const sink = { id: "capture", name: "capture", version: "1.0.0" as const, category: "tool" as const, contract: 2 as const, description: "capture" };
  reg.register({
    mode: "in_process",
    manifest: sink,
    implementation: { manifest: sink, async execute(input) {
      const batch = (input.inputs.batch as Array<{ id: number }>) ?? [];
      maxBatchSeen = Math.max(maxBatchSeen, batch.length);
      for (const d of batch) recorded.push(d.id);
      return { outputs: { count: batch.length } };
    } }
  });

  const executor = new DagExecutor({
    pluginRegistry: reg,
    secretProvider: new DatabaseEncryptedSecretProvider(new InMemorySecretRepository(), new StaticKeyProvider("k")),
    store: new InMemoryExecutionStore()
  });

  const body = {
    nodes: [
      { id: "bin", type: "input" },
      { id: "s", plugin: { category: "tool", id: "capture", version: "1.0.0" } },
      { id: "bout", type: "output" }
    ],
    edges: [
      { from: "bin", to: "s" },
      { from: "s", to: "bout" }
    ]
  };

  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "batch-e2e" },
    spec: {
      nodes: [
        { id: "in", type: "input" },
        { id: "gen", plugin: { category: "tool", id: "gen", version: "1.0.0" }, config: { count: 25 } },
        { id: "stage", plugin: { category: "transformer", id: "stage_collection", version: "1.0.0" }, config: { pageSize: 10, root } },
        { id: "batch", plugin: { category: "control", id: "foreach_batch", version: "1.0.0" }, config: { body } },
        { id: "out", type: "output" }
      ],
      edges: [
        { from: "in", to: "gen" },
        { from: "gen", to: "stage" },
        { from: "stage", to: "batch" },
        { from: "batch", to: "out" }
      ]
    }
  };

  const result = await executor.execute({
    spec,
    context: {
      requestId: "r",
      executionId: "e1",
      tenantId: "t1",
      pipelineId: "p1",
      pipelineVersionId: "v1",
      environment: "dev",
      resolvedConfig: { pipelineId: "p1", pipelineVersionId: "v1", tenantId: "t1", environment: "dev", values: {}, violations: [] }
    },
    input: {}
  });

  // Every document reached the per-batch sink, in bounded pages of 10.
  assert.equal(recorded.length, 25);
  assert.deepEqual([...recorded].sort((a, b) => a - b), Array.from({ length: 25 }, (_v, i) => i));
  assert.equal(maxBatchSeen, 10);
  // The main pipeline's terminal output is the foreach_batch SUMMARY, not 25 docs.
  const out = result as Record<string, unknown>;
  assert.equal(out.totalBatches, 3);
  assert.equal(out.batchesProcessed, 3);
});
