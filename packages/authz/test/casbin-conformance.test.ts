/**
 * Pins the real Casbin engine to identical decisions as the dependency-free
 * reference engine across a scope/permission matrix. Skips automatically when
 * `casbin` is not installed (the default install-free `node --test` run); it
 * executes in the Docker images and any environment where deps are present.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BuiltinPolicyEngine,
  buildCatalog,
  defaultCatalogRows,
  type Grant
} from "../src/index.ts";

let casbinAvailable = true;
try {
  await import("casbin" as string);
} catch {
  casbinAvailable = false;
}

test(
  "Casbin engine == Builtin engine across the scope/permission matrix",
  { skip: casbinAvailable ? false : "casbin not installed (install-free run)" },
  async () => {
    const { CasbinPolicyEngine } = await import("../src/casbin.ts");
    const catalog = buildCatalog(defaultCatalogRows());

    const grantSets: Grant[][] = [
      [],
      [{ role: "platform_admin", scope: "*" }],
      [{ role: "tenant_admin", scope: "t/A" }],
      [{ role: "environment_admin", scope: "t/A/e/prod" }],
      [{ role: "pipeline_admin", scope: "t/A/p/P1" }],
      [
        { role: "viewer", scope: "t/A" },
        { role: "pipeline_editor", scope: "t/B/p/P9" }
      ]
    ];
    const permissions = [
      "config:edit_global",
      "config:edit_tenant",
      "pipeline:run",
      "pipeline:delete",
      "execution:view_logs",
      "user:manage"
    ];
    const scopes = [
      "*",
      "t/A",
      "t/A/e/prod",
      "t/A/e/dev",
      "t/A/p/P1",
      "t/B",
      "t/B/p/P9"
    ];

    const builtin = new BuiltinPolicyEngine();
    const casbin = new CasbinPolicyEngine();

    // Empty catalog AND no grants: both engines must default-deny without
    // throwing (Casbin's StringAdapter rejects an empty policy document; the
    // engine must short-circuit). Regression guard for the startup probe.
    {
      const empty = new Map<string, Set<string>>();
      const b = await builtin.prepare([], empty);
      const c = await casbin.prepare([], empty);
      assert.equal(b("pipeline:run", "*"), false);
      assert.equal(c("pipeline:run", "*"), false);
    }
    // And the factory probe must succeed (real Casbin, not the fallback).
    await (await import("../src/casbin.ts")).createCasbinEngine();

    for (const grants of grantSets) {
      const b = await builtin.prepare(grants, catalog);
      const c = await casbin.prepare(grants, catalog);
      for (const perm of permissions) {
        for (const scope of scopes) {
          assert.equal(
            c(perm, scope),
            b(perm, scope),
            `mismatch grants=${JSON.stringify(grants)} perm=${perm} scope=${scope}`
          );
        }
      }
    }
  }
);
