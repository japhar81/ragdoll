import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryChangeBus, type ChangeEvent } from "../src/index.ts";

function makeEvent(action: string): ChangeEvent {
  return {
    id: action,
    action,
    targetType: action.split(".")[0],
    targetId: "t1",
    tenantId: null,
    actorId: "tester",
    at: new Date().toISOString()
  };
}

test("InMemoryChangeBus publish fans out to every subscriber", async () => {
  const bus = new InMemoryChangeBus();
  const a: ChangeEvent[] = [];
  const b: ChangeEvent[] = [];
  bus.subscribe((e) => a.push(e));
  bus.subscribe((e) => b.push(e));

  await bus.publish(makeEvent("tenant.create"));
  await bus.publish(makeEvent("pipeline.update"));

  assert.deepEqual(
    a.map((e) => e.action),
    ["tenant.create", "pipeline.update"]
  );
  assert.deepEqual(
    b.map((e) => e.action),
    ["tenant.create", "pipeline.update"]
  );
});

test("InMemoryChangeBus unsubscribe stops delivery for that handler only", async () => {
  const bus = new InMemoryChangeBus();
  const a: ChangeEvent[] = [];
  const b: ChangeEvent[] = [];
  const offA = bus.subscribe((e) => a.push(e));
  bus.subscribe((e) => b.push(e));

  await bus.publish(makeEvent("tenant.create"));
  offA();
  await bus.publish(makeEvent("pipeline.update"));

  assert.equal(a.length, 1);
  assert.equal(b.length, 2);
});

test("InMemoryChangeBus swallows handler errors so peers still see the event", async () => {
  const bus = new InMemoryChangeBus({
    logger: { error: () => undefined, warn: () => undefined }
  });
  const seen: ChangeEvent[] = [];
  bus.subscribe(() => {
    throw new Error("boom");
  });
  bus.subscribe((e) => seen.push(e));

  await bus.publish(makeEvent("tenant.create"));

  assert.equal(seen.length, 1);
});

test("InMemoryChangeBus close drops every subscription", async () => {
  const bus = new InMemoryChangeBus();
  const seen: ChangeEvent[] = [];
  bus.subscribe((e) => seen.push(e));
  await bus.close();
  await bus.publish(makeEvent("tenant.create"));
  assert.equal(seen.length, 0);
});
