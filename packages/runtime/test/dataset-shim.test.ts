/**
 * Phase 5 acceptance — the v1 ↔ v2 plugin contract shim.
 *
 * v1 plugins (everything that exists today) read
 * `config.collection` / `config.index` directly. Phase 5 lets a
 * pipeline declare a `node.dataset = { slug, alias? }` reference and
 * the runtime splices the resolved backend collection names into the
 * config so the plugin keeps working unchanged. v2 plugins skip the
 * splice and read `input.dataset` directly.
 *
 * These tests pin both branches at the DagExecutor level (no DB
 * needed — the resolver is a tiny in-process mock).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applyDatasetShim, DagExecutor, InMemoryExecutionStore } from "../src/index.ts";
import {
  PluginRegistry,
  type DatasetResolver,
  type InProcessPlugin,
  type ResolvedDataset
} from "../../plugin-sdk/src/index.ts";

function fakeResolved(overrides: Partial<ResolvedDataset> = {}): ResolvedDataset {
  return {
    id: "ds-1",
    slug: "kb",
    scope: "environment",
    tenantId: "t-1",
    environmentId: "prod",
    modalities: ["vector"],
    embeddingProfile: {},
    chunkSchema: {},
    version: { id: "v-1", versionLabel: "v1", status: "ready" },
    backendCollections: { vector: "rag_kb_v1" },
    ...overrides
  };
}

// ---- pure helper ----------------------------------------------------------

test("applyDatasetShim leaves config alone when no dataset resolves", () => {
  const cfg = { collection: "preset" };
  assert.equal(applyDatasetShim(1, cfg, undefined), cfg);
});

test("applyDatasetShim splices vector + keyword into v1 config", () => {
  const resolved = fakeResolved({
    modalities: ["vector", "keyword"],
    backendCollections: { vector: "rag_kb_v1", keyword: "rag_kb_v1_bm25" }
  });
  const out = applyDatasetShim(1, {}, resolved);
  assert.equal(out.collection, "rag_kb_v1");
  assert.equal(out.index, "rag_kb_v1_bm25");
});

test("applyDatasetShim never overrides an explicit config.collection", () => {
  // Migration window: an existing pipeline that pins a collection name
  // must NOT be silently retargeted. The shim is opt-in per-node.
  const out = applyDatasetShim(1, { collection: "manual" }, fakeResolved());
  assert.equal(out.collection, "manual");
});

test("applyDatasetShim does NOT splice config for contract: 2", () => {
  // v2 plugins read input.dataset, not config.collection.
  const out = applyDatasetShim(2, {}, fakeResolved());
  assert.equal(out.collection, undefined);
});

// ---- end-to-end via DagExecutor -------------------------------------------

/**
 * The fake plugin records the inputs and config it was handed so each
 * test can assert exactly what the executor passed in. Reset by
 * re-instantiating before each test.
 */
function makeRecorderPlugin(contract: 1 | 2 = 1): {
  plugin: InProcessPlugin;
  seen: { config?: Record<string, unknown>; dataset?: ResolvedDataset };
} {
  const seen: { config?: Record<string, unknown>; dataset?: ResolvedDataset } = {};
  const plugin: InProcessPlugin = {
    manifest: {
      id: "recorder",
      name: "Recorder",
      version: "1.0.0",
      category: "sink",
      description: "Records what the executor passed in.",
      contract
    },
    async execute(input) {
      seen.config = input.config;
      seen.dataset = input.dataset;
      return { outputs: { ok: true } };
    }
  };
  return { plugin, seen };
}

function recordingResolver(resolved: ResolvedDataset | undefined): DatasetResolver {
  return {
    async resolve() {
      return resolved;
    }
  };
}

const SPEC = {
  apiVersion: "rag-platform/v1" as const,
  kind: "Pipeline" as const,
  metadata: { name: "test" },
  spec: {
    nodes: [
      { id: "in", type: "input" as const },
      {
        id: "rec",
        plugin: { category: "sink" as const, id: "recorder", version: "1.0.0" },
        dataset: { slug: "kb" }
      },
      { id: "out", type: "output" as const }
    ],
    edges: [
      { from: "in", to: "rec" },
      { from: "rec", to: "out" }
    ]
  }
};

const CONTEXT = {
  requestId: "r-1",
  executionId: "e-1",
  tenantId: "t-1",
  pipelineId: "p-1",
  pipelineVersionId: "pv-1",
  environment: "prod",
  resolvedConfig: { pipelineId: "p-1", tenantId: "t-1", environment: "prod", values: {}, violations: [] }
};

test("v1 plugin receives the resolved collection through config.collection (shim)", async () => {
  const { plugin, seen } = makeRecorderPlugin(1);
  const registry = new PluginRegistry();
  registry.register({ mode: "in_process", manifest: plugin.manifest, implementation: plugin });
  const executor = new DagExecutor({
    pluginRegistry: registry,
    secretProvider: { async list() { return []; }, async get() { return undefined; }, async put() { return {} as any; }, async delete() {} } as never,
    store: new InMemoryExecutionStore(),
    datasetResolver: recordingResolver(fakeResolved())
  });
  await executor.execute({ spec: SPEC, context: CONTEXT, input: {} });
  assert.equal(seen.config?.collection, "rag_kb_v1");
  assert.equal(seen.dataset, undefined); // v1 plugins do NOT get input.dataset
});

test("v2 plugin receives input.dataset and NOT config.collection", async () => {
  const { plugin, seen } = makeRecorderPlugin(2);
  const registry = new PluginRegistry();
  registry.register({ mode: "in_process", manifest: plugin.manifest, implementation: plugin });
  const executor = new DagExecutor({
    pluginRegistry: registry,
    secretProvider: { async list() { return []; }, async get() { return undefined; }, async put() { return {} as any; }, async delete() {} } as never,
    store: new InMemoryExecutionStore(),
    datasetResolver: recordingResolver(fakeResolved())
  });
  await executor.execute({ spec: SPEC, context: CONTEXT, input: {} });
  assert.equal(seen.config?.collection, undefined);
  assert.equal(seen.dataset?.slug, "kb");
  assert.equal(seen.dataset?.backendCollections.vector, "rag_kb_v1");
});

test("unresolved dataset falls through quietly without shim or dataset injection", async () => {
  // A pipeline that references a dataset slug that doesn't exist yet
  // should NOT crash the run — the plugin sees its original config and
  // can take whatever fallback path it already has. This is the safety
  // net during migration.
  const { plugin, seen } = makeRecorderPlugin(1);
  const registry = new PluginRegistry();
  registry.register({ mode: "in_process", manifest: plugin.manifest, implementation: plugin });
  const executor = new DagExecutor({
    pluginRegistry: registry,
    secretProvider: { async list() { return []; }, async get() { return undefined; }, async put() { return {} as any; }, async delete() {} } as never,
    store: new InMemoryExecutionStore(),
    datasetResolver: recordingResolver(undefined)
  });
  await executor.execute({ spec: SPEC, context: CONTEXT, input: {} });
  assert.equal(seen.config?.collection, undefined);
  assert.equal(seen.dataset, undefined);
});
