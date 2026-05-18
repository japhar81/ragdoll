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
