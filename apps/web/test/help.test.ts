import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS,
  SHORTCUTS,
  filterPalette,
  parseGoShortcut,
  routeToDoc
} from "../src/lib/help.ts";

// ---- routeToDoc ----------------------------------------------------------

test("routeToDoc maps access-control screens to the access-control doc", () => {
  for (const p of [
    "/users",
    "/users/123",
    "/roles",
    "/identity-providers",
    "/auth-settings"
  ]) {
    assert.equal(routeToDoc(p), "access-control");
  }
});

test("routeToDoc maps pipeline-y / scheduler screens to triggers (operating model)", () => {
  for (const p of ["/pipelines", "/builder", "/builder/abc", "/scheduler"]) {
    assert.equal(routeToDoc(p), "triggers");
  }
});

test("routeToDoc returns null when no specific doc matches", () => {
  assert.equal(routeToDoc("/audit"), null);
  assert.equal(routeToDoc("/usage"), null);
});

test("routeToDoc returns the welcome / in-app-help doc at the home route", () => {
  assert.equal(routeToDoc("/"), "in-app-help");
  assert.equal(routeToDoc(""), "in-app-help");
});

// ---- shortcuts -----------------------------------------------------------

test("SHORTCUTS includes the canonical chords", () => {
  const flat = SHORTCUTS.map((s) => s.keys.join("+"));
  assert.ok(flat.includes("⌘+K"));
  assert.ok(flat.includes("Ctrl+K"));
  assert.ok(flat.includes("?"));
  assert.ok(flat.includes("Esc"));
});

test("parseGoShortcut maps known 'g <letter>' chords", () => {
  assert.equal(parseGoShortcut("gp"), "pipelines");
  assert.equal(parseGoShortcut("gs"), "scheduler");
  assert.equal(parseGoShortcut("ge"), "executions");
  assert.equal(parseGoShortcut("gu"), "users");
  assert.equal(parseGoShortcut("gx"), undefined);
  assert.equal(parseGoShortcut(""), undefined);
});

// ---- palette filter ------------------------------------------------------

test("filterPalette: empty query returns every action the caller can see", () => {
  // can() returns false for everything -> no perm-gated items, only Help (no perms).
  const helpOnly = filterPalette(ACTIONS, "", () => false);
  assert.ok(helpOnly.length > 0);
  assert.ok(helpOnly.every((a) => !a.perms || a.perms.length === 0));
});

test("filterPalette: empty query + permissive can() returns everything", () => {
  const all = filterPalette(ACTIONS, "", () => true);
  assert.equal(all.length, ACTIONS.length);
});

test("filterPalette: token AND match across label / hint / group / keywords", () => {
  const all = (..._p: string[]) => true;
  // Matches by label.
  const a = filterPalette(ACTIONS, "pipelines", all).map((x) => x.id);
  assert.ok(a.includes("nav.pipelines"));
  // Matches by hint path.
  const b = filterPalette(ACTIONS, "/audit", all).map((x) => x.id);
  assert.ok(b.includes("nav.audit"));
  // Matches by keyword.
  const c = filterPalette(ACTIONS, "cron", all).map((x) => x.id);
  assert.ok(c.includes("create.schedule"));
  // Each token must match (AND, not OR).
  const d = filterPalette(ACTIONS, "create user", all).map((x) => x.id);
  assert.ok(d.includes("create.user"));
  assert.ok(!d.includes("create.tenant"));
});

test("filterPalette: permission gating hides items the user cannot perform", () => {
  // Only auditor permissions.
  const only = (...need: string[]) => need.some((p) => p === "audit:view");
  const out = filterPalette(ACTIONS, "", only).map((x) => x.id);
  assert.ok(out.includes("nav.audit"));
  assert.ok(!out.includes("create.user"));
  assert.ok(!out.includes("nav.tenants"));
  // Help entries (no perms) always show.
  assert.ok(out.includes("help.shortcuts"));
});
