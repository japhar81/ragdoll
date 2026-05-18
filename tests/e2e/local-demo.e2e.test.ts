/**
 * Offline proof that examples/pipelines/local-demo.yaml is valid AND runnable
 * WITHOUT docker / a live Ollama. It:
 *
 *   1. loads the YAML via the pipeline-spec loader,
 *   2. validates it against the REAL builtin plugin registry
 *      (`loadPluginRegistry()`), proving the seeded spec references only
 *      registered plugins,
 *   3. executes it through the runtime `DagExecutor` with a deterministic
 *      in-process fake substituted for the real `provider_chat` plugin (the
 *      real one would open a socket to Ollama), feeding the SAME resolved
 *      config the local-demo seed produces (provider=ollama,
 *      model=qwen2.5:0.5b, base_url=http://ollama:11434),
 *   4. asserts the run completes and the output carries model text.
 *
 * Fully offline / install-free: node:test + --experimental-strip-types. No
 * network, no pg, no docker.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadPipelineSpec, validatePipelineSpec } from "../../packages/pipeline-spec/src/index.ts";
import { loadPluginRegistry } from "../../packages/plugin-loader/src/index.ts";
import { DagExecutor, InMemoryExecutionStore } from "../../packages/runtime/src/index.ts";
import { ConfigResolver } from "../../packages/config-resolver/src/index.ts";
import {
  DatabaseEncryptedSecretProvider,
  InMemorySecretRepository,
  StaticKeyProvider
} from "../../packages/secrets/src/index.ts";
import type { InProcessPlugin } from "../../packages/plugin-sdk/src/index.ts";
import type { ConfigDefinition, ConfigValue, RuntimeContext } from "../../packages/core/src/index.ts";

const DEMO_YAML = fileURLToPath(
  new URL("../../examples/pipelines/local-demo.yaml", import.meta.url)
);

/**
 * Deterministic stand-in for builtin `provider_chat`. Same plugin key
 * (llm:provider_chat:1.0.0) so the DagExecutor resolves it instead of the
 * real adapter that would hit Ollama. Echoes the resolved provider/model so
 * the assertions prove config flowed through.
 */
const fakeProviderChat: InProcessPlugin = {
  manifest: {
    id: "provider_chat",
    name: "Provider Chat (offline fake)",
    version: "1.0.0",
    category: "llm",
    description: "Deterministic offline replacement for the demo test."
  },
  async execute({ inputs, config }) {
    const messages =
      ((inputs.prompt as { messages?: unknown[] } | undefined)?.messages ??
        []) as Array<{ role: string; content: string }>;
    const userTurn = messages.find((m) => m.role === "user")?.content ?? "";
    return {
      outputs: {
        text: `offline-answer for: ${userTurn}`,
        provider: String(config.provider),
        model: String(config.model)
      },
      usage: {
        provider: String(config.provider),
        model: String(config.model),
        inputTokens: 5,
        outputTokens: 9
      }
    };
  }
};

/** The config the local-demo seed resolves for tenant-local / dev. */
function demoResolvedConfig(): RuntimeContext["resolvedConfig"] {
  const definitions: ConfigDefinition[] = [
    {
      key: "llm.provider",
      type: "string",
      defaultValue: "openai",
      allowedScopes: ["global", "tenant", "runtime"],
      required: false,
      secret: false,
      sensitive: false,
      overridable: true,
      inherited: true,
      nullable: false,
      tenantOverridable: true,
      runtimeOverridable: true
    },
    {
      key: "llm.model",
      type: "string",
      defaultValue: "gpt-4o-mini",
      allowedScopes: ["global", "tenant", "runtime"],
      required: false,
      secret: false,
      sensitive: false,
      overridable: true,
      inherited: true,
      nullable: false,
      tenantOverridable: true,
      runtimeOverridable: true
    },
    {
      key: "llm.base_url",
      type: "string",
      defaultValue: undefined,
      allowedScopes: ["tenant", "tenant_pipeline"],
      required: false,
      secret: false,
      sensitive: false,
      overridable: true,
      inherited: true,
      nullable: true,
      tenantOverridable: true,
      runtimeOverridable: false
    }
  ];
  const values: ConfigValue[] = [
    { key: "llm.provider", value: "ollama", scope: "tenant", scopeId: "tenant-local" },
    { key: "llm.model", value: "qwen2.5:0.5b", scope: "tenant", scopeId: "tenant-local" },
    { key: "llm.base_url", value: "http://ollama:11434", scope: "tenant", scopeId: "tenant-local" }
  ];
  return new ConfigResolver(definitions).resolve(
    {
      pipelineId: "local-demo",
      tenantId: "tenant-local",
      environment: "dev",
      values
    },
    { redactSecrets: false }
  );
}

test("local-demo.yaml is valid against the real builtin plugin registry", async () => {
  const spec = loadPipelineSpec(await readFile(DEMO_YAML, "utf8"));
  const result = validatePipelineSpec(spec, loadPluginRegistry());
  assert.equal(
    result.valid,
    true,
    `expected valid; errors: ${JSON.stringify(result.errors)}`
  );
  assert.equal(result.missingPlugins.length, 0);
  assert.deepEqual(result.requiredConfig.sort(), [
    "llm.base_url",
    "llm.model",
    "llm.provider"
  ]);
});

test("local-demo pipeline runs offline through DagExecutor and returns text", async () => {
  const spec = loadPipelineSpec(await readFile(DEMO_YAML, "utf8"));

  // Real builtin registry (basic_rag_prompt etc.), with provider_chat swapped
  // for the offline fake so no socket is opened to Ollama.
  const registry = loadPluginRegistry();
  registry.register({
    mode: "in_process",
    manifest: fakeProviderChat.manifest,
    implementation: fakeProviderChat
  });

  const resolved = demoResolvedConfig();
  assert.equal(resolved.values["llm.provider"].value, "ollama");
  assert.equal(resolved.values["llm.model"].value, "qwen2.5:0.5b");
  assert.equal(resolved.values["llm.base_url"].value, "http://ollama:11434");

  const store = new InMemoryExecutionStore();
  const executor = new DagExecutor({
    pluginRegistry: registry,
    secretProvider: new DatabaseEncryptedSecretProvider(
      new InMemorySecretRepository(),
      new StaticKeyProvider("demo-key")
    ),
    store,
    maxRetries: 0
  });

  const context: RuntimeContext = {
    requestId: "req-demo",
    executionId: "exec-demo",
    tenantId: "tenant-local",
    pipelineId: "local-demo",
    pipelineVersionId: "1.0.0",
    environment: "dev",
    resolvedConfig: resolved
  };

  const output = await executor.execute({
    spec,
    context,
    input: { question: "What is RAGdoll?" }
  });

  // The output node forwards its source (llm) node's outputs verbatim.
  const llm = output as { text?: string; provider?: string; model?: string };
  assert.equal(typeof llm.text, "string", "model text returned");
  assert.ok(
    llm.text!.includes("What is RAGdoll?"),
    "model text reflects the question routed through basic_rag_prompt"
  );
  assert.equal(llm.provider, "ollama");
  assert.equal(llm.model, "qwen2.5:0.5b");

  const exec = store.executions.find((e) => e.executionId === "exec-demo");
  assert.equal(exec?.status, "succeeded");
});
