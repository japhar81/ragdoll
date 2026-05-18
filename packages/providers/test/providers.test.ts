import test from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider, OllamaCompatibleProvider, OpenAIProvider, ProviderRegistry } from "../src/index.ts";

test("provider registry selects required providers", () => {
  const registry = new ProviderRegistry();
  registry.register(new OpenAIProvider());
  registry.register(new AnthropicProvider());
  registry.register(new OllamaCompatibleProvider());
  assert.equal(registry.require("openai").displayName, "OpenAI");
  assert.equal(registry.require("anthropic").displayName, "Anthropic");
  assert.equal(registry.require("ollama").displayName, "Ollama-compatible");
});
