/**
 * Pure-helper tests for the Builder's JSON view. The web app isn't typechecked
 * in CI (vite only strips types), so these lock the behaviour the CodeMirror
 * component relies on: parse/shape-guarding, anchoring validator issues to the
 * right line, and detecting what the caret is completing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  detectCompletion,
  findNodeIdLine,
  issuesToRanges,
  parsePipelineJson,
  specToPrettyJson
} from "../src/lib/pipelineJson.ts";
import type { ValidationIssue } from "../../../packages/pipeline-spec/src/index.ts";

test("specToPrettyJson pretty-prints with 2-space indent", () => {
  const out = specToPrettyJson({ a: 1, b: { c: 2 } });
  assert.equal(out, '{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}');
});

test("parsePipelineJson accepts an object with a spec block", () => {
  const r = parsePipelineJson('{"metadata":{"name":"p"},"spec":{"nodes":[],"edges":[]}}');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal((r.spec.metadata as { name?: string }).name, "p");
});

test("parsePipelineJson rejects invalid JSON with the parser message", () => {
  const r = parsePipelineJson("{not json");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /./);
});

test("parsePipelineJson rejects a non-object and a spec-less object", () => {
  assert.equal(parsePipelineJson("[1,2,3]").ok, false);
  assert.equal(parsePipelineJson('{"metadata":{}}').ok, false);
});

const doc = [
  "{",
  '  "spec": {',
  '    "nodes": [',
  '      { "id": "load", "plugin": { "id": "http_source" } },',
  '      { "id": "parse", "plugin": { "id": "html_parser" } }',
  "    ]",
  "  }",
  "}"
].join("\n");

test("findNodeIdLine anchors to the line declaring that node id", () => {
  const range = findNodeIdLine(doc, "parse");
  assert.ok(range);
  assert.equal(doc.slice(range!.from, range!.to).includes('"id": "parse"'), true);
});

test("issuesToRanges maps a node issue to its line and severity", () => {
  const issues: ValidationIssue[] = [
    { level: "error", code: "MISSING_INPUT", message: "needs an input", nodeId: "parse" }
  ];
  const [r] = issuesToRanges(doc, issues);
  assert.equal(r.severity, "error");
  assert.equal(r.code, "MISSING_INPUT");
  assert.equal(doc.slice(r.from, r.to).includes('"parse"'), true);
});

test("issuesToRanges anchors an unlocatable issue to line 1 (never dropped)", () => {
  const issues: ValidationIssue[] = [
    { level: "warning", code: "GLOBAL", message: "pipeline-level note" }
  ];
  const [r] = issuesToRanges(doc, issues);
  assert.equal(r.from, 0);
  assert.equal(r.severity, "warning");
});

test("issuesToRanges anchors an edge issue to its from-node", () => {
  const issues: ValidationIssue[] = [
    { level: "error", code: "BAD_EDGE", message: "dangling", edge: { from: "load", to: "gone" } }
  ];
  const [r] = issuesToRanges(doc, issues);
  assert.equal(doc.slice(r.from, r.to).includes('"load"'), true);
});

test("detectCompletion → connection inside a slug value", () => {
  const t = detectCompletion('{ "connection": { "slug": "oau');
  assert.ok(t);
  assert.equal(t!.kind, "connection");
});

test("detectCompletion → pluginId inside a plugin id value", () => {
  const t = detectCompletion('{ "plugin": { "id": "opensea');
  assert.ok(t);
  assert.equal(t!.kind, "pluginId");
});

test("detectCompletion → null for a NODE id (no nearby plugin key)", () => {
  const t = detectCompletion('{ "nodes": [ { "id": "myn');
  assert.equal(t, null);
});

test("detectCompletion → null outside any completable value", () => {
  assert.equal(detectCompletion('{ "metadata": { "name": "p" },'), null);
});

test("detectCompletion.from marks the start of the already-typed value", () => {
  const prefix = '{ "connection": { "slug": "oau';
  const t = detectCompletion(prefix);
  assert.ok(t);
  assert.equal(prefix.slice(t!.from), "oau");
});
