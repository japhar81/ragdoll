/**
 * ADR-0037 result streaming at the executor level:
 *   - a node marked `stream: true` emits its output as a step frame on completion;
 *   - a plugin calling `ctx.emit(channel, data)` emits mid-run, before it returns;
 *   - frames get a monotonic per-execution seq and are both persisted
 *     (store.recordStep) and handed to the onStep sink;
 *   - a node WITHOUT `stream` (and no emit) produces no frames.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DagExecutor,
  InMemoryExecutionStore,
  type ExecutionStepRecord
} from "../src/index.ts";
import { PluginRegistry } from "../../plugin-sdk/src/index.ts";
import {
  DatabaseEncryptedSecretProvider,
  InMemorySecretRepository,
  StaticKeyProvider
} from "../../secrets/src/index.ts";
import type { PipelineSpec } from "../../core/src/index.ts";

function registry(): PluginRegistry {
  const reg = new PluginRegistry();
  const manifest = {
    id: "retriever",
    name: "Retriever",
    version: "1.0.0",
    category: "retriever" as const,
    description: "test"
  };
  reg.register({
    mode: "in_process",
    manifest,
    implementation: {
      manifest,
      // Emits a "primary" doc mid-run, then returns the full doc set.
      async execute(input) {
        input.emit?.("primary", { docId: "d1", title: "primary doc" });
        return { outputs: { docs: [{ docId: "d1" }, { docId: "d2" }] } };
      }
    }
  });
  const passthrough = {
    id: "passthrough",
    name: "Passthrough",
    version: "1.0.0",
    category: "transformer" as const,
    description: "test"
  };
  reg.register({
    mode: "in_process",
    manifest: passthrough,
    implementation: {
      manifest: passthrough,
      async execute(input) {
        return { outputs: { seen: Object.keys(input.inputs) } };
      }
    }
  });
  return reg;
}

function makeExecutor(store: InMemoryExecutionStore, onStep?: (f: ExecutionStepRecord) => void) {
  const secretProvider = new DatabaseEncryptedSecretProvider(
    new InMemorySecretRepository(),
    new StaticKeyProvider("dev-secret")
  );
  return new DagExecutor({
    pluginRegistry: registry(),
    secretProvider,
    store,
    onStep
  });
}

const context = {
  requestId: "r1",
  executionId: "e1",
  tenantId: "tenant-a",
  pipelineId: "pipe",
  pipelineVersionId: "v1",
  environment: "prod",
  resolvedConfig: {
    pipelineId: "pipe",
    tenantId: "tenant-a",
    environment: "prod",
    values: {},
    violations: []
  }
} as never;

test("stream:true node emits its output; a plugin ctx.emit emits mid-run", async () => {
  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "stream-test" },
    spec: {
      nodes: [
        { id: "input", type: "input" },
        {
          id: "retrieve",
          plugin: { category: "retriever", id: "retriever", version: "1.0.0" },
          stream: true,
          streamAs: "docs"
        },
        { id: "output", type: "output" }
      ],
      edges: [
        { from: "input", to: "retrieve" },
        { from: "retrieve", to: "output" }
      ]
    }
  };
  const store = new InMemoryExecutionStore();
  const sink: ExecutionStepRecord[] = [];
  const executor = makeExecutor(store, (f) => sink.push(f));
  await executor.execute({ spec, context, input: { question: "hi" } });

  // Two frames: the ctx.emit "primary" (mid-run) then the declarative "docs".
  assert.equal(store.steps.length, 2, "both frames persisted");
  assert.equal(sink.length, 2, "both frames reached the onStep sink");
  assert.deepEqual(store.steps, sink, "persisted frames match the sink frames");

  const emit = store.steps.find((s) => s.source === "emit");
  const declarative = store.steps.find((s) => s.source === "node_output");
  assert.ok(emit && declarative);
  // ctx.emit fires BEFORE the node returns, so it gets the lower seq.
  assert.equal(emit!.seq, 1);
  assert.equal(declarative!.seq, 2);
  assert.equal(emit!.channel, "primary");
  assert.deepEqual(emit!.data, { docId: "d1", title: "primary doc" });
  // Declarative frame is labeled by streamAs and carries the node output.
  assert.equal(declarative!.channel, "docs");
  assert.deepEqual(declarative!.data, { docs: [{ docId: "d1" }, { docId: "d2" }] });
  assert.equal(declarative!.nodeId, "retrieve");
  // Every frame is scoped to the execution and carries a unique id.
  assert.ok(store.steps.every((s) => s.executionId === "e1"));
  assert.notEqual(store.steps[0].frameId, store.steps[1].frameId);
});

test("a node without stream (and no emit) produces no frames", async () => {
  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "no-stream" },
    spec: {
      nodes: [
        { id: "input", type: "input" },
        {
          id: "pass",
          plugin: { category: "transformer", id: "passthrough", version: "1.0.0" }
        },
        { id: "output", type: "output" }
      ],
      edges: [
        { from: "input", to: "pass" },
        { from: "pass", to: "output" }
      ]
    }
  };
  const store = new InMemoryExecutionStore();
  const sink: ExecutionStepRecord[] = [];
  const executor = makeExecutor(store, (f) => sink.push(f));
  await executor.execute({ spec, context, input: { question: "hi" } });
  assert.equal(store.steps.length, 0);
  assert.equal(sink.length, 0);
});

test("seq is monotonic across two streaming nodes", async () => {
  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "two-stream" },
    spec: {
      nodes: [
        { id: "input", type: "input" },
        {
          id: "a",
          plugin: { category: "transformer", id: "passthrough", version: "1.0.0" },
          stream: true
        },
        {
          id: "b",
          plugin: { category: "transformer", id: "passthrough", version: "1.0.0" },
          stream: true
        },
        { id: "output", type: "output" }
      ],
      edges: [
        { from: "input", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "output" }
      ]
    }
  };
  const store = new InMemoryExecutionStore();
  const executor = makeExecutor(store);
  await executor.execute({ spec, context, input: {} });
  const seqs = store.steps.map((s) => s.seq).sort((x, y) => x - y);
  assert.deepEqual(seqs, [1, 2]);
  // Channel defaults to the node id when streamAs is absent.
  assert.deepEqual(store.steps.map((s) => s.channel).sort(), ["a", "b"]);
});
