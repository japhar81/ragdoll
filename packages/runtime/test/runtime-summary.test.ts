/**
 * Tests for the per-run summary embedded in `__ragdollSummary__` on the
 * execution output bag. The key UX claim: when a pipeline "succeeded" but
 * every downstream node skipped (root produced empty, no real work done),
 * the output carries a summary flagging it so the UI / API / operators
 * can stop reading green as "everything worked".
 *
 * Mirrors what bit us on OpenShift: the codebase-ingest demos kicked off,
 * `fs` walked `/workspace`, found zero files, downstream nodes all skipped,
 * and the run reported succeeded — the user (rightly) called that a lie.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DagExecutor, InMemoryExecutionStore } from "../src/index.ts";
import {
  PluginRegistry,
  type InProcessPlugin
} from "../../plugin-sdk/src/index.ts";
import {
  DatabaseEncryptedSecretProvider,
  InMemorySecretRepository,
  StaticKeyProvider
} from "../../secrets/src/index.ts";
import { ConfigResolver } from "../../config-resolver/src/index.ts";
import type { PipelineSpec, RuntimeContext } from "../../core/src/index.ts";

function emitter(id: string, outputs: Record<string, unknown>): InProcessPlugin {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      category: "transformer",
      description: "test"
    },
    async execute() {
      return { outputs };
    }
  };
}

function passthrough(id: string): InProcessPlugin {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      category: "transformer",
      description: "test"
    },
    async execute({ inputs }) {
      // Flag only `documents` so an empty-documents upstream produces dead
      // edges to downstreams wired by `fromPort: documents`.
      return { outputs: { documents: inputs.documents } };
    }
  };
}

async function build(plugins: InProcessPlugin[]): Promise<{
  executor: DagExecutor;
  store: InMemoryExecutionStore;
  ctx: RuntimeContext;
}> {
  const registry = new PluginRegistry();
  for (const p of plugins) {
    registry.register({ mode: "in_process", manifest: p.manifest, implementation: p });
  }
  const secrets = new DatabaseEncryptedSecretProvider(
    new InMemorySecretRepository(),
    new StaticKeyProvider("test-key")
  );
  const store = new InMemoryExecutionStore();
  const executor = new DagExecutor({ pluginRegistry: registry, secretProvider: secrets, store });
  const resolvedConfig = new ConfigResolver([]).resolve({
    pipelineId: "p",
    pipelineVersionId: "v",
    tenantId: "t",
    environment: "test",
    values: []
  });
  const ctx: RuntimeContext = {
    requestId: "r",
    executionId: "e",
    tenantId: "t",
    pipelineId: "p",
    pipelineVersionId: "v",
    environment: "test",
    resolvedConfig
  };
  return { executor, store, ctx };
}

test("summary: linear DAG with real work has nodesCompleted=N, noWorkDone=false", async () => {
  const { executor, ctx } = await build([emitter("src", { documents: [{ id: 1 }] }), passthrough("sink")]);
  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "ok" },
    spec: {
      nodes: [
        { id: "src", plugin: { category: "transformer", id: "src", version: "1.0.0" } },
        { id: "sink", plugin: { category: "transformer", id: "sink", version: "1.0.0" } }
      ],
      edges: [{ from: "src", to: "sink", fromPort: "documents", toPort: "documents" }]
    }
  };
  const out = await executor.execute({ spec, context: ctx, input: {} });
  const summary = (out as { __ragdollSummary__?: unknown }).__ragdollSummary__;
  // All nodes ran → no summary emitted (we only stamp it when there were skips).
  assert.equal(summary, undefined, "no skips → no summary stamp");
});

test("summary: source emits no documents port, downstream skips, summary flags noWorkDone", async () => {
  // The OpenShift demo failure mode: a source produces no value on its
  // declared port (the runtime treats `undefined` on the source's
  // fromPort as a dead edge), so the downstream skips. Pipeline still
  // completes — that's the lie we're catching with the summary.
  // (The OpenShift case was `fs` emitting `documents: []` → `delta`
  // running and producing `{}` → `chunk` wired by `fromPort=new` finds
  // undefined → skip. Same shape, fewer hops here.)
  const { executor, ctx } = await build([emitter("src", { otherThing: true }), passthrough("sink")]);
  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "empty" },
    spec: {
      nodes: [
        { id: "src", plugin: { category: "transformer", id: "src", version: "1.0.0" } },
        { id: "sink", plugin: { category: "transformer", id: "sink", version: "1.0.0" } }
      ],
      // src never emits `documents` → sink's incoming edge dead → skip.
      edges: [{ from: "src", to: "sink", fromPort: "documents", toPort: "documents" }]
    }
  };
  // executor.execute returns the bag (which now includes __ragdollSummary__).
  // The terminal "output" pick logic flows through the live upstream, but
  // here there's no explicit output node, so the picker falls back to the
  // last *completed* node — that's `src` (sink skipped). The summary is
  // stamped on the enriched output the executor stores.
  await executor.execute({ spec, context: ctx, input: {} });
  // Read what the executor actually persisted, which is the canonical
  // surface (api/web read from the store, not the in-process return).
  const { store } = await build([]); // placeholder for typing
  void store;
  // The executor we built above shares its store closure — refetch:
  const stored = (executor as unknown as { options: { store: InMemoryExecutionStore } })
    .options.store;
  const exec = stored.executions.find((e) => e.executionId === "e");
  assert.ok(exec, "execution row written");
  const out = exec.output as { __ragdollSummary__?: { noWorkDone: boolean; reason?: string; nodesCompleted: number; nodesSkipped: number } };
  assert.ok(out.__ragdollSummary__, "summary present on persisted output");
  assert.equal(out.__ragdollSummary__.noWorkDone, true);
  assert.equal(out.__ragdollSummary__.reason, "all_downstream_skipped");
  assert.equal(out.__ragdollSummary__.nodesCompleted, 1, "only root completed");
  assert.equal(out.__ragdollSummary__.nodesSkipped, 1, "sink skipped");
});

test("summary: mixed run (one downstream worked, one skipped) does NOT flag noWorkDone", async () => {
  // The downstream `live` got data through a portless edge; the downstream
  // `dead` was wired to a fromPort the source didn't emit. `dead` skips.
  // Real work was done → noWorkDone must be false even though nodesSkipped > 0.
  const { executor, ctx } = await build([
    emitter("src", { documents: [{ id: 1 }] }),
    passthrough("live"),
    passthrough("dead")
  ]);
  const spec: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "mixed" },
    spec: {
      nodes: [
        { id: "src", plugin: { category: "transformer", id: "src", version: "1.0.0" } },
        { id: "live", plugin: { category: "transformer", id: "live", version: "1.0.0" } },
        { id: "dead", plugin: { category: "transformer", id: "dead", version: "1.0.0" } }
      ],
      edges: [
        { from: "src", to: "live", fromPort: "documents", toPort: "documents" },
        // src never emits `missing` → this edge is dead → `dead` skips.
        { from: "src", to: "dead", fromPort: "missing", toPort: "documents" }
      ]
    }
  };
  await executor.execute({ spec, context: ctx, input: {} });
  const stored = (executor as unknown as { options: { store: InMemoryExecutionStore } })
    .options.store;
  const exec = stored.executions.find((e) => e.executionId === "e");
  assert.ok(exec, "execution row written");
  const out = exec.output as { __ragdollSummary__?: { noWorkDone: boolean; nodesCompleted: number; nodesSkipped: number } };
  assert.ok(out.__ragdollSummary__, "summary stamped because there were skips");
  assert.equal(out.__ragdollSummary__.noWorkDone, false, "real work was done");
  assert.equal(out.__ragdollSummary__.nodesCompleted, 2);
  assert.equal(out.__ragdollSummary__.nodesSkipped, 1);
});
