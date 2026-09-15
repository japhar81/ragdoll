/**
 * Regression tests for the worker plugin-registry boot.
 *
 * The bug these lock down: a transient failure in the best-effort sidecar
 * push/discovery (or the DB blip inside it) used to discard the fully-loaded
 * worker-host registry and drop the worker back to the static built-ins, which
 * then dead-lettered every external-plugin run ("plugin <id> is not
 * registered") until a redeploy. And a failure of the LOAD itself was swallowed
 * (warn) so the worker served jobs with a static registry instead of restarting.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { initWorkerPluginRegistry } from "../src/plugin-registry-init.ts";

interface LogCall {
  level: "info" | "warn" | "error";
  message: string;
  meta?: Record<string, unknown>;
}
function fakeLogger() {
  const calls: LogCall[] = [];
  const mk = (level: LogCall["level"]) =>
    (message: string, meta?: Record<string, unknown>) => calls.push({ level, message, meta });
  return { calls, logger: { info: mk("info"), warn: mk("warn"), error: mk("error") } };
}

// A distinguishable "holder" the fake loader returns; identity is all we check.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const HOLDER = { id: "the-holder" } as any;

const okStatuses = [
  { id: "builtin", status: "loaded" },
  { id: "opt-plugins", status: "loaded", commitSha: "abc" }
];

/* eslint-disable @typescript-eslint/no-explicit-any */
function deps(overrides: Record<string, any> = {}) {
  const lg = fakeLogger();
  const base: any = {
    store: {} as any,
    logger: lg.logger,
    loadRegistry: async () => ({ holder: HOLDER, statuses: okStatuses }),
    pushSidecar: async () => ({ pushed: false }),
    registerSidecar: async () => undefined,
    ...overrides
  };
  return { base, lg };
}

test("returns the loaded holder and logs loaded/failed counts", async () => {
  const { base, lg } = deps();
  const holder = await initWorkerPluginRegistry(base);
  assert.equal(holder, HOLDER);
  const built = lg.calls.find((c) => c.message.includes("built from plugin_sources store"));
  assert.ok(built);
  assert.equal(built!.meta?.loaded, 2);
  assert.equal(built!.meta?.failed, 0);
});

test("a sidecar push/discovery failure does NOT discard the worker-host holder", async () => {
  const { base, lg } = deps({
    pushSidecar: async () => {
      throw new Error("sidecar unreachable / DB blip");
    }
  });
  const holder = await initWorkerPluginRegistry(base);
  // The holder still comes back — this is the core regression fix.
  assert.equal(holder, HOLDER);
  assert.ok(lg.calls.some((c) => c.level === "warn" && /sidecar plugin discovery failed/.test(c.message)));
});

test("registerSidecar failure also leaves the holder intact", async () => {
  const { base } = deps({
    registerSidecar: async () => {
      throw new Error("manifests fetch failed");
    }
  });
  assert.equal(await initWorkerPluginRegistry(base), HOLDER);
});

test("a per-source load failure is surfaced LOUDLY but still returns the holder", async () => {
  const { base, lg } = deps({
    loadRegistry: async () => ({
      holder: HOLDER,
      statuses: [
        { id: "builtin", status: "loaded" },
        { id: "opt-plugins", status: "failed", error: "clone failed", errorStage: "clone" }
      ]
    })
  });
  const holder = await initWorkerPluginRegistry(base);
  assert.equal(holder, HOLDER);
  const err = lg.calls.find((c) => c.level === "error" && /sources failed to load/.test(c.message));
  assert.ok(err, "a failed source must log an error");
  assert.equal((err!.meta?.failed as unknown[]).length, 1);
});

test("a failure of the LOAD itself propagates (caller fail-fasts, does not degrade)", async () => {
  const { base } = deps({
    loadRegistry: async () => {
      throw new Error("DB not reachable");
    }
  });
  await assert.rejects(() => initWorkerPluginRegistry(base), /DB not reachable/);
});
