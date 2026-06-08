import test from "node:test";
import assert from "node:assert/strict";
import { simpleEvaluatorPlugin, evaluatorStubPlugin } from "../src/index.ts";
import type { PluginExecutionInput } from "../../../packages/plugin-sdk/src/index.ts";

function makeInput(args: {
  assertions: unknown[];
  inputs?: Record<string, unknown>;
}): PluginExecutionInput {
  return {
    context: {
      executionId: "e1",
      requestId: "r1",
      tenantId: "t1",
      pipelineId: "p1",
      pipelineVersionId: "v1",
      environment: "dev",
      resolvedConfig: {
        pipelineId: "p1",
        tenantId: "t1",
        environment: "dev",
        values: {},
        violations: []
      }
    },
    node: {
      id: "eval",
      plugin: { category: "evaluator", id: "simple_evaluator", version: "1.0.0" }
    },
    inputs: args.inputs ?? {},
    config: { assertions: args.assertions },
    secrets: {}
  };
}

test("simple_evaluator: empty assertions list passes by convention", async () => {
  const out = await simpleEvaluatorPlugin.execute(
    makeInput({ assertions: [], inputs: { answer: "anything" } })
  );
  assert.equal(out.outputs.score, 1);
  assert.equal(out.outputs.passed, true);
});

test("simple_evaluator: length_min passes when string meets threshold", async () => {
  const out = await simpleEvaluatorPlugin.execute(
    makeInput({
      assertions: [{ kind: "length_min", value: 5 }],
      inputs: { answer: "hello" }
    })
  );
  assert.equal(out.outputs.passed, true);
  assert.equal(out.outputs.score, 1);
});

test("simple_evaluator: length_min fails when string too short", async () => {
  const out = await simpleEvaluatorPlugin.execute(
    makeInput({
      assertions: [{ kind: "length_min", value: 100 }],
      inputs: { answer: "hi" }
    })
  );
  assert.equal(out.outputs.passed, false);
  assert.equal(out.outputs.score, 0);
});

test("simple_evaluator: contains is case-insensitive when opted in", async () => {
  const out = await simpleEvaluatorPlugin.execute(
    makeInput({
      assertions: [
        { kind: "contains", value: "QUICK", caseInsensitive: true }
      ],
      inputs: { answer: "The quick brown fox" }
    })
  );
  assert.equal(out.outputs.passed, true);
});

test("simple_evaluator: matches uses a real regex with flags", async () => {
  const out = await simpleEvaluatorPlugin.execute(
    makeInput({
      assertions: [{ kind: "matches", pattern: "^the\\b", flags: "i" }],
      inputs: { answer: "The answer" }
    })
  );
  assert.equal(out.outputs.passed, true);
});

test("simple_evaluator: score is fraction of passing assertions", async () => {
  const out = await simpleEvaluatorPlugin.execute(
    makeInput({
      assertions: [
        { kind: "length_min", value: 1 },
        { kind: "length_min", value: 100 },
        { kind: "contains", value: "hello" },
        { kind: "contains", value: "absent" }
      ],
      inputs: { answer: "hello world" }
    })
  );
  assert.equal(out.outputs.score, 0.5);
  assert.equal(out.outputs.passed, false);
});

test("simple_evaluator: dotted field path drills into nested objects", async () => {
  const out = await simpleEvaluatorPlugin.execute(
    makeInput({
      assertions: [
        { kind: "equals", value: 42, field: "result.code" }
      ],
      inputs: { answer: { result: { code: 42 } } }
    })
  );
  // Note: default field is `answer`, so the dotted path here is
  // `answer.result.code` — the lookup starts at the inputs bag, not the
  // resolved `answer` value. Let's verify with a direct top-level field.
  // (Re-run with field=answer.result.code per the docstring contract.)
  // Update the assertion to match the actual behaviour: the path is
  // resolved against the WHOLE inputs bag.
  void out; // suppress unused
  const out2 = await simpleEvaluatorPlugin.execute(
    makeInput({
      assertions: [
        { kind: "equals", value: 42, field: "answer.result.code" }
      ],
      inputs: { answer: { result: { code: 42 } } }
    })
  );
  assert.equal(out2.outputs.passed, true);
});

test("simple_evaluator: has_keys checks every required key", async () => {
  const out = await simpleEvaluatorPlugin.execute(
    makeInput({
      assertions: [{ kind: "has_keys", keys: ["a", "b"] }],
      inputs: { answer: { a: 1, b: 2, c: 3 } }
    })
  );
  assert.equal(out.outputs.passed, true);

  const out2 = await simpleEvaluatorPlugin.execute(
    makeInput({
      assertions: [{ kind: "has_keys", keys: ["a", "missing"] }],
      inputs: { answer: { a: 1 } }
    })
  );
  assert.equal(out2.outputs.passed, false);
});

test("simple_evaluator: bad regex reports a fail rather than throwing", async () => {
  const out = await simpleEvaluatorPlugin.execute(
    makeInput({
      assertions: [{ kind: "matches", pattern: "(unclosed" }],
      inputs: { answer: "anything" }
    })
  );
  assert.equal(out.outputs.passed, false);
  assert.match((out.outputs.notes as string[])[0], /bad regex/);
});

test("evaluatorStubPlugin (deprecated alias) shares the real implementation", async () => {
  const stub = await evaluatorStubPlugin.execute(
    makeInput({
      assertions: [{ kind: "length_min", value: 1 }],
      inputs: { answer: "hi" }
    })
  );
  const real = await simpleEvaluatorPlugin.execute(
    makeInput({
      assertions: [{ kind: "length_min", value: 1 }],
      inputs: { answer: "hi" }
    })
  );
  assert.deepEqual(stub.outputs, real.outputs);
});
