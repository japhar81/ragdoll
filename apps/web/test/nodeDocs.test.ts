/**
 * Pure tests for the per-node docs helpers powering the Builder's Docs tab.
 * No DOM, no React — runs under `node --experimental-strip-types --test`
 * with an empty node_modules, matching the rest of the web test suite.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSampleConfig,
  requiredFields,
  summarizeSchema,
  type FieldSummary
} from "../src/lib/nodeDocs.ts";

// ---- summarizeSchema ----------------------------------------------------

test("summarizeSchema returns [] for a missing schema", () => {
  assert.deepEqual(summarizeSchema(undefined), []);
  assert.deepEqual(summarizeSchema({}), []);
});

test("summarizeSchema lists every property with type / default / description", () => {
  const out = summarizeSchema({
    type: "object",
    required: ["topK"],
    properties: {
      topK: {
        type: "integer",
        default: 5,
        description: "Number of nearest documents to return."
      },
      url: {
        type: "string",
        description: "Optional Qdrant URL."
      }
    }
  });
  assert.equal(out.length, 2);
  const byKey = Object.fromEntries(out.map((f) => [f.key, f])) as Record<
    string,
    FieldSummary
  >;
  assert.equal(byKey.topK.required, true);
  assert.equal(byKey.topK.type, "integer");
  assert.equal(byKey.topK.default, 5);
  assert.equal(byKey.topK.description, "Number of nearest documents to return.");
  assert.equal(byKey.url.required, false);
  assert.equal(byKey.url.default, undefined);
});

test("summarizeSchema sorts required-first then alphabetical", () => {
  const out = summarizeSchema({
    type: "object",
    required: ["url"],
    properties: {
      zeta: { type: "string" },
      alpha: { type: "string" },
      url: { type: "string" }
    }
  });
  assert.deepEqual(
    out.map((f) => f.key),
    ["url", "alpha", "zeta"]
  );
});

test("summarizeSchema treats enum as its own type and carries values", () => {
  const out = summarizeSchema({
    type: "object",
    properties: {
      provider: {
        type: "string",
        enum: ["openai", "anthropic", "ollama"],
        default: "ollama"
      }
    }
  });
  assert.equal(out[0].type, "enum");
  assert.deepEqual(out[0].enum, ["openai", "anthropic", "ollama"]);
  assert.equal(out[0].default, "ollama");
});

test("summarizeSchema describes typed arrays as array<elementType>", () => {
  const out = summarizeSchema({
    type: "object",
    properties: {
      keywords: { type: "array", items: { type: "string" }, default: [] },
      values: { type: "array" }
    }
  });
  const byKey = Object.fromEntries(out.map((f) => [f.key, f]));
  assert.equal(byKey.keywords.type, "array<string>");
  assert.equal(byKey.values.type, "array");
});

test("summarizeSchema carries the format hint (e.g. secret-ref) so the table can show it", () => {
  const out = summarizeSchema({
    type: "object",
    properties: {
      apiKey: {
        type: "string",
        format: "secret-ref",
        description: "Reference to the API key secret."
      }
    }
  });
  assert.equal(out[0].format, "secret-ref");
});

// ---- requiredFields -----------------------------------------------------

test("requiredFields returns a fresh array of the schema's required keys", () => {
  const required = ["url", "collection"];
  const out = requiredFields({ type: "object", properties: {}, required });
  assert.deepEqual(out, ["url", "collection"]);
  // mutation safety: callers can sort/filter without affecting the source
  out.push("mutated");
  assert.deepEqual(required, ["url", "collection"]);
});

test("requiredFields returns [] when no `required` is declared", () => {
  assert.deepEqual(requiredFields(undefined), []);
  assert.deepEqual(requiredFields({ type: "object", properties: {} }), []);
});

// ---- buildSampleConfig --------------------------------------------------

test("buildSampleConfig pulls each field's default into the sample object", () => {
  const sample = buildSampleConfig({
    type: "object",
    properties: {
      topK: { type: "integer", default: 5 },
      collection: { type: "string", default: "default" },
      url: { type: "string" } // no default — omitted
    }
  });
  assert.deepEqual(sample, { topK: 5, collection: "default" });
});

test("buildSampleConfig falls back to the first enum value when no default is set", () => {
  const sample = buildSampleConfig({
    type: "object",
    properties: {
      provider: { type: "string", enum: ["openai", "anthropic", "ollama"] }
    }
  });
  assert.deepEqual(sample, { provider: "openai" });
});

test("buildSampleConfig prefers an explicit default over the first enum value", () => {
  const sample = buildSampleConfig({
    type: "object",
    properties: {
      provider: {
        type: "string",
        enum: ["openai", "anthropic", "ollama"],
        default: "ollama"
      }
    }
  });
  assert.deepEqual(sample, { provider: "ollama" });
});

test("buildSampleConfig returns {} for a schema with no properties", () => {
  assert.deepEqual(buildSampleConfig(undefined), {});
  assert.deepEqual(buildSampleConfig({}), {});
  assert.deepEqual(buildSampleConfig({ properties: {} }), {});
});

test("buildSampleConfig output is JSON-serializable (the Docs tab pretty-prints it)", () => {
  const sample = buildSampleConfig({
    type: "object",
    properties: {
      blockedKeywords: { type: "array", items: { type: "string" }, default: [] },
      filter: { type: "object", default: { tenantId: "*" } }
    }
  });
  const round = JSON.parse(JSON.stringify(sample));
  assert.deepEqual(round, { blockedKeywords: [], filter: { tenantId: "*" } });
});
