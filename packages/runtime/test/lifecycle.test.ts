/**
 * DagExecutor honors the ADR 0036 ExecutionLifecycleHooks (the pre-lane):
 * execution.start can veto (→ denied) or rewrite input; execution.finish can
 * force-fail (→ failed) or rewrite the output. Complements the worker adapter
 * test (which covers the dispatcher→hook translation) by proving the runtime
 * actually APPLIES the hook outcome.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DagExecutor,
  InMemoryExecutionStore,
  type ExecutionLifecycleHooks
} from "../src/index.ts";
import { PluginRegistry, type InProcessPlugin } from "../../plugin-sdk/src/index.ts";
import {
  DatabaseEncryptedSecretProvider,
  InMemorySecretRepository,
  StaticKeyProvider
} from "../../secrets/src/index.ts";
import { ConfigResolver } from "../../config-resolver/src/index.ts";
import type { PipelineSpec, RuntimeContext } from "../../core/src/index.ts";

const echo: InProcessPlugin = {
  manifest: { id: "echo", name: "echo", version: "1.0.0", category: "transformer", description: "t" },
  async execute({ inputs }) {
    return { outputs: { value: inputs.value ?? "default" } };
  }
};

const SPEC: PipelineSpec = {
  apiVersion: "rag-platform/v1",
  kind: "Pipeline",
  metadata: { name: "lc" },
  spec: {
    nodes: [{ id: "echo", plugin: { category: "transformer", id: "echo", version: "1.0.0" } }],
    edges: []
  }
};

function build(lifecycle?: ExecutionLifecycleHooks) {
  const registry = new PluginRegistry();
  registry.register({ mode: "in_process", manifest: echo.manifest, implementation: echo });
  const store = new InMemoryExecutionStore();
  const executor = new DagExecutor({
    pluginRegistry: registry,
    secretProvider: new DatabaseEncryptedSecretProvider(
      new InMemorySecretRepository(),
      new StaticKeyProvider("k")
    ),
    store,
    lifecycle
  });
  const ctx: RuntimeContext = {
    requestId: "r",
    executionId: "e1",
    tenantId: "t",
    pipelineId: "p",
    pipelineVersionId: "v",
    environment: "test",
    resolvedConfig: new ConfigResolver([]).resolve({
      pipelineId: "p",
      pipelineVersionId: "v",
      tenantId: "t",
      environment: "test",
      values: []
    })
  };
  return { executor, store, ctx };
}

function statusOf(store: InMemoryExecutionStore, id: string): string | undefined {
  return store.executions.find((e) => e.executionId === id)?.status;
}

test("no lifecycle hooks → runs normally (succeeded)", async () => {
  const { executor, store, ctx } = build();
  await executor.execute({ spec: SPEC, context: ctx, input: {} });
  assert.equal(statusOf(store, "e1"), "succeeded");
});

test("execution.start onStart deny → execution terminates 'denied', execute throws", async () => {
  const { executor, store, ctx } = build({
    async onStart() {
      return { deny: { reason: "policy" } };
    }
  });
  await assert.rejects(
    () => executor.execute({ spec: SPEC, context: ctx, input: {} }),
    /denied by platform plugin: policy/
  );
  assert.equal(statusOf(store, "e1"), "denied");
});

test("execution.finish onFinish fail → execution terminates 'failed', execute throws", async () => {
  const { executor, store, ctx } = build({
    async onFinish() {
      return { fail: { reason: "pii" } };
    }
  });
  await assert.rejects(
    () => executor.execute({ spec: SPEC, context: ctx, input: {} }),
    /force-failed by platform plugin: pii/
  );
  assert.equal(statusOf(store, "e1"), "failed");
});

test("execution.finish onFinish mutate → execute returns the rewritten output", async () => {
  const { executor, ctx } = build({
    async onFinish() {
      return { output: { value: "REWRITTEN" } };
    }
  });
  const out = await executor.execute({ spec: SPEC, context: ctx, input: {} });
  assert.deepEqual(out, { value: "REWRITTEN" });
});

test("execution.start onStart mutate input → the DAG runs on the rewritten input", async () => {
  const seen: unknown[] = [];
  const { executor, ctx } = build({
    async onStart({ input }) {
      seen.push(input);
      return { input: { value: "from-hook" } };
    }
  });
  const out = await executor.execute({ spec: SPEC, context: ctx, input: { value: "original" } });
  assert.deepEqual(seen, [{ value: "original" }]); // hook saw the original
  assert.deepEqual(out, { value: "from-hook" }); // echo ran on the mutated input
});
