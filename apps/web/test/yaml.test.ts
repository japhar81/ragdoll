import test from "node:test";
import assert from "node:assert/strict";
import { stringifyYaml } from "../src/lib/yaml.ts";
import { parseYaml } from "../../../packages/pipeline-spec/src/yaml.ts";
import type { PipelineSpec } from "../src/lib/types.ts";

const SPEC: PipelineSpec = {
  apiVersion: "rag-platform/v1",
  kind: "Pipeline",
  metadata: { name: "support-rag", labels: { domain: "support" } },
  spec: {
    nodes: [
      { id: "input", type: "input" },
      {
        id: "llm",
        plugin: { category: "llm", id: "provider_chat", version: "1.0.0" },
        config: { provider: "${config.llm.provider}", temperature: 0.2 },
        secrets: { apiKey: { scope: "tenant", key: "llm.api_key" } }
      },
      { id: "output", type: "output" }
    ],
    edges: [
      { from: "input", to: "llm" },
      { from: "llm", to: "output" }
    ]
  }
};

test("exported YAML round-trips through the server's parser", () => {
  const text = stringifyYaml(SPEC);
  const parsed = parseYaml(text) as PipelineSpec;
  assert.equal(parsed.apiVersion, "rag-platform/v1");
  assert.equal(parsed.kind, "Pipeline");
  assert.equal(parsed.metadata.name, "support-rag");
  assert.deepEqual(parsed.metadata.labels, { domain: "support" });
  assert.equal(parsed.spec.nodes.length, 3);
  assert.equal(parsed.spec.edges.length, 2);

  const llm = parsed.spec.nodes.find((n) => n.id === "llm");
  assert.deepEqual(llm?.plugin, {
    category: "llm",
    id: "provider_chat",
    version: "1.0.0"
  });
  // The version "1.0.0" must survive as a string, not be coerced.
  assert.equal(typeof llm?.plugin?.version, "string");
  assert.equal(llm?.config?.temperature, 0.2);
  assert.equal(llm?.config?.provider, "${config.llm.provider}");
  assert.deepEqual(llm?.secrets, { apiKey: { scope: "tenant", key: "llm.api_key" } });
});

test("stringifyYaml emits empty collections explicitly", () => {
  const text = stringifyYaml({ a: {}, b: [], c: "x" });
  assert.match(text, /a: \{\}/);
  assert.match(text, /b: \[\]/);
  const parsed = parseYaml(text) as Record<string, unknown>;
  assert.deepEqual(parsed, { a: {}, b: [], c: "x" });
});

test("stringifyYaml quotes ambiguous scalars so they round-trip", () => {
  const value = { num: "0123", bool: "true", colon: "a: b", tmpl: "${config.x}" };
  const parsed = parseYaml(stringifyYaml(value)) as Record<string, unknown>;
  assert.deepEqual(parsed, value);
});
