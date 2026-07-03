/**
 * The worker adapter that turns the platform-plugin dispatcher into the
 * runtime's ExecutionLifecycleHooks (ADR 0036 pre-lane). Verifies the
 * decision→hook translation: veto→deny, mutate input on start, force-fail +
 * mutate output on finish.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { lifecycleHooksFrom } from "../src/platform-lifecycle.ts";
import {
  PlatformEventDispatcher,
  PlatformPluginRegistry,
  type InterceptorDecision
} from "../../../packages/platform-plugins/src/index.ts";
import type { RuntimeContext } from "../../../packages/core/src/index.ts";

const ctx = {
  executionId: "e1",
  tenantId: "t1",
  pipelineId: "p1",
  pipelineVersionId: "v1",
  environment: "dev",
  actor: { id: "u1" }
} as unknown as RuntimeContext;

function hooksWith(name: string, events: string[], decide: () => InterceptorDecision) {
  const reg = new PlatformPluginRegistry();
  reg.register({
    name,
    subscriptions: [{ events, phases: ["pre"] }],
    before: decide
  });
  return lifecycleHooksFrom(new PlatformEventDispatcher(reg));
}

test("no interceptors → onStart/onFinish return undefined (no change)", async () => {
  const hooks = lifecycleHooksFrom(new PlatformEventDispatcher(new PlatformPluginRegistry()));
  assert.equal(await hooks.onStart!({ context: ctx, input: {} }), undefined);
  assert.equal(await hooks.onFinish!({ context: ctx, output: {} }), undefined);
});

test("onStart veto → { deny }", async () => {
  const hooks = hooksWith("v", ["execution.start"], () => ({
    action: "deny",
    reason: "blocked at start"
  }));
  assert.deepEqual(await hooks.onStart!({ context: ctx, input: {} }), {
    deny: { reason: "blocked at start" }
  });
});

test("onStart mutate input → { input }", async () => {
  const hooks = hooksWith("m", ["execution.start"], () => ({
    action: "mutate",
    patch: { input: { redacted: true } }
  }));
  assert.deepEqual(await hooks.onStart!({ context: ctx, input: { pii: "x" } }), {
    input: { redacted: true }
  });
});

test("onFinish force-fail → { fail }", async () => {
  const hooks = hooksWith("f", ["execution.finish"], () => ({
    action: "fail",
    reason: "pii in output"
  }));
  assert.deepEqual(await hooks.onFinish!({ context: ctx, output: {} }), {
    fail: { reason: "pii in output" }
  });
});

test("onFinish mutate output → { output }", async () => {
  const hooks = hooksWith("o", ["execution.finish"], () => ({
    action: "mutate",
    patch: { output: { safe: true } }
  }));
  assert.deepEqual(await hooks.onFinish!({ context: ctx, output: { raw: "x" } }), {
    output: { safe: true }
  });
});

test("a start interceptor does NOT fire on finish (event scoping)", async () => {
  const hooks = hooksWith("start-only", ["execution.start"], () => ({
    action: "deny",
    reason: "nope"
  }));
  // finish has no matching interceptor → undefined
  assert.equal(await hooks.onFinish!({ context: ctx, output: {} }), undefined);
});
