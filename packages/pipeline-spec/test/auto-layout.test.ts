import test from "node:test";
import assert from "node:assert/strict";
import { autoLayoutSpec } from "../src/index.ts";

const baseSpec = {
  apiVersion: "rag-platform/v1" as const,
  kind: "Pipeline" as const,
  metadata: { name: "demo" },
  spec: { nodes: [], edges: [] }
};

test("a spec where every node already has a position is returned unchanged", () => {
  const spec = {
    ...baseSpec,
    spec: {
      nodes: [
        { id: "a", ui: { position: { x: 1, y: 2 } } },
        { id: "b", ui: { position: { x: 3, y: 4 } } }
      ],
      edges: [{ from: "a", to: "b" }]
    }
  };
  const out = autoLayoutSpec(spec);
  assert.strictEqual(out, spec, "expected no-op (reference equal)");
});

test("a positionless spec gets a left-to-right layered layout", () => {
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
  const out = autoLayoutSpec(spec);
  const positions = out.spec.nodes.map((n) => (n.ui as { position: { x: number; y: number } }).position);
  assert.equal(positions.length, 3);
  for (const p of positions) {
    assert.equal(typeof p.x, "number");
    assert.equal(typeof p.y, "number");
  }
  // Layered LR: downstream nodes sit at greater x than their upstream.
  const xByNode = new Map(out.spec.nodes.map((n, i) => [n.id, positions[i].x]));
  assert.ok(xByNode.get("b")! > xByNode.get("a")!, "b should be right of a");
  assert.ok(xByNode.get("c")! > xByNode.get("b")!, "c should be right of b");
});

test("a partial spec preserves existing positions and fills in the gaps", () => {
  const spec = {
    ...baseSpec,
    spec: {
      nodes: [
        { id: "a", ui: { position: { x: 999, y: 999 } } },
        { id: "b" }
      ],
      edges: [{ from: "a", to: "b" }]
    }
  };
  const out = autoLayoutSpec(spec);
  const a = out.spec.nodes.find((n) => n.id === "a")!;
  const b = out.spec.nodes.find((n) => n.id === "b")!;
  assert.deepEqual((a.ui as { position: unknown }).position, { x: 999, y: 999 });
  const bPos = (b.ui as { position: { x: number; y: number } }).position;
  assert.equal(typeof bPos.x, "number");
  assert.equal(typeof bPos.y, "number");
});

test("empty spec is returned untouched", () => {
  const out = autoLayoutSpec(baseSpec);
  assert.strictEqual(out, baseSpec);
});
