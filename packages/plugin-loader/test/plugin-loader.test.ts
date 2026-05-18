import test from "node:test";
import assert from "node:assert/strict";
import {
  loadPluginRegistry,
  loadProviderRegistry,
  loadRegistries,
  isInProcessPlugin
} from "../src/index.ts";

test("loadPluginRegistry registers known builtin plugins", () => {
  const registry = loadPluginRegistry();

  const providerChat = registry.get({ category: "llm", id: "provider_chat", version: "1.0.0" });
  assert.ok(providerChat, "provider_chat should be registered");
  assert.equal(providerChat?.mode, "in_process");
  assert.ok(providerChat?.implementation, "provider_chat should expose an implementation");

  const ragPrompt = registry.get({ category: "prompt_template", id: "basic_rag_prompt", version: "1.0.0" });
  assert.ok(ragPrompt, "basic_rag_prompt should be registered");

  // sample-text module plugin is also discovered generically.
  const sample = registry.get({ category: "transformer", id: "sample_uppercase_transformer", version: "1.0.0" });
  assert.ok(sample, "sample_uppercase_transformer should be registered");
});

test("loadPluginRegistry registers every in-process plugin export", () => {
  const registry = loadPluginRegistry();
  const llm = registry.list("llm");
  assert.ok(llm.length >= 1);
  // All registered entries are in-process with a manifest + implementation.
  for (const plugin of registry.list()) {
    assert.equal(plugin.mode, "in_process");
    assert.equal(typeof plugin.manifest.id, "string");
    assert.equal(typeof plugin.implementation?.execute, "function");
  }
});

test("loader tolerates non-plugin exports", () => {
  // Functions, classes and constants in the scanned modules must be skipped.
  assert.equal(isInProcessPlugin(undefined), false);
  assert.equal(isInProcessPlugin(null), false);
  assert.equal(isInProcessPlugin(42), false);
  assert.equal(isInProcessPlugin("string"), false);
  assert.equal(isInProcessPlugin(() => undefined), false);
  assert.equal(isInProcessPlugin({}), false);
  assert.equal(isInProcessPlugin({ manifest: {}, execute: () => undefined }), false);
  assert.equal(isInProcessPlugin({ manifest: { id: "x" } }), false);
  assert.equal(isInProcessPlugin({ manifest: { id: "x" }, execute: () => undefined }), true);
  // The registry built from real modules did not throw on helper exports.
  assert.doesNotThrow(() => loadPluginRegistry());
});

test("representative built-in manifests expose schema-driven config", () => {
  const registry = loadPluginRegistry();

  const chat = registry.get({ category: "llm", id: "provider_chat", version: "1.0.0" });
  assert.ok(chat, "provider_chat registered");
  const chatSchema = chat?.manifest.configSchema;
  assert.equal(chatSchema?.type, "object");
  assert.ok(
    chatSchema?.properties && Object.keys(chatSchema.properties).length > 0,
    "provider_chat configSchema has properties"
  );
  // provider is a real enum and temperature has a default.
  assert.deepEqual(chatSchema?.properties?.provider?.enum, ["openai", "anthropic", "ollama"]);
  assert.equal(chatSchema?.properties?.temperature?.default, 0.2);
  // secretsSchema marks apiKey as a secret reference.
  assert.equal(
    chat?.manifest.secretsSchema?.properties?.apiKey?.format,
    "secret-ref"
  );
  // formHints are present for nicer rendering.
  assert.ok(chat?.manifest.ui?.formHints?.temperature, "temperature formHint present");

  const chunker = registry.get({ category: "chunker", id: "basic_text_chunker", version: "1.0.0" });
  const chunkerSchema = chunker?.manifest.configSchema;
  assert.equal(chunkerSchema?.properties?.chunkSize?.default, 1000);
  assert.equal(chunkerSchema?.properties?.overlap?.default, 100);

  const sample = registry.get({
    category: "transformer",
    id: "sample_uppercase_transformer",
    version: "1.0.0"
  });
  assert.equal(sample?.manifest.configSchema?.properties?.field?.default, "text");

  // Every registered plugin now exposes a non-empty object configSchema.
  for (const plugin of registry.list()) {
    const schema = plugin.manifest.configSchema;
    assert.ok(schema, `${plugin.manifest.id} has a configSchema`);
    assert.equal(schema?.type, "object", `${plugin.manifest.id} configSchema is object`);
    assert.ok(
      schema?.properties !== undefined,
      `${plugin.manifest.id} configSchema declares properties`
    );
  }
});

const ALL_CATEGORIES = [
  "datasource",
  "loader",
  "parser",
  "chunker",
  "embedder",
  "vector_store",
  "retriever",
  "reranker",
  "llm",
  "prompt_template",
  "tool",
  "guardrail",
  "evaluator",
  "output_parser",
  "transformer",
  "router",
  "memory",
  "sink"
] as const;

test("loaded registry has at least one plugin for every category", () => {
  const registry = loadPluginRegistry();
  for (const category of ALL_CATEGORIES) {
    const plugins = registry.list(category as never);
    assert.ok(
      plugins.length >= 1,
      `category ${category} should have at least one registered plugin`
    );
  }
});

test("every registered manifest is form-renderable (configSchema + ui icon/group)", () => {
  const registry = loadPluginRegistry();
  for (const plugin of registry.list()) {
    const manifest = plugin.manifest;
    const schema = manifest.configSchema;
    assert.ok(schema && typeof schema === "object", `${manifest.id} has a configSchema object`);
    assert.equal(schema?.type, "object", `${manifest.id} configSchema is an object schema`);
    assert.ok(
      schema?.properties !== undefined && typeof schema.properties === "object",
      `${manifest.id} configSchema declares a properties object`
    );
    assert.ok(
      typeof manifest.ui?.icon === "string" && manifest.ui.icon.length > 0,
      `${manifest.id} declares ui.icon`
    );
    assert.ok(
      typeof manifest.ui?.paletteGroup === "string" && manifest.ui.paletteGroup.length > 0,
      `${manifest.id} declares ui.paletteGroup`
    );
    // Plugins that actually expose config properties must also have formHints
    // so the UI renders proper widgets instead of guessing.
    if (Object.keys(schema?.properties ?? {}).length > 0) {
      assert.ok(
        manifest.ui?.formHints && typeof manifest.ui.formHints === "object",
        `${manifest.id} has config properties so must declare ui.formHints`
      );
    }
  }
});

test("loadProviderRegistry has openai/anthropic/ollama", () => {
  const providers = loadProviderRegistry();
  assert.equal(providers.require("openai").id, "openai");
  assert.equal(providers.require("anthropic").id, "anthropic");
  assert.equal(providers.require("ollama").id, "ollama");
  assert.equal(providers.list().length, 3);
});

test("loadRegistries returns both registries", () => {
  const { plugins, providers } = loadRegistries();
  assert.ok(plugins.get({ category: "llm", id: "provider_chat", version: "1.0.0" }));
  assert.equal(providers.require("openai").id, "openai");
});
