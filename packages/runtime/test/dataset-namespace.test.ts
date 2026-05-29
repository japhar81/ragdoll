/**
 * Pure unit tests for the namespace-policy helpers (PR6).
 *
 * Tested as plain functions — no resolver, no harness. Integration with
 * the resolver lives in `apps/api/test/dataset-namespace-resolver.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyNamespacePolicy,
  validateNamespacePolicyForScope,
  sanitiseForCollectionSuffix
} from "../src/dataset-namespace.ts";

/* ---------- sanitiser ---------------------------------------------- */

test("sanitiser: lowercases + collapses non-alphanumeric to single _", () => {
  assert.equal(sanitiseForCollectionSuffix("Tenant-A"), "tenant_a");
  assert.equal(sanitiseForCollectionSuffix("PROD"), "prod");
  assert.equal(sanitiseForCollectionSuffix("acme co  ltd"), "acme_co_ltd");
  assert.equal(sanitiseForCollectionSuffix("__test__"), "test");
});

test("sanitiser: empty / all-invalid input falls back to 'unknown'", () => {
  assert.equal(sanitiseForCollectionSuffix(""), "unknown");
  assert.equal(sanitiseForCollectionSuffix("???"), "unknown");
  assert.equal(sanitiseForCollectionSuffix("_"), "unknown");
});

test("sanitiser: dedups consecutive underscores produced mid-string", () => {
  assert.equal(sanitiseForCollectionSuffix("a -- b"), "a_b");
  assert.equal(sanitiseForCollectionSuffix("a.b.c"), "a_b_c");
});

/* ---------- applyNamespacePolicy ----------------------------------- */

test("applyNamespacePolicy: shared / undefined returns base unchanged", () => {
  assert.equal(
    applyNamespacePolicy({ baseName: "docs", policy: "shared", tenantSlug: "acme" }),
    "docs"
  );
  assert.equal(
    applyNamespacePolicy({ baseName: "docs", policy: undefined, tenantSlug: "acme" }),
    "docs"
  );
});

test("applyNamespacePolicy: by-tenant appends sanitised tenant slug", () => {
  assert.equal(
    applyNamespacePolicy({
      baseName: "docs",
      policy: "by-tenant",
      tenantSlug: "Tenant-A"
    }),
    "docs_tenant_a"
  );
});

test("applyNamespacePolicy: by-tenant degrades to base when no tenantSlug (cluster-admin context)", () => {
  assert.equal(
    applyNamespacePolicy({ baseName: "docs", policy: "by-tenant" }),
    "docs"
  );
});

test("applyNamespacePolicy: by-tenant-env requires BOTH; missing either degrades to base", () => {
  assert.equal(
    applyNamespacePolicy({
      baseName: "docs",
      policy: "by-tenant-env",
      tenantSlug: "acme",
      environmentName: "prod"
    }),
    "docs_acme_prod"
  );
  // missing env -> degrade
  assert.equal(
    applyNamespacePolicy({
      baseName: "docs",
      policy: "by-tenant-env",
      tenantSlug: "acme"
    }),
    "docs"
  );
  // missing tenant -> degrade
  assert.equal(
    applyNamespacePolicy({
      baseName: "docs",
      policy: "by-tenant-env",
      environmentName: "prod"
    }),
    "docs"
  );
});

test("applyNamespacePolicy: by-env appends sanitised env name", () => {
  assert.equal(
    applyNamespacePolicy({
      baseName: "docs",
      policy: "by-env",
      environmentName: "Production"
    }),
    "docs_production"
  );
});

test("applyNamespacePolicy: unknown policy preserves base (resolver-time safety net)", () => {
  assert.equal(
    applyNamespacePolicy({
      baseName: "docs",
      // Deliberately bypass the type system — we want to prove the
      // switch's default arm doesn't fabricate a suffix from a bogus
      // policy that somehow snuck past the API validator.
      policy: "by-region" as unknown as "shared",
      tenantSlug: "acme"
    }),
    "docs"
  );
});

/* ---------- validateNamespacePolicyForScope ------------------------ */

test("validate: undefined / null / 'shared' is always ok", () => {
  for (const scope of ["global", "tenant", "environment"] as const) {
    assert.ok(validateNamespacePolicyForScope(scope, undefined).ok);
    assert.ok(validateNamespacePolicyForScope(scope, null).ok);
    assert.ok(validateNamespacePolicyForScope(scope, "shared").ok);
  }
});

test("validate: global allows shared/by-tenant/by-tenant-env, rejects by-env", () => {
  assert.ok(validateNamespacePolicyForScope("global", "by-tenant").ok);
  assert.ok(validateNamespacePolicyForScope("global", "by-tenant-env").ok);
  const r = validateNamespacePolicyForScope("global", "by-env");
  assert.equal(r.ok, false);
  assert.match(r.message!, /not allowed on a global-scope/);
});

test("validate: tenant allows shared/by-env, rejects by-tenant/by-tenant-env", () => {
  assert.ok(validateNamespacePolicyForScope("tenant", "by-env").ok);
  assert.equal(validateNamespacePolicyForScope("tenant", "by-tenant").ok, false);
  assert.equal(validateNamespacePolicyForScope("tenant", "by-tenant-env").ok, false);
});

test("validate: environment only allows shared", () => {
  assert.equal(validateNamespacePolicyForScope("environment", "by-tenant").ok, false);
  assert.equal(validateNamespacePolicyForScope("environment", "by-env").ok, false);
  assert.equal(validateNamespacePolicyForScope("environment", "by-tenant-env").ok, false);
  assert.ok(validateNamespacePolicyForScope("environment", "shared").ok);
});

test("validate: non-string policy returns a helpful message", () => {
  const r = validateNamespacePolicyForScope("global", 42);
  assert.equal(r.ok, false);
  assert.match(r.message!, /must be a string/);
});
