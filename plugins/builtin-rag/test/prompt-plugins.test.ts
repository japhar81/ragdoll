/**
 * Tests for the basic_rag_prompt plugin's document projection knobs.
 *
 * Retrieval often surfaces wide documents — embeddings, full body
 * text, raw metadata — that bloat {{context}} past the model's window.
 * `documentFields` (whitelist) and `documentBodyMaxChars` (truncate)
 * shrink the stringified context without changing the template.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { basicPromptTemplatePlugin } from "../src/index.ts";
import type { PluginExecutionInput } from "../../../packages/plugin-sdk/src/index.ts";
import type { RuntimeContext } from "../../../packages/core/src/index.ts";

function fakeContext(): RuntimeContext {
  return {
    requestId: "r",
    executionId: "e-1",
    tenantId: "t-1",
    pipelineId: "p",
    pipelineVersionId: "v1",
    environment: "dev",
    resolvedConfig: {
      pipelineId: "p",
      tenantId: "t-1",
      environment: "dev",
      violations: [],
      values: {}
    }
  };
}

function run(args: {
  inputs?: Record<string, unknown>;
  config?: Record<string, unknown>;
}): ReturnType<typeof basicPromptTemplatePlugin.execute> {
  const input: PluginExecutionInput = {
    context: fakeContext(),
    node: {
      id: "p",
      plugin: { category: "prompt_template", id: "basic_rag_prompt", version: "1.0.0" }
    },
    inputs: args.inputs ?? {},
    config: args.config ?? {},
    secrets: {}
  };
  return basicPromptTemplatePlugin.execute(input);
}

function userContent(messages: unknown): string {
  const arr = messages as Array<{ role: string; content: string }>;
  return arr.find((m) => m.role === "user")!.content;
}

test("basic_rag_prompt: no projection config keeps the full document in {{context}}", async () => {
  const docs = [{ id: "d1", text: "hello", embedding: [0.1, 0.2], metadata: { tag: "x" } }];
  const result = await run({ inputs: { question: "q", documents: docs } });
  const content = userContent(result.outputs.messages);
  assert.ok(content.includes('"embedding":[0.1,0.2]'), "embedding survives without a whitelist");
  assert.ok(content.includes('"tag":"x"'));
  assert.ok(content.includes("Question: q"));
});

test("basic_rag_prompt: documentFields whitelists keep only the listed fields", async () => {
  const docs = [
    { id: "d1", text: "hello", embedding: [0.1, 0.2], body_text: "long body" },
    { id: "d2", text: "world", embedding: [0.3, 0.4] }
  ];
  const result = await run({
    inputs: { question: "q", documents: docs },
    config: { documentFields: ["id", "text"] }
  });
  const content = userContent(result.outputs.messages);
  // The whitelist drops fields not listed; surviving fields stay verbatim.
  assert.ok(content.includes('"id":"d1"'));
  assert.ok(content.includes('"text":"hello"'));
  assert.ok(!content.includes("embedding"), "embedding field should be dropped");
  assert.ok(!content.includes("body_text"), "body_text field should be dropped");
});

test("basic_rag_prompt: documentBodyMaxChars truncates long string fields with an ellipsis", async () => {
  const long = "a".repeat(500);
  const docs = [{ id: "d1", text: "short", body_text: long }];
  const result = await run({
    inputs: { question: "q", documents: docs },
    config: { documentBodyMaxChars: 50 }
  });
  const content = userContent(result.outputs.messages);
  // Short fields are untouched; long ones get sliced + an ellipsis.
  assert.ok(content.includes('"text":"short"'));
  assert.ok(content.includes("a".repeat(50) + "…"));
  assert.ok(!content.includes("a".repeat(51)), "must not contain 51 consecutive a's after truncation");
});

test("basic_rag_prompt: whitelist + truncate compose (whitelist first, then truncate)", async () => {
  const long = "b".repeat(200);
  const docs = [{ id: "d1", text: "hello", body_text: long, embedding: [1, 2] }];
  const result = await run({
    inputs: { question: "q", documents: docs },
    config: { documentFields: ["id", "body_text"], documentBodyMaxChars: 20 }
  });
  const content = userContent(result.outputs.messages);
  assert.ok(content.includes('"id":"d1"'));
  assert.ok(content.includes("b".repeat(20) + "…"));
  assert.ok(!content.includes("embedding"));
  assert.ok(!content.includes('"text":"hello"'), "text is not on the whitelist");
});
