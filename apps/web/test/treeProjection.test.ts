import test from "node:test";
import assert from "node:assert/strict";
import {
  projectGraphToTree,
  isDescendant,
  findNode,
  type ProjEdge
} from "../src/lib/treeProjection.ts";

test("linear chain: input -> a -> b -> output flattens to one tree branch", () => {
  const ids = ["input", "a", "b", "output"];
  const edges: ProjEdge[] = [
    { source: "input", target: "a" },
    { source: "a", target: "b" },
    { source: "b", target: "output" }
  ];
  const tree = projectGraphToTree(ids, edges);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].id, "input");
  assert.equal(tree.roots[0].children[0].id, "a");
  assert.equal(tree.roots[0].children[0].children[0].id, "b");
  assert.equal(
    tree.roots[0].children[0].children[0].children[0].id,
    "output"
  );
});

test("two roots produce a forest", () => {
  const ids = ["fs_code", "fs_docs", "embed_code", "embed_docs"];
  const edges: ProjEdge[] = [
    { source: "fs_code", target: "embed_code" },
    { source: "fs_docs", target: "embed_docs" }
  ];
  const tree = projectGraphToTree(ids, edges);
  assert.equal(tree.roots.length, 2);
  // Root order is stable (sorted by id).
  assert.deepEqual(
    tree.roots.map((r) => r.id),
    ["fs_code", "fs_docs"]
  );
});

test("fan-in: a multi-parent join is hoisted to the top level with every parent as a crossRef", () => {
  // chunk and embed both feed write — `write` is a join node so it
  // becomes its own top-level row with both sources listed inline, and
  // each chain ends with a joinRef pointing to it.
  const ids = ["chunk", "embed", "write"];
  const edges: ProjEdge[] = [
    { source: "chunk", target: "write", sourceHandle: "chunks" },
    { source: "embed", target: "write", sourceHandle: "vectors" }
  ];
  const tree = projectGraphToTree(ids, edges);
  // Roots first (by id), then joins (by id): chunk, embed, write.
  assert.deepEqual(
    tree.roots.map((r) => r.id),
    ["chunk", "embed", "write"]
  );
  const write = findNode(tree, "write");
  assert.ok(write);
  assert.equal(write!.isJoin, true);
  assert.equal(write!.primaryEdge, undefined);
  assert.equal(write!.crossRefs.length, 2);
  assert.deepEqual(
    write!.crossRefs.map((c) => c.fromId).sort(),
    ["chunk", "embed"]
  );
  // Each parent chain ends with a "→ write" joinRef leaf.
  const chunk = findNode(tree, "chunk")!;
  assert.equal(chunk.joinRefs.length, 1);
  assert.equal(chunk.joinRefs[0].targetId, "write");
});

test("fan-out: a single source with two children renders both children", () => {
  const ids = ["delta", "chunk", "delete"];
  const edges: ProjEdge[] = [
    { source: "delta", target: "chunk", sourceHandle: "new" },
    { source: "delta", target: "delete", sourceHandle: "deleted" }
  ];
  const tree = projectGraphToTree(ids, edges);
  assert.equal(tree.roots.length, 1);
  // Sorted by target id.
  assert.deepEqual(
    tree.roots[0].children.map((c) => c.id),
    ["chunk", "delete"]
  );
});

test("isDescendant refuses cycles — re-parenting an ancestor onto its descendant is blocked", () => {
  const ids = ["a", "b", "c"];
  const edges: ProjEdge[] = [
    { source: "a", target: "b" },
    { source: "b", target: "c" }
  ];
  const tree = projectGraphToTree(ids, edges);
  // c is a descendant of a, so dropping a under c would create a cycle.
  assert.equal(isDescendant(tree, "a", "c"), true);
  // The reverse is not a descendant relationship.
  assert.equal(isDescendant(tree, "c", "a"), false);
});

test("disconnected components are all rooted", () => {
  const ids = ["x", "y", "z"];
  const edges: ProjEdge[] = [{ source: "x", target: "y" }];
  const tree = projectGraphToTree(ids, edges);
  // x is its own root; z has no edges so it's a root too.
  assert.deepEqual(
    tree.roots.map((r) => r.id).sort(),
    ["x", "z"]
  );
});

test("a graph that is all cycle still gets a synthetic root and exposes every node", () => {
  const ids = ["p", "q"];
  const edges: ProjEdge[] = [
    { source: "p", target: "q" },
    { source: "q", target: "p" }
  ];
  const tree = projectGraphToTree(ids, edges);
  // Lowest-id node ("p") is promoted to root; the back-edge becomes a
  // cross-ref so the cycle is visible in the rendering.
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].id, "p");
  assert.equal(tree.roots[0].children[0].id, "q");
  assert.equal(tree.roots[0].children[0].crossRefs.length, 0);
  // The back edge q→p shows up as a crossRef on p (already placed).
  const p = findNode(tree, "p");
  assert.equal(p!.crossRefs.length, 1);
  assert.equal(p!.crossRefs[0].fromId, "q");
});

test("primaryEdge carries the placing edge's id and ports", () => {
  const ids = ["a", "b"];
  const edges: ProjEdge[] = [
    {
      id: "e1",
      source: "a",
      target: "b",
      sourceHandle: "out",
      targetHandle: "in"
    }
  ];
  const tree = projectGraphToTree(ids, edges);
  const b = findNode(tree, "b");
  assert.ok(b);
  assert.equal(b!.primaryEdge?.edgeId, "e1");
  assert.equal(b!.primaryEdge?.fromPort, "out");
  assert.equal(b!.primaryEdge?.toPort, "in");
  // Roots have no primary edge.
  const a = findNode(tree, "a");
  assert.equal(a!.primaryEdge, undefined);
});

test("crossRef carries its own edge id so the editor can mutate exactly that edge", () => {
  const ids = ["chunk", "embed", "write"];
  const edges: ProjEdge[] = [
    { id: "e1", source: "chunk", target: "write", sourceHandle: "chunks", targetHandle: "chunks" },
    { id: "e2", source: "embed", target: "write", sourceHandle: "vectors", targetHandle: "vectors" }
  ];
  const tree = projectGraphToTree(ids, edges);
  const write = findNode(tree, "write")!;
  assert.equal(write.isJoin, true);
  // Both parents land as crossRefs on the hoisted join row.
  const byFrom = Object.fromEntries(
    write.crossRefs.map((r) => [r.fromId, r])
  );
  assert.equal(byFrom["chunk"].edgeId, "e1");
  assert.equal(byFrom["chunk"].toPort, "chunks");
  assert.equal(byFrom["embed"].edgeId, "e2");
  assert.equal(byFrom["embed"].toPort, "vectors");
});

test("edges referencing unknown ids are silently dropped", () => {
  const ids = ["a"];
  const edges: ProjEdge[] = [
    { source: "a", target: "ghost" },
    { source: "ghost", target: "a" }
  ];
  // No throw, single root with no children.
  const tree = projectGraphToTree(ids, edges);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].children.length, 0);
});
