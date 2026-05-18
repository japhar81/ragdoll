import test from "node:test";
import assert from "node:assert/strict";
import {
  applyFieldEdit,
  bindExpressionFor,
  coerceFieldValue,
  deleteAtPath,
  deriveFields,
  getAtPath,
  hasUsableSchema,
  isBoundExpression,
  labelFromKey,
  setAtPath,
  type FieldDescriptor,
  type JsonSchemaLike
} from "../src/lib/schemaForm.ts";

const SCHEMA: JsonSchemaLike = {
  type: "object",
  required: ["model"],
  properties: {
    model: { type: "string", description: "Model id" },
    temperature: { type: "number", default: 0.2 },
    max_tokens: { type: "integer" },
    stream: { type: "boolean" },
    provider: { type: "string", enum: ["openai", "anthropic"] },
    stop: { type: "array", items: { type: "string" } },
    headers: { type: "object", additionalProperties: true },
    retrieval: {
      type: "object",
      required: ["top_k"],
      properties: {
        top_k: { type: "integer", description: "How many docs" },
        rerank: { type: "boolean" }
      }
    }
  }
};

test("labelFromKey humanizes the leaf segment", () => {
  assert.equal(labelFromKey("retrieval.top_k"), "Top k");
  assert.equal(labelFromKey("maxTokens"), "Max Tokens");
  assert.equal(labelFromKey("model"), "Model");
});

test("isBoundExpression detects ${config.*} / ${secret.*} only", () => {
  assert.equal(isBoundExpression("${config.llm.model}"), true);
  assert.equal(isBoundExpression("${secret.api_key}"), true);
  assert.equal(isBoundExpression("  ${config.x}  "), true);
  assert.equal(isBoundExpression("gpt-4o"), false);
  assert.equal(isBoundExpression("prefix ${config.x}"), false);
  assert.equal(isBoundExpression(42), false);
});

test("getAtPath / setAtPath / deleteAtPath are immutable + nested", () => {
  const obj = { a: { b: 1 }, c: 2 };
  assert.equal(getAtPath(obj, "a.b"), 1);
  assert.equal(getAtPath(obj, "a.z"), undefined);
  assert.equal(getAtPath(obj, "x.y.z"), undefined);

  const set = setAtPath(obj, "a.d", 9);
  assert.deepEqual(set, { a: { b: 1, d: 9 }, c: 2 });
  assert.deepEqual(obj, { a: { b: 1 }, c: 2 }); // untouched

  const del = deleteAtPath(set, "a.b");
  assert.deepEqual(del, { a: { d: 9 }, c: 2 });
  // pruning: removing the last child removes the now-empty parent
  const pruned = deleteAtPath({ a: { b: 1 } }, "a.b");
  assert.deepEqual(pruned, {});
});

test("deriveFields produces ordered descriptors and flattens one object level", () => {
  const fields = deriveFields(SCHEMA, {
    model: "gpt-4o",
    temperature: 0.7,
    retrieval: { top_k: 5 }
  });
  const byKey = new Map(fields.map((f) => [f.key, f]));

  assert.equal(byKey.get("model")?.kind, "string");
  assert.equal(byKey.get("model")?.required, true);
  assert.equal(byKey.get("model")?.description, "Model id");
  assert.equal(byKey.get("temperature")?.kind, "number");
  assert.equal(byKey.get("temperature")?.default, 0.2);
  assert.equal(byKey.get("max_tokens")?.kind, "integer");
  assert.equal(byKey.get("stream")?.kind, "boolean");
  assert.equal(byKey.get("provider")?.kind, "enum");
  assert.deepEqual(byKey.get("provider")?.enumValues, ["openai", "anthropic"]);
  assert.equal(byKey.get("stop")?.kind, "array-string");
  // additionalProperties object with no sub-properties -> object (JSON field)
  assert.equal(byKey.get("headers")?.kind, "object");

  // nested object flattened one level
  assert.equal(byKey.get("retrieval.top_k")?.kind, "integer");
  assert.equal(byKey.get("retrieval.top_k")?.required, true);
  assert.equal(byKey.get("retrieval.top_k")?.value, 5);
  assert.equal(byKey.get("retrieval.rerank")?.kind, "boolean");
  // no bare "retrieval" object field once flattened
  assert.equal(byKey.has("retrieval"), false);
});

test("deriveFields marks bound values and returns [] without schema", () => {
  const fields = deriveFields(SCHEMA, { model: "${config.llm.model}" });
  const model = fields.find((f) => f.key === "model");
  assert.equal(model?.bound, true);
  assert.deepEqual(deriveFields(undefined, {}), []);
  assert.deepEqual(deriveFields({ type: "object" }, {}), []);
});

test("coerceFieldValue coerces per kind and respects bound passthrough", () => {
  const num: FieldDescriptor = {
    key: "t",
    label: "T",
    kind: "number",
    required: false,
    value: undefined,
    bound: false
  };
  assert.equal(coerceFieldValue(num, "0.7"), 0.7);
  assert.equal(coerceFieldValue({ ...num, kind: "integer" }, "5.9"), 5);
  assert.equal(coerceFieldValue({ ...num, kind: "boolean" }, true), true);
  assert.equal(coerceFieldValue({ ...num, kind: "boolean" }, "true"), true);
  assert.equal(coerceFieldValue(num, ""), undefined);
  // bound expression always passes through untouched
  assert.equal(
    coerceFieldValue(num, "${config.llm.temperature}"),
    "${config.llm.temperature}"
  );
  // array-string convenience: comma/newline split
  assert.deepEqual(
    coerceFieldValue({ ...num, kind: "array-string" }, "a, b\nc"),
    ["a", "b", "c"]
  );
  assert.deepEqual(
    coerceFieldValue({ ...num, kind: "array-string" }, '["x","y"]'),
    ["x", "y"]
  );
  // object: parse JSON, unparseable stays raw string for continued typing
  assert.deepEqual(
    coerceFieldValue({ ...num, kind: "object" }, '{"a":1}'),
    { a: 1 }
  );
  assert.equal(coerceFieldValue({ ...num, kind: "object" }, "{bad"), "{bad");
});

test("applyFieldEdit immutably writes coerced values and deletes on clear", () => {
  const field = deriveFields(SCHEMA, {})!.find((f) => f.key === "retrieval.top_k")!;
  const next = applyFieldEdit({ model: "gpt" }, field, "8");
  assert.deepEqual(next, { model: "gpt", retrieval: { top_k: 8 } });

  // clearing an optional field removes it (and prunes the empty parent)
  const cleared = applyFieldEdit({ retrieval: { top_k: 8 } }, field, "");
  assert.deepEqual(cleared, {});

  // binding writes the ${config.<path>} expression verbatim
  assert.equal(bindExpressionFor(field), "${config.retrieval.top_k}");
  const bound = applyFieldEdit({}, field, bindExpressionFor(field));
  assert.deepEqual(bound, { retrieval: { top_k: "${config.retrieval.top_k}" } });
});

test("hasUsableSchema drives the form-vs-rawJSON fallback decision", () => {
  assert.equal(hasUsableSchema(SCHEMA), true);
  assert.equal(hasUsableSchema(undefined), false);
  assert.equal(hasUsableSchema({ type: "object" }), false);
  assert.equal(hasUsableSchema({ type: "object", properties: {} }), false);
  assert.equal(
    hasUsableSchema({ type: "object", properties: { a: { type: "string" } } }),
    true
  );
});
