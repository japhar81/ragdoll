/**
 * The dispatch engine — pre-lane (veto/mutate/order/timeout/fail-policy) and
 * post-lane (fan-out/isolation). Pure, no I/O.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PlatformEventDispatcher,
  PlatformPluginRegistry,
  type ExecutionEvent,
  type MutationEvent,
  type PlatformPlugin
} from "../src/index.ts";

function execStart(input: unknown = "orig"): ExecutionEvent {
  return {
    id: "e1",
    correlationId: "exec-1",
    event: "execution.start",
    phase: "pre",
    category: "execution",
    at: "2026-01-01T00:00:00Z",
    actor: { id: "u1", tenantId: "t1" },
    tenantId: "t1",
    target: { type: "execution", id: "exec-1" },
    executionId: "exec-1",
    pipelineId: "p1",
    input
  };
}

function secretCreate(): MutationEvent {
  return {
    id: "m1",
    correlationId: "req-1",
    event: "secret.create",
    phase: "pre",
    category: "mutation",
    at: "2026-01-01T00:00:00Z",
    actor: { id: "admin", tenantId: "t1" },
    tenantId: "t1",
    target: { type: "secret", id: "s1" },
    after: { value: "supersecret" }
  };
}

const sub = (events: string[], phases?: ("pre" | "post")[]) => ({ events, phases });

test("pre: no interceptors → continue, event unchanged", async () => {
  const d = new PlatformEventDispatcher(new PlatformPluginRegistry());
  const r = await d.intercept(execStart());
  assert.equal(r.decision.action, "continue");
  assert.deepEqual(r.patch, {});
});

test("pre: mutate composes + is filtered to the event's mutable fields", async () => {
  const reg = new PlatformPluginRegistry();
  reg.register({
    name: "enrich",
    subscriptions: [sub(["execution.start"], ["pre"])],
    before: () => ({
      action: "mutate",
      // `output` is NOT mutable on execution.start → must be dropped
      patch: { input: "rewritten", output: "nope" }
    })
  });
  const d = new PlatformEventDispatcher(reg);
  const r = await d.intercept(execStart());
  assert.equal(r.decision.action, "continue");
  assert.deepEqual(r.patch, { input: "rewritten" });
  assert.equal((r.event as ExecutionEvent).input, "rewritten");
});

test("pre: a later interceptor observes the earlier one's mutation", async () => {
  const reg = new PlatformPluginRegistry();
  const seen: unknown[] = [];
  reg.register({
    name: "first",
    subscriptions: [sub(["execution.start"])],
    meta: { priority: 1 },
    before: () => ({ action: "mutate", patch: { input: "from-first" } })
  });
  reg.register({
    name: "second",
    subscriptions: [sub(["execution.start"])],
    meta: { priority: 2 },
    before: (e) => {
      seen.push((e as ExecutionEvent).input);
      return { action: "continue" };
    }
  });
  await new PlatformEventDispatcher(reg).intercept(execStart());
  assert.deepEqual(seen, ["from-first"]);
});

test("pre: deny short-circuits (later interceptors don't run)", async () => {
  const reg = new PlatformPluginRegistry();
  let secondRan = false;
  reg.register({
    name: "gate",
    subscriptions: [sub(["secret.*"])],
    meta: { priority: 1 },
    before: () => ({ action: "deny", reason: "policy", status: 403 })
  });
  reg.register({
    name: "after",
    subscriptions: [sub(["secret.*"])],
    meta: { priority: 2 },
    before: () => {
      secondRan = true;
      return { action: "continue" };
    }
  });
  const r = await new PlatformEventDispatcher(reg).intercept(secretCreate());
  assert.equal(r.decision.action, "deny");
  assert.equal((r.decision as { reason: string }).reason, "policy");
  assert.equal((r.decision as { status?: number }).status, 403);
  assert.equal(secondRan, false);
});

test("pre: force-fail is honored (execution.finish)", async () => {
  const reg = new PlatformPluginRegistry();
  reg.register({
    name: "compliance",
    subscriptions: [sub(["execution.finish"])],
    before: () => ({ action: "fail", reason: "pii detected in output" })
  });
  const ev = { ...execStart(), event: "execution.finish", phase: "pre" as const };
  const r = await new PlatformEventDispatcher(reg).intercept(ev);
  assert.equal(r.decision.action, "fail");
});

test("pre: a timeout is fail-open by default (continue), fail-closed when set", async () => {
  const hang: PlatformPlugin = {
    name: "slow",
    subscriptions: [sub(["execution.start"])],
    meta: { timeoutMs: 20 },
    before: () => new Promise(() => {}) // never resolves
  };
  const openReg = new PlatformPluginRegistry();
  openReg.register(hang);
  const open = await new PlatformEventDispatcher(openReg).intercept(execStart());
  assert.equal(open.decision.action, "continue");

  const closedReg = new PlatformPluginRegistry();
  closedReg.register({ ...hang, name: "slow2", meta: { timeoutMs: 20, failurePolicy: "closed" } });
  const closed = await new PlatformEventDispatcher(closedReg).intercept(execStart());
  assert.equal(closed.decision.action, "deny");
});

test("pre: a thrown error obeys fail policy too", async () => {
  const reg = new PlatformPluginRegistry();
  reg.register({
    name: "boom",
    subscriptions: [sub(["execution.start"])],
    meta: { failurePolicy: "closed" },
    before: () => {
      throw new Error("kaboom");
    }
  });
  const r = await new PlatformEventDispatcher(reg).intercept(execStart());
  assert.equal(r.decision.action, "deny");
  assert.match((r.decision as { reason: string }).reason, /fail-closed/);
});

test("post: fan-out to matching observers only; one failure is isolated", async () => {
  const reg = new PlatformPluginRegistry();
  const calls: string[] = [];
  reg.register({
    name: "obs-secret",
    subscriptions: [sub(["secret.*"], ["post"])],
    on: () => {
      calls.push("secret");
      throw new Error("observer blew up");
    }
  });
  reg.register({
    name: "obs-all",
    subscriptions: [sub(["*"], ["post"])],
    on: () => {
      calls.push("all");
    }
  });
  reg.register({
    name: "obs-pipeline",
    subscriptions: [sub(["pipeline.*"], ["post"])],
    on: () => {
      calls.push("pipeline");
    }
  });
  const ev = { ...secretCreate(), phase: "post" as const };
  // Must not throw despite obs-secret throwing.
  await new PlatformEventDispatcher(reg).deliver(ev);
  assert.deepEqual(calls.sort(), ["all", "secret"]); // pipeline.* did NOT match
});

test("phase filter: a pre-only subscription is not delivered a post event", async () => {
  const reg = new PlatformPluginRegistry();
  let ran = false;
  reg.register({
    name: "pre-only",
    subscriptions: [sub(["secret.*"], ["pre"])],
    on: () => {
      ran = true;
    }
  });
  await new PlatformEventDispatcher(reg).deliver({ ...secretCreate(), phase: "post" });
  assert.equal(ran, false);
});
