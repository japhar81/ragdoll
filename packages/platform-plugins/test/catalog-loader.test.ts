/**
 * Catalog (event metadata + glob matching), registry override, event→change
 * projection, and the boot loader's module-export handling.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  catalogEntry,
  eventMatches,
  explicitCatalog,
  KNOWN_MUTATION_EVENT_NAMES,
  toChangeEvent,
  PlatformPluginRegistry,
  loadPlatformPlugins,
  parsePlatformPluginModules,
  type MutationEvent,
  type PlatformPlugin
} from "../src/index.ts";

test("eventMatches: exact, prefix glob, and star", () => {
  assert.equal(eventMatches("secret.create", "secret.create"), true);
  assert.equal(eventMatches("secret.*", "secret.delete"), true);
  assert.equal(eventMatches("secret.*", "secretive.delete"), false); // keeps the dot
  assert.equal(eventMatches("*", "anything.at.all"), true);
  assert.equal(eventMatches("secret.create", "secret.delete"), false);
});

test("catalog: execution.start allows pre veto+mutate of input/config/context", () => {
  const e = catalogEntry("execution.start");
  assert.deepEqual(e.phases, ["pre", "post"]);
  assert.deepEqual(e.preCapabilities.sort(), ["mutate", "veto"]);
  assert.deepEqual(e.mutablePatch.sort(), ["config", "context", "input"]);
});

test("catalog: execution.finish is the only one that can force-fail", () => {
  assert.ok(catalogEntry("execution.finish").preCapabilities.includes("fail"));
  assert.ok(!catalogEntry("execution.start").preCapabilities.includes("fail"));
});

test("catalog: terminal execution + usage events are post-only", () => {
  for (const name of ["execution.success", "execution.failure", "usage.recorded"]) {
    assert.deepEqual(catalogEntry(name).phases, ["post"]);
    assert.deepEqual(catalogEntry(name).preCapabilities, []);
  }
});

test("catalog: an unknown/new mutation is trapped as a uniform mutation entry", () => {
  const e = catalogEntry("widget.frobnicate"); // not in the known list
  assert.equal(e.category, "mutation");
  assert.deepEqual(e.phases, ["pre", "post"]);
  assert.deepEqual(e.mutablePatch.sort(), ["after", "before"]);
});

test("catalog: the 72 known mutation actions are enumerated", () => {
  assert.equal(KNOWN_MUTATION_EVENT_NAMES.size, 72);
  for (const known of ["secret.delete", "pipeline.deploy", "user.grant", "role.set_permissions"]) {
    assert.ok(KNOWN_MUTATION_EVENT_NAMES.has(known), known);
  }
  // execution/usage are NOT mutations
  assert.ok(!KNOWN_MUTATION_EVENT_NAMES.has("execution.start"));
  assert.equal(explicitCatalog().length, 8); // 7 execution + 1 usage
});

test("registry: later registration of the same name overrides", () => {
  const reg = new PlatformPluginRegistry();
  reg.register({ name: "x", subscriptions: [{ events: ["*"] }], meta: { priority: 1 } });
  reg.register({ name: "x", subscriptions: [{ events: ["*"] }], meta: { priority: 9 } });
  assert.equal(reg.list().length, 1);
  assert.equal(reg.get("x")?.meta?.priority, 9);
});

test("toChangeEvent: projects a post mutation onto the ChangeEvent shape", () => {
  const ev: MutationEvent = {
    id: "m1",
    correlationId: "r1",
    event: "pipeline.deploy",
    phase: "post",
    category: "mutation",
    at: "2026-01-01T00:00:00Z",
    actor: { id: "admin", tenantId: "t1" },
    tenantId: "t1",
    target: { type: "pipeline_deployment", id: "d1" },
    requiredPermission: "pipeline:deploy",
    after: { version: "1.2.0" }
  };
  const ce = toChangeEvent(ev);
  assert.equal(ce.action, "pipeline.deploy");
  assert.equal(ce.targetType, "pipeline_deployment");
  assert.equal(ce.targetId, "d1");
  assert.equal(ce.actorId, "admin");
  assert.equal(ce.requiredPermission, "pipeline:deploy");
  assert.deepEqual(ce.payload, { after: { version: "1.2.0" } });
});

// ---- loader --------------------------------------------------------------

test("parsePlatformPluginModules: comma/space list, trimmed + deduped", () => {
  assert.deepEqual(parsePlatformPluginModules({ RAGDOLL_PLATFORM_PLUGINS: undefined }), []);
  assert.deepEqual(
    parsePlatformPluginModules({ RAGDOLL_PLATFORM_PLUGINS: "@a/x, ./y.js ,@a/x" }),
    ["@a/x", "./y.js"]
  );
});

const fake = (name: string): PlatformPlugin => ({
  name,
  subscriptions: [{ events: ["*"] }],
  on: () => {}
});

test("loadPlatformPlugins: unset env → empty registry", async () => {
  const { registry, loaded } = await loadPlatformPlugins({ env: {} });
  assert.deepEqual(loaded, []);
  assert.equal(registry.list().length, 0);
});

test("loadPlatformPlugins: default-export plugin, array, and registrar all register", async () => {
  const importer = async (spec: string) => {
    if (spec === "one") return { default: fake("one") };
    if (spec === "many") return { default: [fake("a"), fake("b")] };
    return { default: (r: PlatformPluginRegistry) => r.register(fake("registrar")) };
  };
  const { registry, loaded } = await loadPlatformPlugins({
    env: { RAGDOLL_PLATFORM_PLUGINS: "one, many, reg" },
    importer
  });
  assert.deepEqual(loaded, ["one", "many", "reg"]);
  assert.deepEqual(
    registry.list().map((p) => p.name).sort(),
    ["a", "b", "one", "registrar"]
  );
});

test("loadPlatformPlugins: a bad export throws (fail-closed at boot)", async () => {
  await assert.rejects(
    () =>
      loadPlatformPlugins({
        env: { RAGDOLL_PLATFORM_PLUGINS: "bad" },
        importer: async () => ({ default: { nope: true } })
      }),
    /not a PlatformPlugin/
  );
});
