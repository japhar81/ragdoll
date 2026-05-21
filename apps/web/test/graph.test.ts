import test from "node:test";
import assert from "node:assert/strict";
import {
  DND_MIME,
  clampInspectorWidth,
  clampPaletteWidth,
  nodeKind,
  nodeTheme,
  styleKeyFor,
  validateConnection,
  type NodeKind
} from "../src/lib/graph.ts";
import type { PipelineNode } from "../src/lib/types.ts";

const kinds = new Map<string, NodeKind>([
  ["input", "input"],
  ["a", "plugin"],
  ["b", "plugin"],
  ["c", "plugin"],
  ["output", "output"]
]);

test("DND_MIME is a stable custom mime", () => {
  assert.equal(DND_MIME, "application/ragdoll-node");
});

test("nodeKind maps pipeline node type", () => {
  assert.equal(nodeKind({ type: "input" }), "input");
  assert.equal(nodeKind({ type: "output" }), "output");
  assert.equal(nodeKind({}), "plugin");
});

test("styleKeyFor + nodeTheme are colored and icon-bearing", () => {
  const llm: PipelineNode = {
    id: "x",
    plugin: { category: "llm", id: "provider_chat", version: "1.0.0" }
  };
  assert.equal(styleKeyFor(llm), "llm");
  const t = nodeTheme(styleKeyFor(llm));
  assert.match(t.color, /^#[0-9a-f]{6}$/i);
  assert.ok(t.icon.length > 0);
  // io kinds resolve to their own theme
  assert.equal(styleKeyFor({ id: "i", type: "input" }), "input");
  assert.equal(nodeTheme("output").color, "#dc2626");
  // unknown key falls back, never throws
  assert.ok(nodeTheme("does_not_exist" as never).icon.length > 0);
});

test("validateConnection accepts a normal forward wire", () => {
  assert.equal(
    validateConnection({ source: "a", target: "b" }, kinds, []),
    true
  );
});

test("validateConnection rejects bad wires", () => {
  // missing endpoint
  assert.equal(validateConnection({ source: "a", target: null }, kinds, []), false);
  // self loop
  assert.equal(validateConnection({ source: "a", target: "a" }, kinds, []), false);
  // unknown node
  assert.equal(validateConnection({ source: "a", target: "zzz" }, kinds, []), false);
  // duplicate edge
  assert.equal(
    validateConnection({ source: "a", target: "b" }, kinds, [
      { source: "a", target: "b" }
    ]),
    false
  );
  // cannot wire into an input
  assert.equal(validateConnection({ source: "a", target: "input" }, kinds, []), false);
  // cannot wire out of an output
  assert.equal(validateConnection({ source: "output", target: "b" }, kinds, []), false);
});

test("validateConnection rejects a wire that would create a cycle", () => {
  const edges = [
    { source: "a", target: "b" },
    { source: "b", target: "c" }
  ];
  // c -> a would close a->b->c->a
  assert.equal(validateConnection({ source: "c", target: "a" }, kinds, edges), false);
  // a -> c is still fine (no cycle)
  assert.equal(validateConnection({ source: "a", target: "c" }, kinds, edges), true);
});

test("clampInspectorWidth keeps a sane range", () => {
  assert.equal(clampInspectorWidth(50, 1440), 280); // floor
  assert.equal(clampInspectorWidth(5000, 1440), 760); // ceiling
  assert.equal(clampInspectorWidth(400, 1440), 400); // passthrough
  // tiny viewport: max collapses toward the floor, never below it
  assert.equal(clampInspectorWidth(400, 500), 280);
});

test("clampPaletteWidth keeps a sane range", () => {
  assert.equal(clampPaletteWidth(50, 1440), 160); // floor
  assert.equal(clampPaletteWidth(5000, 1440), 480); // ceiling
  assert.equal(clampPaletteWidth(300, 1440), 300); // passthrough
  // tiny viewport: max collapses toward the floor, never below it
  assert.equal(clampPaletteWidth(300, 500), 160);
});
