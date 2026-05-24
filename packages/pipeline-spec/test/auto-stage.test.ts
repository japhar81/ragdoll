import test from "node:test";
import assert from "node:assert/strict";
import { autoStageSpec } from "../src/index.ts";

const baseSpec = {
  apiVersion: "rag-platform/v1" as const,
  kind: "Pipeline" as const,
  metadata: { name: "demo" },
  spec: { nodes: [], edges: [] }
};

test("a spec that already has stages is returned unchanged", () => {
  const spec = {
    ...baseSpec,
    metadata: {
      ...baseSpec.metadata,
      stages: [{ id: "custom", label: "Custom" }]
    },
    spec: {
      nodes: [{ id: "a", ui: { stageId: "custom" } }],
      edges: []
    }
  };
  const out = autoStageSpec(spec);
  assert.strictEqual(out, spec);
});

test("a positionless DAG gets one stage per topological layer", () => {
  const spec = {
    ...baseSpec,
    spec: {
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" }
      ]
    }
  };
  const out = autoStageSpec(spec);
  const stages = (out.metadata as { stages: Array<{ id: string; label: string }> })
    .stages;
  assert.equal(stages.length, 3);
  assert.deepEqual(
    stages.map((s) => s.label),
    ["Stage 1", "Stage 2", "Stage 3"]
  );
  const ids = out.spec.nodes.map((n) =>
    (n.ui as { stageId?: string } | undefined)?.stageId
  );
  assert.equal(ids[0], stages[0].id);
  assert.equal(ids[1], stages[1].id);
  assert.equal(ids[2], stages[2].id);
});

test("parallel branches share stages so the two pipes line up", () => {
  const spec = {
    ...baseSpec,
    spec: {
      nodes: [
        { id: "src_code" },
        { id: "src_docs" },
        { id: "ch_code" },
        { id: "ch_docs" }
      ],
      edges: [
        { from: "src_code", to: "ch_code" },
        { from: "src_docs", to: "ch_docs" }
      ]
    }
  };
  const out = autoStageSpec(spec);
  const stages = (out.metadata as { stages: Array<{ id: string }> }).stages;
  assert.equal(stages.length, 2);
  const stageOf = new Map(
    out.spec.nodes.map((n) => [
      n.id,
      (n.ui as { stageId?: string } | undefined)?.stageId
    ])
  );
  assert.equal(stageOf.get("src_code"), stageOf.get("src_docs"));
  assert.equal(stageOf.get("ch_code"), stageOf.get("ch_docs"));
});

test("empty spec is returned untouched", () => {
  const out = autoStageSpec(baseSpec);
  assert.strictEqual(out, baseSpec);
});

test("stage ids are deterministic so the migration is idempotent", () => {
  const spec = {
    ...baseSpec,
    spec: {
      nodes: [{ id: "a" }, { id: "b" }],
      edges: [{ from: "a", to: "b" }]
    }
  };
  const out1 = autoStageSpec(spec);
  // Pretend the migration was applied once and a second pass arrives:
  // because metadata.stages is now non-empty, it's a no-op (handled
  // by an earlier test) — and the ids from the FIRST pass are
  // deterministic.
  const stagesOut1 = (out1.metadata as { stages: Array<{ id: string }> })
    .stages;
  assert.deepEqual(
    stagesOut1.map((s) => s.id),
    ["s_auto_1", "s_auto_2"]
  );
});
