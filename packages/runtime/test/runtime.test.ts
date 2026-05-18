import test from "node:test";
import assert from "node:assert/strict";
import { DagExecutor, InMemoryExecutionStore } from "../src/index.ts";
import { PluginRegistry } from "../../plugin-sdk/src/index.ts";
import { DatabaseEncryptedSecretProvider, InMemorySecretRepository, StaticKeyProvider } from "../../secrets/src/index.ts";
import { ConfigResolver } from "../../config-resolver/src/index.ts";
import type { PipelineSpec } from "../../core/src/index.ts";

test("same pipeline runs with different tenant provider configs and records usage", async () => {
  const registry = new PluginRegistry();
  registry.register({
    mode: "in_process",
    manifest: {
      id: "fake_chat",
      name: "Fake Chat",
      version: "1.0.0",
      category: "llm",
      description: "test"
    },
    implementation: {
      manifest: {
        id: "fake_chat",
        name: "Fake Chat",
        version: "1.0.0",
        category: "llm",
        description: "test"
      },
      async execute({ config, secrets }) {
        return {
          outputs: { provider: config.provider, keySuffix: secrets.apiKey.slice(-1) },
          usage: { provider: String(config.provider), model: String(config.model), inputTokens: 1, outputTokens: 2 }
        };
      }
    }
  });

  const secretProvider = new DatabaseEncryptedSecretProvider(new InMemorySecretRepository(), new StaticKeyProvider("dev-secret"));
  await secretProvider.put({ scope: "tenant", tenantId: "tenant-a", key: "llm.api_key" }, "sk-a");
  await secretProvider.put({ scope: "tenant", tenantId: "tenant-b", key: "llm.api_key" }, "sk-b");

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

  const definitions = [
    { key: "llm.provider", type: "string" as const, defaultValue: "openai", allowedScopes: ["tenant" as const], tenantOverridable: true, runtimeOverridable: false },
    { key: "llm.model", type: "string" as const, defaultValue: "gpt-4o-mini", allowedScopes: ["tenant" as const], tenantOverridable: true, runtimeOverridable: false }
  ];
  const store = new InMemoryExecutionStore();
  const executor = new DagExecutor({ pluginRegistry: registry, secretProvider, store });
  const resolver = new ConfigResolver(definitions);

  const tenantAConfig = resolver.resolve({ pipelineId: "pipe", pipelineVersionId: "v1", tenantId: "tenant-a", environment: "prod", values: [{ key: "llm.provider", value: "openai", scope: "tenant", scopeId: "tenant-a" }] });
  const tenantA = await executor.execute({
    spec,
    context: { requestId: "r1", executionId: "e1", tenantId: "tenant-a", pipelineId: "pipe", pipelineVersionId: "v1", environment: "prod", resolvedConfig: tenantAConfig },
    input: { question: "hi" }
  });

  const tenantBSpec = structuredClone(spec);
  tenantBSpec.spec.nodes[1].secrets = { apiKey: { scope: "tenant", tenantId: "tenant-b", key: "llm.api_key" } };
  const tenantBConfig = resolver.resolve({ pipelineId: "pipe", pipelineVersionId: "v1", tenantId: "tenant-b", environment: "prod", values: [{ key: "llm.provider", value: "anthropic", scope: "tenant", scopeId: "tenant-b" }] });
  const tenantB = await executor.execute({
    spec: tenantBSpec,
    context: { requestId: "r2", executionId: "e2", tenantId: "tenant-b", pipelineId: "pipe", pipelineVersionId: "v1", environment: "prod", resolvedConfig: tenantBConfig },
    input: { question: "hi" }
  });

  assert.deepEqual(tenantA, { provider: "openai", keySuffix: "a" });
  assert.deepEqual(tenantB, { provider: "anthropic", keySuffix: "b" });
  assert.equal(store.executions.length, 2);
  assert.equal(store.usage.length, 2);
});
