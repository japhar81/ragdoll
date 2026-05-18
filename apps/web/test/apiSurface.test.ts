import test from "node:test";
import assert from "node:assert/strict";
import { api, setTenant, setAuth, getAuth } from "../src/lib/api.ts";

// Regression guard: components call `api.setTenant(...)` etc. The web app is
// not typechecked here (no node_modules; root tsconfig excludes apps/web) and
// `vite build` only strips types, so an object/standalone mismatch like a
// missing `api.setTenant` ships as a runtime "is not a function" crash. Pin
// the method surface the UI depends on.

test("api exposes the auth/tenant setters used by components", () => {
  for (const name of ["setTenant", "setAuth", "getAuth"] as const) {
    assert.equal(typeof (api as Record<string, unknown>)[name], "function", `api.${name} must be a function`);
  }
  // Same implementations as the standalone exports (consistent state).
  assert.equal(api.setTenant, setTenant);
  assert.equal(api.setAuth, setAuth);
  assert.equal(api.getAuth, getAuth);
});

test("setTenant flows through getAuth and is cleared with undefined", () => {
  setTenant("8888c784-26d6-444e-9355-f49e0c09fc19");
  assert.equal(getAuth().tenantId, "8888c784-26d6-444e-9355-f49e0c09fc19");
  api.setTenant(undefined);
  assert.equal(getAuth().tenantId, undefined);
});

test("core api methods the screens rely on exist", () => {
  for (const name of [
    "health",
    "listTenants",
    "listPipelines",
    "run",
    "savePipeline",
    "rollbackPipeline",
    "listFolders",
    "listSchedules",
    "resolvedConfig",
    "listExecutions",
    "getExecution",
    "getExecutionTrace",
    "getTrace"
  ]) {
    assert.equal(
      typeof (api as Record<string, unknown>)[name],
      "function",
      `api.${name} must be a function`
    );
  }
});
