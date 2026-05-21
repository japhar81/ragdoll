import test from "node:test";
import assert from "node:assert/strict";
import { layeredLayout, forceLayout, applyLayout } from "../src/lib/layouts.ts";

// ---------------------------------------------------------------------------
// layeredLayout
// ---------------------------------------------------------------------------

test("layered TB: a linear chain stacks nodes top-to-bottom by rank", () => {
  const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const edges = [
    { from: "a", to: "b" },
    { from: "b", to: "c" }
  ];
  const positions = layeredLayout(nodes, edges, { direction: "TB" });
  const a = positions.get("a")!;
  const b = positions.get("b")!;
  const c = positions.get("c")!;
  assert.ok(a.y < b.y, `a (${a.y}) above b (${b.y})`);
  assert.ok(b.y < c.y, `b (${b.y}) above c (${c.y})`);
  // Same x within a tight band — the chain shouldn't wander horizontally.
  assert.ok(Math.abs(a.x - b.x) < 1 && Math.abs(b.x - c.x) < 1, "chain stays in one column");
});

test("layered LR: linear chain stretches left-to-right", () => {
  const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const edges = [
    { from: "a", to: "b" },
    { from: "b", to: "c" }
  ];
  const positions = layeredLayout(nodes, edges, { direction: "LR" });
  const a = positions.get("a")!;
  const b = positions.get("b")!;
  const c = positions.get("c")!;
  assert.ok(a.x < b.x && b.x < c.x, "x grows along the chain");
  assert.ok(Math.abs(a.y - b.y) < 1, "rows align vertically in LR");
});

test("layered: fan-out places siblings side-by-side at the same rank", () => {
  // root → { left, right }
  const positions = layeredLayout(
    [{ id: "root" }, { id: "left" }, { id: "right" }],
    [
      { from: "root", to: "left" },
      { from: "root", to: "right" }
    ],
    { direction: "TB" }
  );
  const root = positions.get("root")!;
  const left = positions.get("left")!;
  const right = positions.get("right")!;
  assert.equal(left.y, right.y, "siblings share a rank");
  assert.notEqual(left.x, right.x, "siblings get distinct x positions");
  assert.ok(root.y < left.y, "root is the rank above its children");
});

test("layered: cycles don't crash; nodes in the cycle still get positions", () => {
  // a → b → c → a (impossible in real RAGdoll specs, but layout shouldn't NaN out).
  const positions = layeredLayout(
    [{ id: "a" }, { id: "b" }, { id: "c" }],
    [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" }
    ]
  );
  for (const id of ["a", "b", "c"]) {
    const p = positions.get(id)!;
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${id} got finite coords`);
  }
});

test("layered: positions land in the positive quadrant regardless of direction", () => {
  for (const direction of ["TB", "BT", "LR", "RL"] as const) {
    const positions = layeredLayout(
      [{ id: "a" }, { id: "b" }],
      [{ from: "a", to: "b" }],
      { direction }
    );
    for (const [id, p] of positions) {
      assert.ok(p.x >= 0, `${direction}: ${id}.x ${p.x} >= 0`);
      assert.ok(p.y >= 0, `${direction}: ${id}.y ${p.y} >= 0`);
    }
  }
});

// ---------------------------------------------------------------------------
// forceLayout
// ---------------------------------------------------------------------------

test("force: identical input produces identical output (deterministic seed)", () => {
  const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const edges = [
    { from: "a", to: "b" },
    { from: "b", to: "c" }
  ];
  const first = forceLayout(nodes, edges);
  const second = forceLayout(nodes, edges);
  for (const id of ["a", "b", "c"]) {
    const p1 = first.get(id)!;
    const p2 = second.get(id)!;
    assert.equal(p1.x, p2.x);
    assert.equal(p1.y, p2.y);
  }
});

test("force: connected nodes end up closer than the canvas extent", () => {
  // Two disconnected components: { a, b connected } and { c, d connected }.
  // Edge attraction should pull each pair closer than the full bounding box.
  const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const edges = [
    { from: "a", to: "b" },
    { from: "c", to: "d" }
  ];
  const positions = forceLayout(nodes, edges, { iterations: 200 });
  const ab = distance(positions.get("a")!, positions.get("b")!);
  const cd = distance(positions.get("c")!, positions.get("d")!);
  const ac = distance(positions.get("a")!, positions.get("c")!);
  // Connected pairs should be no further apart than the maximum cross
  // distance — this catches the regression where attraction is zero / flips
  // sign.
  assert.ok(ab < ac * 2, `connected a-b (${ab.toFixed(0)}) closer than cross a-c (${ac.toFixed(0)})`);
  assert.ok(cd < ac * 2, `connected c-d (${cd.toFixed(0)}) closer than cross a-c (${ac.toFixed(0)})`);
});

test("force: positions land in the positive quadrant", () => {
  const positions = forceLayout(
    [{ id: "a" }, { id: "b" }],
    [{ from: "a", to: "b" }]
  );
  for (const [id, p] of positions) {
    assert.ok(p.x >= 0, `${id}.x ${p.x} >= 0`);
    assert.ok(p.y >= 0, `${id}.y ${p.y} >= 0`);
  }
});

test("force: provided positions seed the simulation (don't get re-randomised)", () => {
  // When nodes carry positions, repeated runs converge toward them — the
  // first iteration's starting point IS those positions.
  const fresh = forceLayout(
    [{ id: "a" }, { id: "b" }],
    [{ from: "a", to: "b" }],
    { iterations: 1 }
  );
  // Seed from the first run; another 1-iter run should land near those.
  const seeded = forceLayout(
    [
      { id: "a", position: fresh.get("a") },
      { id: "b", position: fresh.get("b") }
    ],
    [{ from: "a", to: "b" }],
    { iterations: 1 }
  );
  for (const id of ["a", "b"]) {
    const f = fresh.get(id)!;
    const s = seeded.get(id)!;
    assert.ok(distance(f, s) < 200, `${id} stays close to its seed (Δ ${distance(f, s).toFixed(0)})`);
  }
});

// ---------------------------------------------------------------------------
// applyLayout dispatcher
// ---------------------------------------------------------------------------

test("applyLayout dispatches to the right algorithm per kind", () => {
  const nodes = [{ id: "a" }, { id: "b" }];
  const edges = [{ from: "a", to: "b" }];
  const tb = applyLayout("layered-TB", nodes, edges);
  const lr = applyLayout("layered-LR", nodes, edges);
  const force = applyLayout("force", nodes, edges);
  // TB: same x for a/b. LR: same y. Force: neither necessarily.
  assert.ok(Math.abs(tb.get("a")!.x - tb.get("b")!.x) < 1, "layered-TB stacks vertically");
  assert.ok(Math.abs(lr.get("a")!.y - lr.get("b")!.y) < 1, "layered-LR aligns horizontally");
  assert.ok(force.has("a") && force.has("b"), "force returns positions for both");
});

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
