import test from "node:test";
import assert from "node:assert/strict";
import { asJson, asTable, format } from "../src/format.ts";

test("asJson is pretty-printed", () => {
  assert.equal(asJson({ a: 1 }), '{\n  "a": 1\n}');
});

test("asTable renders columns from the row union, fixed-width", () => {
  const out = asTable([
    { id: "a", name: "Alice" },
    { id: "b", name: "Bob" }
  ]);
  const lines = out.split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^id\s+name$/);
  assert.match(lines[1], /^---?\s+----+$/);
  assert.ok(lines[2].startsWith("a "));
  assert.ok(lines[3].startsWith("b "));
});

test("asTable: empty -> friendly placeholder", () => {
  assert.equal(asTable([]), "(no rows)");
});

test("format(table) auto-extracts the single embedded array (e.g. {tenants:[...]})", () => {
  const out = format({ tenants: [{ id: "1" }, { id: "2" }] }, "table");
  assert.match(out, /^id\n--\n1\n2$/);
});

test("format(json) is the default fallback for non-array values", () => {
  assert.match(format({ a: 1 }, "table"), /"a": 1/);
});
