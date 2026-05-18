import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ENTRIES,
  appendEntry,
  describeError,
  emptyConsole,
  formatApiError,
  hasRealPipeline,
  isProbablyUuid,
  redact,
  summarizeRequest
} from "../src/lib/consoleLog.ts";

const UUID = "3f1a9c2e-6b7d-4a2f-8e1c-9d0b2a4c6e8f";

// ---- appendEntry / ring buffer ------------------------------------------

test("appendEntry assigns ids/timestamps and never mutates input", () => {
  const s0 = emptyConsole();
  const s1 = appendEntry(s0, { level: "info", label: "a", ts: 1000 });
  assert.equal(s0.entries.length, 0); // immutable
  assert.equal(s1.entries.length, 1);
  assert.equal(s1.entries[0].id, 1);
  assert.equal(s1.entries[0].ts, 1000);
  const s2 = appendEntry(s1, { level: "error", label: "b", ts: 2000 });
  assert.equal(s2.entries[1].id, 2);
  assert.deepEqual(
    s2.entries.map((e) => e.label),
    ["a", "b"] // newest last
  );
});

test("appendEntry caps the buffer at MAX_ENTRIES, dropping oldest", () => {
  let s = emptyConsole();
  for (let i = 0; i < MAX_ENTRIES + 25; i++) {
    s = appendEntry(s, { level: "info", label: `e${i}`, ts: i });
  }
  assert.equal(s.entries.length, MAX_ENTRIES);
  // oldest 25 dropped; first surviving is e25, last is the newest
  assert.equal(s.entries[0].label, "e25");
  assert.equal(s.entries[s.entries.length - 1].label, `e${MAX_ENTRIES + 24}`);
  // ids keep climbing past the cap
  assert.equal(s.seq, MAX_ENTRIES + 26);
});

// ---- summarizeRequest / redaction ---------------------------------------

test("summarizeRequest produces a compact one-liner", () => {
  assert.equal(summarizeRequest(undefined), "(no body)");
  assert.equal(summarizeRequest(null), "null");
  assert.equal(summarizeRequest([1, 2, 3]), "[3 items]");
  assert.equal(summarizeRequest([1]), "[1 item]");
  assert.equal(
    summarizeRequest({ version: "1.2.0", environment: "prod" }),
    "version=1.2.0, environment=prod"
  );
  // nested objects/arrays collapse to a size hint, not a dump
  const s = summarizeRequest({ spec: { nodes: [1, 2], edges: [] }, level: "patch" });
  assert.match(s, /spec=\{2 keys\}/);
  assert.match(s, /level=patch/);
});

test("summarizeRequest redacts secret-ish top-level keys", () => {
  const s = summarizeRequest({
    apiKey: "sk-very-secret",
    token: "abc",
    password: "hunter2",
    name: "ok"
  });
  assert.match(s, /apiKey=\[redacted\]/);
  assert.match(s, /token=\[redacted\]/);
  assert.match(s, /password=\[redacted\]/);
  assert.match(s, /name=ok/);
  assert.ok(!s.includes("sk-very-secret"));
  assert.ok(!s.includes("hunter2"));
});

test("redact deep-masks secret keys but keeps structure", () => {
  const out = redact({
    spec: { secrets: { apiKey: { key: "llm.api_key" } } },
    token: "t",
    list: [{ password: "p", keep: 1 }]
  }) as Record<string, unknown>;
  assert.equal(out.token, "[redacted]");
  const spec = out.spec as Record<string, unknown>;
  assert.equal(spec.secrets, "[redacted]");
  const list = out.list as Array<Record<string, unknown>>;
  assert.equal(list[0].password, "[redacted]");
  assert.equal(list[0].keep, 1);
});

// ---- formatApiError: ApiError vs network vs validation vs unknown --------

test("formatApiError handles a structured ApiError body", () => {
  const apiErr = { status: 409, body: { error: "no_active_deployment", message: "No active deployment for tenant-a/prod" } };
  const f = formatApiError(apiErr);
  assert.equal(f.kind, "api");
  assert.equal(f.status, 409);
  assert.equal(f.code, "no_active_deployment");
  assert.equal(f.message, "No active deployment for tenant-a/prod");
  assert.match(describeError(f), /HTTP 409 · no_active_deployment · No active deployment/);
});

test("formatApiError surfaces validation issues (422)", () => {
  const apiErr = {
    status: 422,
    body: {
      error: "validation_failed",
      message: "Spec invalid",
      issues: [{ path: "nodes[0]", message: "missing plugin" }, "second issue"]
    }
  };
  const f = formatApiError(apiErr);
  assert.equal(f.kind, "api");
  assert.equal(f.status, 422);
  assert.equal(f.code, "validation_failed");
  assert.ok(Array.isArray(f.issues));
  assert.equal(f.issues?.length, 2);
  assert.match(describeError(f), /\(2 issues\)/);
});

test("formatApiError falls back to error code / status when no message", () => {
  const f = formatApiError({ status: 404, body: { error: "pipeline_not_found" } });
  assert.equal(f.message, "Server returned pipeline_not_found");
  const g = formatApiError({ status: 500, body: "Internal Server Error" });
  assert.equal(g.status, 500);
  assert.equal(g.message, "Internal Server Error");
});

test("formatApiError classifies a fetch/network failure", () => {
  const f = formatApiError(new TypeError("Failed to fetch"));
  assert.equal(f.kind, "network");
  assert.equal(f.status, undefined);
  assert.match(f.message, /API unreachable/);
  assert.match(f.message, /Is the API running\?/);
  const g = formatApiError(new Error("fetch failed"));
  assert.equal(g.kind, "network");
});

test("formatApiError handles a plain unknown throw", () => {
  const f = formatApiError(new Error("boom"));
  assert.equal(f.kind, "unknown");
  assert.equal(f.message, "boom");
  assert.equal(formatApiError("weird").message, "weird");
});

// ---- pipeline-selected guard --------------------------------------------

test("isProbablyUuid only accepts canonical UUIDs", () => {
  assert.equal(isProbablyUuid(UUID), true);
  assert.equal(isProbablyUuid(UUID.toUpperCase()), true);
  assert.equal(isProbablyUuid(`  ${UUID}  `), true);
  assert.equal(isProbablyUuid("support-rag"), false);
  assert.equal(isProbablyUuid(""), false);
  assert.equal(isProbablyUuid(undefined), false);
  assert.equal(isProbablyUuid(123), false);
  assert.equal(isProbablyUuid("3f1a9c2e-6b7d-4a2f-8e1c-9d0b2a4c6e8"), false); // short
});

test("hasRealPipeline: placeholder slug is not real, UUID or tree-opened is", () => {
  assert.equal(hasRealPipeline({ pipelineId: "support-rag" }), false);
  assert.equal(hasRealPipeline({ pipelineId: "support-rag", openedViaTree: false }), false);
  // Opened from the Pipelines tree -> trusted even if id is a slug.
  assert.equal(hasRealPipeline({ pipelineId: "support-rag", openedViaTree: true }), true);
  // A UUID id is real on its own.
  assert.equal(hasRealPipeline({ pipelineId: UUID }), true);
});
