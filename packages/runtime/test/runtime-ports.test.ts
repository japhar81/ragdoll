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

// ---------------------------------------------------------------------------
// Multi-in / multi-out parallelization correctness.
//
// Three scenarios; in each, the orchestration must deliver the correct data
// AND every node that *should* run does run exactly once. These don't
// assert wall-clock concurrency — see the note at the bottom of the file
// for that — but they prove data flow is right across the common fan-out
// / fan-in / diamond shapes.
// ---------------------------------------------------------------------------

test("fan-in: a node with two upstreams fires once with merged inputs", async () => {
  const a = emitterPlugin("a", { msg: "hello" });
  const b = emitterPlugin("b", { count: 7 });
  const merger = recorderPlugin("merger");
  const { executor, store, ctx } = await buildExecutor([a, b, merger]);

  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "fan-in" },
    spec: {
      nodes: [
        { id: "a", plugin: { category: "transformer", id: "a", version: "1.0.0" } },
        { id: "b", plugin: { category: "transformer", id: "b", version: "1.0.0" } },
        { id: "m", plugin: { category: "transformer", id: "merger", version: "1.0.0" } }
      ],
      edges: [
        { from: "a", to: "m" },
        { from: "b", to: "m" }
      ]
    }
  };

  const result = await executor.execute({ spec, context: ctx, input: {} });
  // Merger ran exactly once and saw BOTH upstream outputs at root via the
  // flatten-at-root fallback.
  const mergerRuns = store.nodes.filter((n) => n.nodeId === "m" && n.status === "succeeded");
  assert.equal(mergerRuns.length, 1, "merger ran exactly once despite two upstreams");
  const received = (result.received as Record<string, unknown>) ?? {};
  assert.equal(received.msg, "hello", "data from upstream `a` reached the merger");
  assert.equal(received.count, 7, "data from upstream `b` reached the merger");
});

test("fan-out: one upstream feeds two downstreams via distinct ports", async () => {
  const source = emitterPlugin("source", { left: "L", right: "R", common: "C" });
  const leftConsumer = recorderPlugin("left");
  const rightConsumer = recorderPlugin("right");
  const { executor, store, ctx } = await buildExecutor([source, leftConsumer, rightConsumer]);

  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "fan-out" },
    spec: {
      nodes: [
        { id: "src", plugin: { category: "transformer", id: "source", version: "1.0.0" } },
        { id: "left", plugin: { category: "transformer", id: "left", version: "1.0.0" } },
        { id: "right", plugin: { category: "transformer", id: "right", version: "1.0.0" } }
      ],
      edges: [
        { from: "src", to: "left", fromPort: "left", toPort: "value" },
        { from: "src", to: "right", fromPort: "right", toPort: "value" }
      ]
    }
  };

  await executor.execute({ spec, context: ctx, input: {} });
  // Source executed once; both downstreams executed and each received the
  // port-specific value, not the whole bag.
  const sourceRuns = store.nodes.filter((n) => n.nodeId === "src" && n.status === "succeeded");
  assert.equal(sourceRuns.length, 1, "fan-out: source runs ONCE, not once per downstream");
  const leftRun = store.nodes.find((n) => n.nodeId === "left" && n.status === "succeeded");
  const rightRun = store.nodes.find((n) => n.nodeId === "right" && n.status === "succeeded");
  assert.ok(leftRun && rightRun, "both downstream branches executed");
  // The recorder plugins emit { received: inputs }, so the completed-node
  // `output` carries what each downstream actually saw — we read from
  // there instead of `input` because completeNode replaces the row.
  const leftReceived = ((leftRun!.output as { received?: Record<string, unknown> })?.received) ?? {};
  const rightReceived = ((rightRun!.output as { received?: Record<string, unknown> })?.received) ?? {};
  assert.equal(leftReceived.value, "L", "left got source.left via the named port");
  assert.equal(rightReceived.value, "R", "right got source.right via the named port");
});

test("diamond: parallel branches both execute and converge at a fan-in", async () => {
  const root = emitterPlugin("root", { seed: 1 });
  const upper = emitterPlugin("upper", { tag: "U" });
  const lower = emitterPlugin("lower", { tag: "L" });
  const sink = recorderPlugin("sink");
  const { executor, store, ctx } = await buildExecutor([root, upper, lower, sink]);

  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "diamond" },
    spec: {
      nodes: [
        { id: "root", plugin: { category: "transformer", id: "root", version: "1.0.0" } },
        { id: "u", plugin: { category: "transformer", id: "upper", version: "1.0.0" } },
        { id: "l", plugin: { category: "transformer", id: "lower", version: "1.0.0" } },
        { id: "sink", plugin: { category: "transformer", id: "sink", version: "1.0.0" } }
      ],
      edges: [
        { from: "root", to: "u" },
        { from: "root", to: "l" },
        { from: "u", to: "sink" },
        { from: "l", to: "sink" }
      ]
    }
  };

  const result = await executor.execute({ spec, context: ctx, input: {} });
  // Every node ran once; the sink saw both branch outputs.
  for (const id of ["root", "u", "l", "sink"]) {
    const runs = store.nodes.filter((n) => n.nodeId === id && n.status === "succeeded");
    assert.equal(runs.length, 1, `${id} executed exactly once`);
  }
  const received = (result.received as Record<string, unknown>) ?? {};
  // Both branch outputs reach the sink via the flatten-at-root fallback —
  // `tag` collides because both branches emit it, last-merge-wins (which
  // is the documented semantics; if you want both, use distinct ports).
  assert.ok(received.tag === "U" || received.tag === "L", "sink saw at least one branch");
  // The legacy per-source wrapper keeps both unambiguously available.
  assert.deepEqual(received.u, { tag: "U" }, "sink can disambiguate via upstream node id");
  assert.deepEqual(received.l, { tag: "L" }, "sink can disambiguate via upstream node id");
});

test("diamond with port wiring: sink can disambiguate via named ports", async () => {
  // Same DAG as above but downstream uses fromPort + toPort to keep each
  // branch's output in a distinct slot at the sink.
  const root = emitterPlugin("root", { seed: 1 });
  const upper = emitterPlugin("upper", { tag: "U" });
  const lower = emitterPlugin("lower", { tag: "L" });
  const sink = recorderPlugin("sink");
  const { executor, store, ctx } = await buildExecutor([root, upper, lower, sink]);

  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "diamond-ports" },
    spec: {
      nodes: [
        { id: "root", plugin: { category: "transformer", id: "root", version: "1.0.0" } },
        { id: "u", plugin: { category: "transformer", id: "upper", version: "1.0.0" } },
        { id: "l", plugin: { category: "transformer", id: "lower", version: "1.0.0" } },
        { id: "sink", plugin: { category: "transformer", id: "sink", version: "1.0.0" } }
      ],
      edges: [
        { from: "root", to: "u" },
        { from: "root", to: "l" },
        { from: "u", to: "sink", fromPort: "tag", toPort: "upperTag" },
        { from: "l", to: "sink", fromPort: "tag", toPort: "lowerTag" }
      ]
    }
  };

  await executor.execute({ spec, context: ctx, input: {} });
  const sinkRun = store.nodes.find((n) => n.nodeId === "sink" && n.status === "succeeded");
  assert.ok(sinkRun);
  // Read from output.received (the recorder echoes its inputs into outputs)
  // because completeNode drops the `input` field from the stored row.
  const sinkReceived = ((sinkRun!.output as { received?: Record<string, unknown> })?.received) ?? {};
  assert.equal(sinkReceived.upperTag, "U", "named port carries upper.tag to sink.upperTag");
  assert.equal(sinkReceived.lowerTag, "L", "named port carries lower.tag to sink.lowerTag");
});

test("multi-output: a single source feeds three downstreams from three named ports", async () => {
  // Mirrors the if_then / path_classifier shape: one node emits on three
  // ports, three downstreams each consume one. Verifies the source runs
  // ONCE — port routing is read-only fan-out.
  const splitter: InProcessPlugin = {
    manifest: {
      id: "splitter",
      name: "splitter",
      version: "1.0.0",
      category: "router",
      description: "",
      outputPorts: [{ name: "x" }, { name: "y" }, { name: "z" }]
    },
    async execute() {
      return { outputs: { x: 1, y: 2, z: 3 } };
    }
  };
  const sinks = ["sx", "sy", "sz"].map((id) => recorderPlugin(id));
  const { executor, store, ctx } = await buildExecutor([splitter, ...sinks]);

  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "three-way-split" },
    spec: {
      nodes: [
        { id: "splitter", plugin: { category: "router", id: "splitter", version: "1.0.0" } },
        { id: "sx", plugin: { category: "transformer", id: "sx", version: "1.0.0" } },
        { id: "sy", plugin: { category: "transformer", id: "sy", version: "1.0.0" } },
        { id: "sz", plugin: { category: "transformer", id: "sz", version: "1.0.0" } }
      ],
      edges: [
        { from: "splitter", to: "sx", fromPort: "x", toPort: "value" },
        { from: "splitter", to: "sy", fromPort: "y", toPort: "value" },
        { from: "splitter", to: "sz", fromPort: "z", toPort: "value" }
      ]
    }
  };

  await executor.execute({ spec, context: ctx, input: {} });
  const splitterRuns = store.nodes.filter((n) => n.nodeId === "splitter" && n.status === "succeeded");
  assert.equal(splitterRuns.length, 1, "multi-output source still runs ONCE");
  for (const [id, expected] of [["sx", 1], ["sy", 2], ["sz", 3]] as const) {
    const run = store.nodes.find((n) => n.nodeId === id && n.status === "succeeded");
    assert.ok(run, `${id} executed`);
    const received = ((run!.output as { received?: Record<string, unknown> })?.received) ?? {};
    assert.equal(received.value, expected, `${id} received its port-specific value ${expected}`);
  }
});

test("diamond with skip: a skipped branch doesn't prevent the live branch from reaching the sink", async () => {
  // root → if_then(else dies) → both branches lead to sink.
  // The dead branch is skipped; the sink still fires off the live one.
  const builtin = await import("../../../plugins/builtin-rag/src/index.ts");
  const liveSide = emitterPlugin("live_side", { value: "yes" });
  const sink = recorderPlugin("sink");
  const { executor, store, ctx } = await buildExecutor([builtin.ifThenPlugin, liveSide, sink]);

  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "skip-diamond" },
    spec: {
      nodes: [
        { id: "input", type: "input" },
        { id: "branch", plugin: { category: "router", id: "if_then", version: "1.0.0" } },
        { id: "alive", plugin: { category: "transformer", id: "live_side", version: "1.0.0" } },
        { id: "sink", plugin: { category: "transformer", id: "sink", version: "1.0.0" } }
      ],
      edges: [
        { from: "input", to: "branch", toPort: "value" },
        // Wire the live `alive` node to the `then` branch — fires when the
        // predicate is truthy. The `else` branch goes straight to sink.
        { from: "branch", to: "alive", fromPort: "then", toPort: "payload" },
        { from: "alive", to: "sink" },
        { from: "branch", to: "sink", fromPort: "else", toPort: "payload" }
      ]
    }
  };

  await executor.execute({ spec, context: ctx, input: { value: true } });
  // alive ran (then branch was live). The sink's incoming edge from
  // branch.else is DEAD (else port didn't emit) — sink should still fire
  // because the alive → sink edge is live.
  const aliveStatus = store.nodes.find((n) => n.nodeId === "alive" && n.completedAt)?.status;
  const sinkStatus = store.nodes.find((n) => n.nodeId === "sink" && n.completedAt)?.status;
  assert.equal(aliveStatus, "succeeded", "then-branch downstream ran");
  assert.equal(sinkStatus, "succeeded", "sink ran because at least one incoming edge was live");
});

// ---------------------------------------------------------------------------
// Wall-clock parallelism: the runtime today is a serial scheduler. Two
// independent ready nodes execute one after the other, not concurrently.
// We document that with a test that *fails* if we ever silently switched
// to concurrent execution — and conversely passes today, confirming the
// expected behaviour.
//
// If/when we add concurrent execution (Promise.all of the ready queue),
// flip this test's expectation: that change is intentional, not a
// regression.
// ---------------------------------------------------------------------------

test("scheduler is currently serial: two independent slow nodes don't overlap", async () => {
  // Build two parallel branches off a common root. Each branch's plugin
  // records a timestamp at entry and exit. Serial execution means the
  // second branch's entry timestamp is >= the first branch's exit
  // timestamp. Concurrent execution would let them overlap.
  const events: Array<{ id: string; phase: "enter" | "exit"; t: number }> = [];
  const makeSlow = (id: string, delayMs: number): InProcessPlugin => ({
    manifest: { id, name: id, version: "1.0.0", category: "transformer", description: "" },
    async execute() {
      events.push({ id, phase: "enter", t: performance.now() });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      events.push({ id, phase: "exit", t: performance.now() });
      return { outputs: { ok: true } };
    }
  });
  const root = emitterPlugin("root", { go: 1 });
  const a = makeSlow("a", 40);
  const b = makeSlow("b", 40);
  const { executor, ctx } = await buildExecutor([root, a, b]);

  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "parallel-branches" },
    spec: {
      nodes: [
        { id: "r", plugin: { category: "transformer", id: "root", version: "1.0.0" } },
        { id: "a", plugin: { category: "transformer", id: "a", version: "1.0.0" } },
        { id: "b", plugin: { category: "transformer", id: "b", version: "1.0.0" } }
      ],
      edges: [
        { from: "r", to: "a" },
        { from: "r", to: "b" }
      ]
    }
  };

  await executor.execute({ spec, context: ctx, input: {} });
  // Both branches ran.
  assert.ok(events.some((e) => e.id === "a" && e.phase === "exit"));
  assert.ok(events.some((e) => e.id === "b" && e.phase === "exit"));
  // Serial property: the LATER branch entered AFTER the EARLIER exited.
  const aEnter = events.find((e) => e.id === "a" && e.phase === "enter")!.t;
  const aExit = events.find((e) => e.id === "a" && e.phase === "exit")!.t;
  const bEnter = events.find((e) => e.id === "b" && e.phase === "enter")!.t;
  const bExit = events.find((e) => e.id === "b" && e.phase === "exit")!.t;
  const overlap = !(aExit <= bEnter || bExit <= aEnter);
  assert.equal(
    overlap,
    false,
    "scheduler is serial today; branches do NOT overlap in wall-clock time. If this assertion fails because we added concurrent execution, flip it (and update the docstring)."
  );
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
