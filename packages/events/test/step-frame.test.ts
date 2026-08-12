/**
 * ADR-0037 step-frame wire projection: small bodies inline, large bodies
 * travel as a preview + `truncated` flag (the full body is fetched by frameId).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  toStepWireFrame,
  STEP_INLINE_MAX_BYTES,
  type StepFrameBody
} from "../src/index.ts";

function body(over: Partial<StepFrameBody> = {}): StepFrameBody {
  return {
    frameId: "f1",
    nodeId: "retrieve",
    channel: "primary",
    source: "node_output",
    seq: 1,
    at: "2026-01-01T00:00:00.000Z",
    data: { doc: "hello" },
    ...over
  };
}

test("small body is inlined verbatim (no truncation)", () => {
  const wire = toStepWireFrame(body());
  assert.deepEqual(wire.data, { doc: "hello" });
  assert.equal(wire.truncated, undefined);
  assert.equal(wire.bytes, undefined);
  // Metadata is carried through unchanged.
  assert.equal(wire.frameId, "f1");
  assert.equal(wire.channel, "primary");
  assert.equal(wire.source, "node_output");
  assert.equal(wire.seq, 1);
});

test("large body is truncated to a preview + byte count, body dropped", () => {
  const big = "x".repeat(STEP_INLINE_MAX_BYTES + 5000);
  const wire = toStepWireFrame(body({ data: { blob: big } }));
  assert.equal(wire.truncated, true);
  assert.equal(wire.data, undefined, "full body must not ride the wire");
  assert.ok(typeof wire.bytes === "number" && wire.bytes > STEP_INLINE_MAX_BYTES);
  assert.ok(wire.preview && wire.preview.length <= 512);
  // Metadata still present so the client can fetch by frameId + label it.
  assert.equal(wire.frameId, "f1");
  assert.equal(wire.channel, "primary");
});

test("a custom (smaller) cap forces truncation of an otherwise-inline body", () => {
  const wire = toStepWireFrame(body({ data: { doc: "hello world" } }), 4);
  assert.equal(wire.truncated, true);
  assert.equal(wire.data, undefined);
});

test("exactly-at-cap body still inlines (boundary is inclusive)", () => {
  // Build a body whose JSON is exactly the cap length.
  const filler = "y".repeat(STEP_INLINE_MAX_BYTES - JSON.stringify({ v: "" }).length);
  const data = { v: filler };
  assert.equal(JSON.stringify(data).length, STEP_INLINE_MAX_BYTES);
  const wire = toStepWireFrame(body({ data }));
  assert.equal(wire.truncated, undefined);
  assert.deepEqual(wire.data, data);
});
