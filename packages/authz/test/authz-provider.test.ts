/**
 * Authorization-provider boot loader (ADR 0035): RAGDOLL_AUTHZ_PROVIDER lets
 * an external module supply a custom PolicyEngine, with the built-in
 * Casbin-then-builtin resolution as the unset default. The ~129 enforce()
 * call sites are untouched — only the engine behind the Authorizer changes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  loadAuthzEngine,
  BuiltinPolicyEngine,
  type PolicyEngine,
  type ScopedDecider
} from "../src/index.ts";

/** A custom engine that allows exactly one permission — distinguishable from
 *  the built-in so we can prove it's actually wired. */
const allowOnly = (perm: string): PolicyEngine => ({
  async prepare(): Promise<ScopedDecider> {
    return (permission) => permission === perm;
  }
});

const builtinFallback = async () => ({
  engine: new BuiltinPolicyEngine(),
  source: "builtin"
});

test("unset moduleUrl → the built-in fallback engine + source", async () => {
  const { engine, source } = await loadAuthzEngine({
    moduleUrl: undefined,
    fallback: builtinFallback
  });
  assert.equal(source, "builtin");
  assert.ok(engine instanceof BuiltinPolicyEngine);
});

test("a custom module exporting a PolicyEngine is used (fallback NOT called)", async () => {
  let fallbackCalled = false;
  const { engine, source } = await loadAuthzEngine({
    moduleUrl: "@acme/authz",
    fallback: async () => {
      fallbackCalled = true;
      return builtinFallback();
    },
    importer: async () => ({ default: allowOnly("pipeline:deploy") })
  });
  assert.equal(source, "@acme/authz");
  assert.equal(fallbackCalled, false, "custom provider must short-circuit the fallback");
  const decide = await engine.prepare([], new Map());
  assert.equal(decide("pipeline:deploy", "*"), true);
  assert.equal(decide("pipeline:delete", "*"), false);
});

test("a custom module exporting a FACTORY is invoked to build the engine", async () => {
  const { engine } = await loadAuthzEngine({
    moduleUrl: "x",
    fallback: builtinFallback,
    importer: async () => ({ default: () => allowOnly("audit:view") })
  });
  const decide = await engine.prepare([], new Map());
  assert.equal(decide("audit:view", "*"), true);
  assert.equal(decide("user:manage", "*"), false);
});

test("an async factory export is awaited", async () => {
  const { engine } = await loadAuthzEngine({
    moduleUrl: "x",
    fallback: builtinFallback,
    importer: async () => ({ default: async () => allowOnly("dataset:read") })
  });
  const decide = await engine.prepare([], new Map());
  assert.equal(decide("dataset:read", "*"), true);
});

test("a module without a default export (engine at top level) still resolves", async () => {
  const { engine } = await loadAuthzEngine({
    moduleUrl: "x",
    fallback: builtinFallback,
    importer: async () => allowOnly("connection:use")
  });
  const decide = await engine.prepare([], new Map());
  assert.equal(decide("connection:use", "*"), true);
});

test("a bad export throws — fail-closed, no silent fallback", async () => {
  await assert.rejects(
    () =>
      loadAuthzEngine({
        moduleUrl: "x",
        fallback: builtinFallback,
        importer: async () => ({ default: { not: "an engine" } })
      }),
    /not a PolicyEngine or a factory/
  );
});
