import test from "node:test";
import assert from "node:assert/strict";
import { DagExecutor, InMemoryExecutionStore } from "../src/index.ts";
import { PluginRegistry, type InProcessPlugin, type PluginManifest } from "../../plugin-sdk/src/index.ts";
import { DatabaseEncryptedSecretProvider, InMemorySecretRepository, StaticKeyProvider } from "../../secrets/src/index.ts";
import { ConfigResolver } from "../../config-resolver/src/index.ts";
import type { PipelineSpec, RuntimeContext } from "../../core/src/index.ts";

/**
 * Helpers — small plugin factories so each test reads top-down without paying
 * the manifest boilerplate cost. Every plugin returns its received `inputs`
 * (or a fragment of them) so tests can assert exactly what the runtime
 * delivered into the downstream input bag.
 */
function recorderPlugin(id: string, manifest?: Partial<PluginManifest>): InProcessPlugin {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      category: "transformer",
      description: "test",
      ...manifest
    },
    async execute({ inputs }) {
      return { outputs: { received: inputs } };
    }
  };
}

function emitterPlugin(id: string, outputs: Record<string, unknown>, manifest?: Partial<PluginManifest>): InProcessPlugin {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      category: "transformer",
      description: "test",
      ...manifest
    },
    async execute() {
      return { outputs };
    }
  };
}

async function buildExecutor(plugins: InProcessPlugin[]): Promise<{ executor: DagExecutor; store: InMemoryExecutionStore; ctx: RuntimeContext }> {
  const registry = new PluginRegistry();
  for (const plugin of plugins) {
    registry.register({ mode: "in_process", manifest: plugin.manifest, implementation: plugin });
  }
  const secretProvider = new DatabaseEncryptedSecretProvider(new InMemorySecretRepository(), new StaticKeyProvider("dev-secret"));
  const store = new InMemoryExecutionStore();
  const executor = new DagExecutor({ pluginRegistry: registry, secretProvider, store });
  const resolver = new ConfigResolver([]);
  const resolvedConfig = resolver.resolve({ pipelineId: "pipe", pipelineVersionId: "v1", tenantId: "t", environment: "prod", values: [] });
  const ctx: RuntimeContext = {
    requestId: "r",
    executionId: `e-${Math.random().toString(36).slice(2)}`,
    tenantId: "t",
    pipelineId: "pipe",
    pipelineVersionId: "v1",
    environment: "prod",
    resolvedConfig
  };
  return { executor, store, ctx };
}

test("edges with fromPort+toPort deliver upstream output at the named slot", async () => {
  const upstream = emitterPlugin("upstream", { documents: [{ id: 1, text: "hello" }], extra: "ignored" });
  const downstream = recorderPlugin("downstream");
  const { executor, ctx } = await buildExecutor([upstream, downstream]);

  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "ports" },
    spec: {
      nodes: [
        { id: "src", plugin: { category: "transformer", id: "upstream", version: "1.0.0" } },
        { id: "dst", plugin: { category: "transformer", id: "downstream", version: "1.0.0" } }
      ],
      edges: [{ from: "src", to: "dst", fromPort: "documents", toPort: "docs" }]
    }
  };

  const result = await executor.execute({ spec, context: ctx, input: {} });
  const received = (result.received as Record<string, unknown>) ?? {};
  assert.deepEqual(received.docs, [{ id: 1, text: "hello" }], "named port wiring should populate inputs.docs");
  assert.equal(received.extra, undefined, "edges with a fromPort should NOT flatten the whole output bag");
});

test("edges without ports flatten upstream outputs at the root of inputs", async () => {
  const retrieve = emitterPlugin("retrieve", { documents: [{ id: 7 }], queryVector: [0.1, 0.2] });
  const downstream = recorderPlugin("downstream");
  const { executor, ctx } = await buildExecutor([retrieve, downstream]);

  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "flatten" },
    spec: {
      nodes: [
        { id: "retrieve", plugin: { category: "transformer", id: "retrieve", version: "1.0.0" } },
        { id: "consumer", plugin: { category: "transformer", id: "downstream", version: "1.0.0" } }
      ],
      edges: [{ from: "retrieve", to: "consumer" }]
    }
  };

  const result = await executor.execute({ spec, context: ctx, input: {} });
  const received = (result.received as Record<string, unknown>) ?? {};
  assert.deepEqual(received.documents, [{ id: 7 }], "documents should be visible at root");
  assert.deepEqual(received.queryVector, [0.1, 0.2], "all upstream output keys should flatten");
  assert.deepEqual(received.retrieve, { documents: [{ id: 7 }], queryVector: [0.1, 0.2] }, "legacy node-id wrapper preserved");
});

test("if_then routes payload to `then` and skips downstream wired to `else`", async () => {
  // Re-import the iteration plugin so the runtime sees its declared output
  // ports. Using the builtin-rag module directly keeps the test honest about
  // the published plugin contract.
  const builtin = await import("../../../plugins/builtin-rag/src/index.ts");
  const elseRecorder = recorderPlugin("else_branch");
  const thenRecorder = recorderPlugin("then_branch");
  const { executor, store, ctx } = await buildExecutor([builtin.ifThenPlugin, elseRecorder, thenRecorder]);

  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "if-then" },
    spec: {
      nodes: [
        { id: "input", type: "input" },
        { id: "branch", plugin: { category: "router", id: "if_then", version: "1.0.0" } },
        { id: "then_node", plugin: { category: "transformer", id: "then_branch", version: "1.0.0" } },
        { id: "else_node", plugin: { category: "transformer", id: "else_branch", version: "1.0.0" } }
      ],
      edges: [
        { from: "input", to: "branch", toPort: "value" },
        { from: "branch", to: "then_node", fromPort: "then", toPort: "payload" },
        { from: "branch", to: "else_node", fromPort: "else", toPort: "payload" }
      ]
    }
  };

  await executor.execute({ spec, context: ctx, input: { value: "non-empty truthy value" } });
  const elseStatus = store.nodes.find((n) => n.nodeId === "else_node" && n.completedAt)?.status;
  const thenStatus = store.nodes.find((n) => n.nodeId === "then_node" && n.completedAt)?.status;
  assert.equal(thenStatus, "succeeded", "then branch should have executed");
  assert.equal(elseStatus, "skipped", "else branch must be skipped when predicate is true");
});

test("foreach runs the body once per item and gathers results", async () => {
  const builtin = await import("../../../plugins/builtin-rag/src/index.ts");
  const adder = emitterPlugin("adder", { doubled: 0 });
  // Replace static output with a per-iteration value computed from inputs.item.
  const dynamicAdder: InProcessPlugin = {
    manifest: { ...adder.manifest, id: "adder" },
    async execute({ inputs }) {
      const item = Number(inputs.item ?? 0);
      return { outputs: { doubled: item * 2 } };
    }
  };
  const { executor, ctx } = await buildExecutor([builtin.forEachPlugin, dynamicAdder]);

  const body: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "body" },
    spec: {
      nodes: [
        { id: "adder", plugin: { category: "transformer", id: "adder", version: "1.0.0" } }
      ],
      edges: []
    }
  };

  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "foreach-test" },
    spec: {
      nodes: [
        {
          id: "loop",
          plugin: { category: "router", id: "foreach", version: "1.0.0" },
          config: { body }
        }
      ],
      edges: []
    }
  };

  const result = await executor.execute({ spec, context: ctx, input: { items: [1, 2, 3] } });
  const results = (result.results as Array<Record<string, unknown>>) ?? [];
  assert.equal(results.length, 3, "should produce one body result per input item");
  assert.deepEqual(results.map((r) => r.doubled), [2, 4, 6], "each iteration should compute item * 2");
});

test("for_loop respects count from config and emits results+final", async () => {
  const builtin = await import("../../../plugins/builtin-rag/src/index.ts");
  const counter: InProcessPlugin = {
    manifest: { id: "counter", name: "counter", version: "1.0.0", category: "transformer", description: "" },
    async execute({ inputs }) {
      return { outputs: { index: inputs.index } };
    }
  };
  const { executor, ctx } = await buildExecutor([builtin.forLoopPlugin, counter]);

  const body: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "body" },
    spec: {
      nodes: [{ id: "c", plugin: { category: "transformer", id: "counter", version: "1.0.0" } }],
      edges: []
    }
  };

  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "for-test" },
    spec: {
      nodes: [{ id: "loop", plugin: { category: "router", id: "for_loop", version: "1.0.0" }, config: { count: 4, body } }],
      edges: []
    }
  };

  const result = await executor.execute({ spec, context: ctx, input: {} });
  const results = (result.results as Array<Record<string, unknown>>) ?? [];
  assert.equal(results.length, 4);
  assert.deepEqual(results.map((r) => r.index), [0, 1, 2, 3]);
  assert.deepEqual(result.final, { index: 3 });
});

test("while_loop terminates when predicate goes false and respects maxIterations ceiling", async () => {
  const builtin = await import("../../../plugins/builtin-rag/src/index.ts");
  const stepper: InProcessPlugin = {
    manifest: { id: "stepper", name: "stepper", version: "1.0.0", category: "transformer", description: "" },
    async execute({ inputs }) {
      const next = Number(inputs.state ?? 0) + 1;
      return { outputs: { state: next, continue: next < 3 } };
    }
  };
  const { executor, ctx } = await buildExecutor([builtin.whileLoopPlugin, stepper]);

  const body: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "body" },
    spec: {
      nodes: [{ id: "s", plugin: { category: "transformer", id: "stepper", version: "1.0.0" } }],
      edges: []
    }
  };

  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "while-test" },
    spec: {
      nodes: [{ id: "loop", plugin: { category: "router", id: "while_loop", version: "1.0.0" }, config: { body, maxIterations: 50 } }],
      edges: []
    }
  };

  const result = await executor.execute({ spec, context: ctx, input: { state: 0 } });
  assert.equal(result.iterations, 3, "should stop the iteration after `continue` flips false");
  assert.equal((result.final as Record<string, unknown>).state, 3);
});

test("pipeline validation flags unknown port references as warnings", async () => {
  const builtin = await import("../../../plugins/builtin-rag/src/index.ts");
  const registry = new PluginRegistry();
  registry.register({ mode: "in_process", manifest: builtin.ifThenPlugin.manifest, implementation: builtin.ifThenPlugin });
  const { validatePipelineSpec } = await import("../../pipeline-spec/src/index.ts");

  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "bad-port" },
    spec: {
      nodes: [
        { id: "branch", plugin: { category: "router", id: "if_then", version: "1.0.0" } },
        { id: "sink", plugin: { category: "router", id: "if_then", version: "1.0.0" } }
      ],
      edges: [{ from: "branch", to: "sink", fromPort: "maybe", toPort: "value" }]
    }
  };

  const result = validatePipelineSpec(spec, registry);
  // unknown_output_port → warning, not error; spec stays valid.
  const portWarn = result.warnings.find((w) => w.code === "unknown_output_port");
  assert.ok(portWarn, `expected unknown_output_port warning, got ${JSON.stringify(result.warnings)}`);
  assert.equal(result.errors.length, 0);
});
