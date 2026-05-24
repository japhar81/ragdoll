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

test("fan-in renders the second parent as a crossRef on the target", () => {
  // chunk and embed both feed write — write's primary parent is the
  // first one BFS sees (chunk, alphabetical), embed becomes a crossRef.
  const ids = ["chunk", "embed", "write"];
  const edges: ProjEdge[] = [
    { source: "chunk", target: "write", sourceHandle: "chunks" },
    { source: "embed", target: "write", sourceHandle: "vectors" }
  ];
  const tree = projectGraphToTree(ids, edges);
  const write = findNode(tree, "write");
  assert.ok(write);
  assert.equal(write!.crossRefs.length, 1);
  assert.equal(write!.crossRefs[0].fromId, "embed");
  assert.equal(write!.crossRefs[0].fromPort, "vectors");
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
