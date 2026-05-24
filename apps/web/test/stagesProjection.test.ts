import test from "node:test";
import assert from "node:assert/strict";
import {
  projectStages,
  type StagesEdge
} from "../src/lib/stagesProjection.ts";

test("linear chain: each node in its own stage", () => {
  const { stages } = projectStages(
    ["a", "b", "c"],
    [
      { source: "a", target: "b" },
      { source: "b", target: "c" }
    ]
  );
  assert.deepEqual(
    stages.map((s) => s.nodeIds),
    [["a"], ["b"], ["c"]]
  );
});

test("two parallel chains share stages", () => {
  const ids = ["fs_code", "fs_docs", "ch_code", "ch_docs"];
  const edges: StagesEdge[] = [
    { source: "fs_code", target: "ch_code" },
    { source: "fs_docs", target: "ch_docs" }
  ];
  const { stages } = projectStages(ids, edges);
  assert.equal(stages.length, 2);
  assert.deepEqual(stages[0].nodeIds, ["fs_code", "fs_docs"]);
  assert.deepEqual(stages[1].nodeIds, ["ch_code", "ch_docs"]);
});

test("convergence: a node waits for the deepest of its inputs", () => {
  // a→b→c→d  e→d  — d waits for c (stage 3) not e (stage 1)
  const ids = ["a", "b", "c", "d", "e"];
  const edges: StagesEdge[] = [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
    { source: "c", target: "d" },
    { source: "e", target: "d" }
  ];
  const { stages } = projectStages(ids, edges);
  // a, e at stage 0; b at 1; c at 2; d at 3.
  assert.deepEqual(stages[0].nodeIds, ["a", "e"]);
  assert.deepEqual(stages[1].nodeIds, ["b"]);
  assert.deepEqual(stages[2].nodeIds, ["c"]);
  assert.deepEqual(stages[3].nodeIds, ["d"]);
});

test("disconnected nodes are roots", () => {
  const { stages } = projectStages(["x", "y"], []);
  assert.equal(stages.length, 1);
  assert.deepEqual(stages[0].nodeIds, ["x", "y"]);
});

test("a cycle still places every node — cycle members pin to the deepest cycle stage", () => {
  // a→b→a  (cycle) + c→a
  const { stages } = projectStages(
    ["a", "b", "c"],
    [
      { source: "a", target: "b" },
      { source: "b", target: "a" },
      { source: "c", target: "a" }
    ]
  );
  // c is the only true root, so it sits at stage 0.
  // a + b are both in the cycle and pinned to stage 1.
  const flat = stages.flatMap((s) => s.nodeIds);
  assert.deepEqual(flat.sort(), ["a", "b", "c"]);
  assert.deepEqual(stages[0].nodeIds, ["c"]);
});

test("self-loops don't prevent stage resolution", () => {
  const { stages } = projectStages(
    ["a", "b"],
    [
      { source: "a", target: "b" },
      // Self-loop on b — ignored.
      { source: "b", target: "b" }
    ]
  );
  assert.deepEqual(stages[0].nodeIds, ["a"]);
  assert.deepEqual(stages[1].nodeIds, ["b"]);
});

test("dangling edges (unknown ids) are silently dropped", () => {
  const { stages } = projectStages(
    ["a"],
    [
      { source: "a", target: "ghost" },
      { source: "ghost", target: "a" }
    ]
  );
  assert.deepEqual(stages, [{ index: 0, nodeIds: ["a"] }]);
});
