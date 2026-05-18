import test from "node:test";
import assert from "node:assert/strict";
import {
  CancelledError,
  DagExecutor,
  DeadlineExceededError,
  InMemoryExecutionStore
} from "../src/index.ts";
import type { SpanHandle, Tracer } from "../../observability/src/index.ts";
import { PluginRegistry } from "../../plugin-sdk/src/index.ts";
import { DatabaseEncryptedSecretProvider, InMemorySecretRepository, StaticKeyProvider } from "../../secrets/src/index.ts";
import { ConfigResolver } from "../../config-resolver/src/index.ts";
import type { PipelineSpec, RuntimeContext } from "../../core/src/index.ts";

interface RecordedSpan {
  name: string;
  attributes: Record<string, string | number | boolean | undefined>;
  exceptions: unknown[];
  ended: boolean;
}

class RecordingTracer implements Tracer {
  spans: RecordedSpan[] = [];

  startSpan(name: string, attributes: Record<string, string | number | boolean | undefined> = {}): SpanHandle {
    const recorded: RecordedSpan = { name, attributes: { ...attributes }, exceptions: [], ended: false };
    this.spans.push(recorded);
    return {
      setAttribute: (key, value) => {
        recorded.attributes[key] = value;
      },
      recordException: (error) => {
        recorded.exceptions.push(error);
      },
      end: () => {
        recorded.ended = true;
      }
    };
  }
}

function makeRegistry(behavior: "ok" | "throw" | "slow"): PluginRegistry {
  const registry = new PluginRegistry();
  const manifest = {
    id: "fake_chat",
    name: "Fake Chat",
    version: "1.0.0",
    category: "llm" as const,
    description: "test"
  };
  registry.register({
    mode: "in_process",
    manifest,
    implementation: {
      manifest,
      async execute({ config, secrets }) {
        if (behavior === "throw") throw new Error("plugin boom");
        if (behavior === "slow") await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          outputs: { provider: config.provider, keySuffix: secrets.apiKey.slice(-1) },
          usage: { provider: String(config.provider), model: String(config.model), inputTokens: 1, outputTokens: 2 }
        };
      }
    }
  });
  return registry;
}

const spec: PipelineSpec = {
  apiVersion: "rag-platform/v1",
  kind: "Pipeline",
  metadata: { name: "test-rag" },
  spec: {
    nodes: [
      { id: "input", type: "input" },
      {
        id: "llm",
        plugin: { category: "llm", id: "fake_chat", version: "1.0.0" },
        config: { provider: "${config.llm.provider}", model: "${config.llm.model}" },
        secrets: { apiKey: { scope: "tenant", tenantId: "tenant-a", key: "llm.api_key" } }
      },
      { id: "output", type: "output" }
    ],
    edges: [{ from: "input", to: "llm" }, { from: "llm", to: "output" }]
  }
};

async function buildSecretProvider(): Promise<DatabaseEncryptedSecretProvider> {
  const provider = new DatabaseEncryptedSecretProvider(new InMemorySecretRepository(), new StaticKeyProvider("dev-secret"));
  await provider.put({ scope: "tenant", tenantId: "tenant-a", key: "llm.api_key" }, "sk-a");
  return provider;
}

function makeContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  const resolver = new ConfigResolver([
    { key: "llm.provider", type: "string", defaultValue: "openai", allowedScopes: ["tenant"], tenantOverridable: true, runtimeOverridable: false },
    { key: "llm.model", type: "string", defaultValue: "gpt-4o-mini", allowedScopes: ["tenant"], tenantOverridable: true, runtimeOverridable: false }
  ]);
  const resolvedConfig = resolver.resolve({
    pipelineId: "pipe",
    pipelineVersionId: "v1",
    tenantId: "tenant-a",
    environment: "prod",
    values: [{ key: "llm.provider", value: "openai", scope: "tenant", scopeId: "tenant-a" }]
  });
  return {
    requestId: "r1",
    executionId: "e1",
    tenantId: "tenant-a",
    pipelineId: "pipe",
    pipelineVersionId: "v1",
    environment: "prod",
    resolvedConfig,
    ...overrides
  };
}

test("recording tracer captures execute span, node spans, and an exception on failure", async () => {
  const tracer = new RecordingTracer();
  const store = new InMemoryExecutionStore();
  const executor = new DagExecutor({
    pluginRegistry: makeRegistry("throw"),
    secretProvider: await buildSecretProvider(),
    store,
    maxRetries: 0,
    tracer
  });

  await assert.rejects(
    executor.execute({ spec, context: makeContext(), input: { question: "hi" } }),
    /plugin boom/
  );

  const executeSpans = tracer.spans.filter((s) => s.name === "pipeline.execute");
  const nodeSpans = tracer.spans.filter((s) => s.name.startsWith("node."));
  assert.equal(executeSpans.length, 1);
  assert.equal(executeSpans[0].attributes["tenant.id"], "tenant-a");
  assert.equal(executeSpans[0].attributes["pipeline.id"], "pipe");
  // input -> llm (fails here); output is never reached.
  assert.deepEqual(nodeSpans.map((s) => s.name).sort(), ["node.input", "node.llm"]);
  assert.ok(tracer.spans.every((s) => s.ended), "all spans must be ended");

  const failedSpan = tracer.spans.find((s) => s.name === "node.llm")!;
  assert.equal(failedSpan.exceptions.length, 1);
  assert.equal(failedSpan.attributes.error, true);
  const executeException = tracer.spans.find((s) => s.name === "pipeline.execute")!;
  assert.equal(executeException.exceptions.length, 1);

  const execution = store.executions.find((e) => e.executionId === "e1")!;
  assert.equal(execution.status, "failed");
});

test("a context.deadline in the past yields a cancelled execution and DeadlineExceededError", async () => {
  const store = new InMemoryExecutionStore();
  const executor = new DagExecutor({
    pluginRegistry: makeRegistry("ok"),
    secretProvider: await buildSecretProvider(),
    store
  });

  const context = makeContext({ deadline: new Date(Date.now() - 1000) });
  await assert.rejects(
    executor.execute({ spec, context, input: { question: "hi" } }),
    (error: unknown) => error instanceof DeadlineExceededError
  );

  const execution = store.executions.find((e) => e.executionId === "e1")!;
  assert.equal(execution.status, "cancelled");
  assert.ok(execution.completedAt);
  assert.match(execution.error ?? "", /deadline exceeded/i);
});

test("an AbortController aborted before a slow node yields cancelled + CancelledError", async () => {
  const store = new InMemoryExecutionStore();
  const executor = new DagExecutor({
    pluginRegistry: makeRegistry("slow"),
    secretProvider: await buildSecretProvider(),
    store
  });

  const controller = new AbortController();
  controller.abort(new Error("client went away"));
  const context = makeContext({ signal: controller.signal });

  await assert.rejects(
    executor.execute({ spec, context, input: { question: "hi" } }),
    (error: unknown) => error instanceof CancelledError
  );

  const execution = store.executions.find((e) => e.executionId === "e1")!;
  assert.equal(execution.status, "cancelled");
  assert.ok(execution.completedAt);
});

test("an AbortController aborted while a slow node runs yields cancelled + CancelledError", async () => {
  const store = new InMemoryExecutionStore();
  const executor = new DagExecutor({
    pluginRegistry: makeRegistry("slow"),
    secretProvider: await buildSecretProvider(),
    store,
    maxRetries: 2
  });

  const controller = new AbortController();
  const context = makeContext({ signal: controller.signal });
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(
    executor.execute({ spec, context, input: { question: "hi" } }),
    (error: unknown) => error instanceof CancelledError
  );

  const execution = store.executions.find((e) => e.executionId === "e1")!;
  assert.equal(execution.status, "cancelled");
});

test("happy path records succeeded execution and usage", async () => {
  const tracer = new RecordingTracer();
  const store = new InMemoryExecutionStore();
  const executor = new DagExecutor({
    pluginRegistry: makeRegistry("ok"),
    secretProvider: await buildSecretProvider(),
    store,
    tracer
  });

  const output = await executor.execute({ spec, context: makeContext(), input: { question: "hi" } });

  assert.deepEqual(output, { provider: "openai", keySuffix: "a" });
  const execution = store.executions.find((e) => e.executionId === "e1")!;
  assert.equal(execution.status, "succeeded");
  assert.equal(store.usage.length, 1);
  assert.equal(store.usage[0].success, true);
  assert.equal(tracer.spans.filter((s) => s.name === "pipeline.execute").length, 1);
  assert.equal(tracer.spans.filter((s) => s.name.startsWith("node.")).length, 3);
  assert.ok(tracer.spans.every((s) => s.ended));
});
