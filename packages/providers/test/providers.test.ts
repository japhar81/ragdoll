import test from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicProvider,
  OllamaCompatibleProvider,
  OpenAIProvider,
  ProviderRegistry,
  zeroVectorOrFail
} from "../src/index.ts";

test("provider registry selects required providers", () => {
  const registry = new ProviderRegistry();
  registry.register(new OpenAIProvider());
  registry.register(new AnthropicProvider());
  registry.register(new OllamaCompatibleProvider());
  assert.equal(registry.require("openai").displayName, "OpenAI");
  assert.equal(registry.require("anthropic").displayName, "Anthropic");
  assert.equal(registry.require("ollama").displayName, "Ollama-compatible");
});

/**
 * Regression: when the FIRST chunk of an embedding call exceeds the
 * model's context length AND no previous batch in this invocation
 * established the dimension, the Ollama fallback used to push
 * `new Array(0).fill(0)` (an empty array) into the result. Empty arrays
 * serialised as `null` in OpenSearch knn_vector and exploded with
 * `mapper_parsing_exception`.
 *
 * `zeroVectorOrFail` is the pure helper that gates that push. Test it
 * directly — the Ollama provider's network surface uses a separately-
 * imported undici dispatcher that bypasses globalThis.fetch, so a
 * full provider-level test would need undici MockAgent plumbing for
 * what is essentially a one-line guard.
 */
test("zeroVectorOrFail returns a properly-sized zero vector when dim is known", () => {
  assert.deepEqual(zeroVectorOrFail(4), [0, 0, 0, 0]);
});

test("zeroVectorOrFail throws when called with an unknown dimension", () => {
  // Catches the "first text in first batch can't embed" case before the
  // empty array gets a chance to poison downstream OpenSearch indexing.
  assert.throws(() => zeroVectorOrFail(0), /vector dimension is unknown/);
});
