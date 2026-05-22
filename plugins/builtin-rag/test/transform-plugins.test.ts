import test from "node:test";
import assert from "node:assert/strict";
import {
  transformPlugin,
  xmlCodecPlugin,
  evaluateExpression,
  resolveOutputExpressions
} from "../src/transform.ts";
import type { PluginExecutionInput } from "../../../packages/plugin-sdk/src/index.ts";
import type { InProcessPlugin } from "../../../packages/plugin-sdk/src/index.ts";
import type { RuntimeContext } from "../../../packages/core/src/index.ts";

/** Minimal RuntimeContext — transform/xml_codec read neither, so all the
 *  branchy fields are shimmed. */
function fakeContext(): RuntimeContext {
  return {
    requestId: "r",
    executionId: "e",
    tenantId: "t",
    pipelineId: "pipe",
    pipelineVersionId: "v1",
    environment: "dev",
    resolvedConfig: { pipelineId: "pipe", tenantId: "t", environment: "dev", violations: [], values: {} }
  };
}

/** Invoke a plugin's execute with just the inputs + config it actually reads. */
function run(
  plugin: InProcessPlugin,
  inputs: Record<string, unknown>,
  config: Record<string, unknown>
): Promise<{ outputs: Record<string, unknown>; metadata?: Record<string, unknown> }> {
  const input: PluginExecutionInput = {
    context: fakeContext(),
    node: { id: "n", plugin: { category: plugin.manifest.category, id: plugin.manifest.id, version: "1.0.0" } },
    inputs,
    config,
    secrets: {}
  };
  return plugin.execute(input);
}

// ---------------------------------------------------------------------------
// evaluateExpression — JSONata
// ---------------------------------------------------------------------------

test("evaluateExpression jsonata: reads a field off the inputs bag", async () => {
  const result = await evaluateExpression("jsonata", "payload.title", { payload: { title: "hello" } });
  assert.equal(result, "hello");
});

test("evaluateExpression jsonata: aggregation over an array", async () => {
  const result = await evaluateExpression("jsonata", "$sum(items.n)", { items: [{ n: 1 }, { n: 2 }, { n: 4 }] });
  assert.equal(result, 7);
});

test("evaluateExpression jsonata: object construction", async () => {
  const result = await evaluateExpression(
    "jsonata",
    '{ "count": $count(docs), "first": docs[0].id }',
    { docs: [{ id: "a" }, { id: "b" }] }
  );
  assert.deepEqual(result, { count: 2, first: "a" });
});

test("evaluateExpression jsonata: no match yields undefined", async () => {
  const result = await evaluateExpression("jsonata", "missing.deep.path", { present: 1 });
  assert.equal(result, undefined);
});

test("evaluateExpression jsonata: parse error throws with a plugin-prefixed message", async () => {
  await assert.rejects(
    () => evaluateExpression("jsonata", "!!not valid(", {}),
    /transform: JSONata parse error/
  );
});

// ---------------------------------------------------------------------------
// evaluateExpression — JMESPath
// ---------------------------------------------------------------------------

test("evaluateExpression jmespath: list projection", async () => {
  const result = await evaluateExpression("jmespath", "items[*].n", { items: [{ n: 1 }, { n: 2 }] });
  assert.deepEqual(result, [1, 2]);
});

test("evaluateExpression jmespath: error throws with a plugin-prefixed message", async () => {
  await assert.rejects(() => evaluateExpression("jmespath", "!!", {}), /transform: JMESPath error/);
});

test("evaluateExpression jmespath: undefined root does not throw", async () => {
  const result = await evaluateExpression("jmespath", "anything", undefined);
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// resolveOutputExpressions
// ---------------------------------------------------------------------------

test("resolveOutputExpressions: defaults to a single identity output", () => {
  assert.deepEqual(resolveOutputExpressions(undefined, "jsonata"), [["out", "$"]]);
  assert.deepEqual(resolveOutputExpressions(undefined, "jmespath"), [["out", "@"]]);
});

test("resolveOutputExpressions: keeps string expressions, drops non-strings", () => {
  const pairs = resolveOutputExpressions({ a: "x.y", b: 42, c: "z" }, "jsonata");
  assert.deepEqual(pairs, [
    ["a", "x.y"],
    ["c", "z"]
  ]);
});

test("resolveOutputExpressions: accepts a JSON string (form widget round-trip)", () => {
  const pairs = resolveOutputExpressions('{"summary":"title"}', "jsonata");
  assert.deepEqual(pairs, [["summary", "title"]]);
});

// ---------------------------------------------------------------------------
// transform plugin
// ---------------------------------------------------------------------------

test("transform: default config is an identity pass-through on the `out` port", async () => {
  const { outputs } = await run(transformPlugin, { in: { hello: "world" } }, {});
  assert.deepEqual(outputs, { out: { in: { hello: "world" } } });
});

test("transform: fans one input out to several independently-computed ports", async () => {
  const { outputs } = await run(
    transformPlugin,
    { payload: { title: "Doc", items: [1, 2, 3], tags: ["a", "b"] } },
    {
      engine: "jsonata",
      inputs: ["payload"],
      outputs: {
        summary: 'payload.title & " (" & $string($count(payload.items)) & " items)"',
        keywords: "payload.tags"
      }
    }
  );
  assert.equal(outputs.summary, "Doc (3 items)");
  assert.deepEqual(outputs.keywords, ["a", "b"]);
});

test("transform: expression context spans every wired input port by name", async () => {
  const { outputs } = await run(
    transformPlugin,
    { question: "what?", docs: [{ id: "d1" }] },
    { outputs: { merged: '{ "q": question, "n": $count(docs) }' } }
  );
  assert.deepEqual(outputs.merged, { q: "what?", n: 1 });
});

test("transform: jmespath engine evaluates per output port", async () => {
  const { outputs, metadata } = await run(
    transformPlugin,
    { data: { rows: [{ v: 10 }, { v: 20 }] } },
    { engine: "jmespath", inputs: ["data"], outputs: { values: "data.rows[*].v" } }
  );
  assert.deepEqual(outputs.values, [10, 20]);
  assert.equal(metadata?.engine, "jmespath");
});

test("transform: an output expression with no match emits undefined (dead branch)", async () => {
  const { outputs } = await run(
    transformPlugin,
    { present: 1 },
    { outputs: { live: "present", dead: "absent.deep" } }
  );
  assert.equal(outputs.live, 1);
  assert.ok("dead" in outputs);
  assert.equal(outputs.dead, undefined);
});

test("transform: metadata reports the engine and the emitted port set", async () => {
  const { metadata } = await run(
    transformPlugin,
    { in: 1 },
    { outputs: { a: "in", b: "in" } }
  );
  assert.equal(metadata?.engine, "jsonata");
  assert.deepEqual(metadata?.outputPorts, ["a", "b"]);
});

test("transform: manifest declares dynamicPorts and no static port contract", () => {
  const m = transformPlugin.manifest;
  assert.deepEqual(m.dynamicPorts, { inputsFrom: "inputs", outputsFrom: "outputs" });
  // Leaving the static contract empty is what keeps validatePipelineSpec from
  // warning about author-named ports.
  assert.equal(m.inputPorts, undefined);
  assert.equal(m.outputPorts, undefined);
});

// ---------------------------------------------------------------------------
// xml_codec plugin
// ---------------------------------------------------------------------------

test("xml_codec parse: turns an XML string into a JSON object tree", async () => {
  const { outputs } = await run(
    xmlCodecPlugin,
    { xml: "<feed><item>a</item><item>b</item></feed>" },
    { mode: "parse" }
  );
  assert.deepEqual(outputs.json, { feed: { item: ["a", "b"] } });
});

test("xml_codec parse: attributes round-trip onto prefixed keys", async () => {
  const { outputs } = await run(
    xmlCodecPlugin,
    { xml: '<book id="42">Title</book>' },
    { mode: "parse" }
  );
  assert.deepEqual(outputs.json, { book: { "@_id": "42", "#text": "Title" } });
});

test("xml_codec parse: ignoreAttributes drops attributes", async () => {
  const { outputs } = await run(
    xmlCodecPlugin,
    { xml: '<book id="42">Title</book>' },
    { mode: "parse", ignoreAttributes: true }
  );
  assert.deepEqual(outputs.json, { book: "Title" });
});

test("xml_codec serialize: turns a JSON object into an XML string", async () => {
  const { outputs } = await run(
    xmlCodecPlugin,
    { json: { note: { to: "team", body: "ship it" } } },
    { mode: "serialize", format: false }
  );
  assert.equal(outputs.xml, "<note><to>team</to><body>ship it</body></note>");
});

test("xml_codec serialize: rootName wraps multi-key JSON in a single root element", async () => {
  const { outputs } = await run(
    xmlCodecPlugin,
    { json: { a: 1, b: 2 } },
    { mode: "serialize", format: false, rootName: "doc" }
  );
  assert.equal(outputs.xml, "<doc><a>1</a><b>2</b></doc>");
});

test("xml_codec: parse then serialize round-trips the structure", async () => {
  const original = "<catalog><book><title>RAG</title></book></catalog>";
  const parsed = await run(xmlCodecPlugin, { xml: original }, { mode: "parse" });
  const reserialized = await run(xmlCodecPlugin, { json: parsed.outputs.json }, { mode: "serialize", format: false });
  assert.equal(reserialized.outputs.xml, original);
});

test("xml_codec: manifest declares both the xml and json ports on each side", () => {
  const m = xmlCodecPlugin.manifest;
  assert.deepEqual(
    m.inputPorts?.map((p) => p.name),
    ["xml", "json"]
  );
  assert.deepEqual(
    m.outputPorts?.map((p) => p.name),
    ["json", "xml"]
  );
});
