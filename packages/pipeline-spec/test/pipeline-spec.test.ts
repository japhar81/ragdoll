import test from "node:test";
import assert from "node:assert/strict";
import { validatePipelineSpec } from "../src/index.ts";
import type { PipelineSpec } from "../../core/src/index.ts";

const validSpec: PipelineSpec = {
  apiVersion: "rag-platform/v1",
  kind: "Pipeline",
  metadata: { name: "support-rag" },
  spec: {
    nodes: [
      { id: "input", type: "input" },
      { id: "llm", plugin: { category: "llm", id: "provider_chat", version: "1.0.0" }, config: { model: "${config.llm.model}" } },
      { id: "output", type: "output" }
    ],
    edges: [
      { from: "input", to: "llm" },
      { from: "llm", to: "output" }
    ]
  }
};

test("validates acyclic pipeline and collects config refs", () => {
  const result = validatePipelineSpec(validSpec);
  assert.equal(result.valid, true);
  assert.deepEqual(result.requiredConfig, ["llm.model"]);
});

test("rejects missing node edges", () => {
  const result = validatePipelineSpec({
    ...validSpec,
    spec: { ...validSpec.spec, edges: [{ from: "input", to: "missing" }] }
  });
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, "missing_edge_target");
});

test("rejects cycles", () => {
  const result = validatePipelineSpec({
    ...validSpec,
    spec: { ...validSpec.spec, edges: [{ from: "input", to: "llm" }, { from: "llm", to: "input" }] }
  });
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.code === "cycle_detected"), true);
});
