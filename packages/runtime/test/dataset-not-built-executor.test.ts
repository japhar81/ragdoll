/**
 * End-to-end guard: when a node references a dataset that EXISTS but was never
 * cut into a version, the executor must fail the run with the accurate
 * "no published version" message — NOT swallow the DatasetNotBuiltError into an
 * unresolved dataset that a downstream sink then mislabels as a missing binding.
 *
 * Every OTHER resolution failure keeps the pre-Phase-5 tolerance (dataset left
 * unresolved, run proceeds so config-as-source still works) — covered by the
 * second test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DagExecutor,
  InMemoryExecutionStore,
  DatasetNotBuiltError
} from "../src/index.ts";
import { PluginRegistry } from "../../plugin-sdk/src/index.ts";
import {
  DatabaseEncryptedSecretProvider,
  InMemorySecretRepository,
  StaticKeyProvider
} from "../../secrets/src/index.ts";
import type { PipelineSpec } from "../../core/src/index.ts";

function registry(ran: { count: number }): PluginRegistry {
  const reg = new PluginRegistry();
  const manifest = {
    id: "sink",
    name: "Sink",
    version: "1.0.0" as const,
    category: "tool" as const,
    contract: 2 as const,
    description: "records that it ran"
  };
  reg.register({
    mode: "in_process",
    manifest,
    implementation: {
      manifest,
      async execute() {
        ran.count += 1;
        return { outputs: { ok: true } };
      }
    }
  });
  return reg;
}

function secrets() {
  return new DatabaseEncryptedSecretProvider(
    new InMemorySecretRepository(),
    new StaticKeyProvider("dev-secret")
  );
}

function specWithDatasetNode(slug: string): PipelineSpec {
  return {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "sink-pipe" },
    spec: {
      nodes: [
        { id: "in", type: "input" },
        {
          id: "write",
          plugin: { category: "tool", id: "sink", version: "1.0.0" },
          dataset: { slug }
        },
        { id: "out", type: "output" }
      ],
      edges: [
        { from: "in", to: "write" },
        { from: "write", to: "out" }
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
  resolvedConfig: {
    pipelineId: "p1",
    pipelineVersionId: "v1",
    tenantId: "t1",
    environment: "dev",
    values: {},
    violations: []
  }
};

test("executor FAILS the run with the accurate 'no published version' error for an unbuilt dataset", async () => {
  const ran = { count: 0 };
  const executor = new DagExecutor({
    pluginRegistry: registry(ran),
    secretProvider: secrets(),
    store: new InMemoryExecutionStore(),
    datasetResolver: {
      async resolve() {
        // The real buildDatasetResolver throws this when the dataset row
        // exists but has no version. Simulate it here.
        throw new DatasetNotBuiltError("unbuilt-ds");
      }
    }
  });
  await assert.rejects(
    () =>
      executor.execute({
        spec: specWithDatasetNode("unbuilt-ds"),
        context: { ...context },
        input: {}
      }),
    (err: unknown) => {
      assert.match((err as Error).message, /no published version/);
      // Crucially NOT the misleading "missing binding" text.
      assert.doesNotMatch((err as Error).message, /requires a .* binding/);
      return true;
    }
  );
  assert.equal(ran.count, 0, "the sink must not run when the dataset is unbuilt");
});

test("executor TOLERATES other resolution failures (dataset left unresolved, run proceeds)", async () => {
  const ran = { count: 0 };
  const executor = new DagExecutor({
    pluginRegistry: registry(ran),
    secretProvider: secrets(),
    store: new InMemoryExecutionStore(),
    datasetResolver: {
      async resolve() {
        // A generic failure (e.g. a transient repo error) is NOT a
        // DatasetNotBuiltError — the executor keeps the pre-Phase-5 tolerance.
        throw new Error("transient repo blip");
      }
    }
  });
  await executor.execute({
    spec: specWithDatasetNode("some-ds"),
    context: { ...context },
    input: {}
  });
  assert.equal(ran.count, 1, "the run proceeds with the dataset unresolved");
});
