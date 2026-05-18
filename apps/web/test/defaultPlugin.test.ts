import test from "node:test";
import assert from "node:assert/strict";
import { PLUGIN_CATEGORIES, defaultPluginRef } from "../src/lib/spec.ts";

/**
 * The set of plugin ids that are really registered by the plugin-loader
 * (builtin-rag + sample-text modules). Every palette category's default ref
 * MUST resolve to one of these so a freshly dropped node renders a
 * schema-driven form instead of the raw-JSON fallback.
 */
const KNOWN_REAL_IDS = new Set<string>([
  "manual_text_input",
  "text_document_loader",
  "text_parser",
  "basic_text_chunker",
  "provider_embeddings",
  "qdrant_vector_store",
  "qdrant_retriever",
  "score_reranker",
  "provider_chat",
  "basic_rag_prompt",
  "static_value_tool",
  "simple_keyword_guardrail",
  "simple_evaluator_stub",
  "json_output_parser",
  "sample_uppercase_transformer",
  "field_router",
  "buffer_memory",
  "vector_upsert"
]);

test("PLUGIN_CATEGORIES covers all 18 categories", () => {
  assert.equal(PLUGIN_CATEGORIES.length, 18);
  assert.equal(new Set(PLUGIN_CATEGORIES).size, 18);
});

test("every category resolves to a real registered plugin at v1.0.0", () => {
  for (const category of PLUGIN_CATEGORIES) {
    const ref = defaultPluginRef(category);
    assert.equal(ref.category, category, `${category} ref carries its own category`);
    assert.ok(
      KNOWN_REAL_IDS.has(ref.id),
      `${category} default id "${ref.id}" must be a known real plugin id`
    );
    assert.equal(ref.version, "1.0.0", `${category} default ref is v1.0.0`);
  }
});

test("default refs are unique enough to be addressable (no fallback synthetic ids)", () => {
  for (const category of PLUGIN_CATEGORIES) {
    const ref = defaultPluginRef(category);
    // The synthetic fallback "<category>_default" must never be hit now that
    // the map is complete.
    assert.notEqual(ref.id, `${category}_default`, `${category} must not hit the synthetic fallback`);
  }
});
