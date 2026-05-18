import test from "node:test";
import assert from "node:assert/strict";
import {
  SECRET_SCOPES,
  describeRef,
  formToRef,
  isSecretScope,
  refToForm,
  validateSecretRefForm
} from "../src/lib/secretRef.ts";
import type { SecretRef } from "../src/lib/types.ts";

test("SECRET_SCOPES is the documented set in display order", () => {
  assert.deepEqual(SECRET_SCOPES, [
    "tenant",
    "environment",
    "global",
    "tenant_provider",
    "datasource"
  ]);
  assert.equal(isSecretScope("tenant"), true);
  assert.equal(isSecretScope("nope"), false);
  assert.equal(isSecretScope(7), false);
});

test("refToForm maps a SecretRef into all-string form fields", () => {
  const ref: SecretRef = {
    scope: "tenant_provider",
    key: "llm.api_key",
    provider: "openai",
    version: "3"
  };
  assert.deepEqual(refToForm(ref), {
    scope: "tenant_provider",
    key: "llm.api_key",
    provider: "openai",
    version: "3"
  });
  // missing/empty -> sane defaults (tenant scope, blank strings)
  assert.deepEqual(refToForm(undefined), {
    scope: "tenant",
    key: "",
    provider: "",
    version: ""
  });
  // unknown scope falls back to tenant
  assert.equal(refToForm({ scope: "weird" as never, key: "k" }).scope, "tenant");
});

test("formToRef omits blank optional fields and trims", () => {
  assert.deepEqual(
    formToRef({ scope: "tenant", key: "  llm.api_key  ", provider: "", version: "" }),
    { scope: "tenant", key: "llm.api_key" }
  );
  assert.deepEqual(
    formToRef({
      scope: "tenant_provider",
      key: "k",
      provider: "openai",
      version: "2"
    }),
    { scope: "tenant_provider", key: "k", provider: "openai", version: "2" }
  );
  // unknown scope is normalized to tenant on the way out too
  assert.equal(
    formToRef({ scope: "bogus", key: "k", provider: "", version: "" }).scope,
    "tenant"
  );
});

test("refToForm <-> formToRef round-trips a full ref", () => {
  const ref: SecretRef = {
    scope: "environment",
    key: "db.password",
    provider: "postgres",
    version: "5"
  };
  assert.deepEqual(formToRef(refToForm(ref)), ref);
});

test("validateSecretRefForm enforces key + scope + provider rule", () => {
  assert.deepEqual(
    validateSecretRefForm({ scope: "tenant", key: "k", provider: "", version: "" }),
    { valid: true, errors: [] }
  );
  const noKey = validateSecretRefForm({
    scope: "tenant",
    key: "  ",
    provider: "",
    version: ""
  });
  assert.equal(noKey.valid, false);
  assert.ok(noKey.errors.some((e) => /key is required/i.test(e)));

  const badScope = validateSecretRefForm({
    scope: "nope",
    key: "k",
    provider: "",
    version: ""
  });
  assert.equal(badScope.valid, false);
  assert.ok(badScope.errors.some((e) => /Unknown scope/.test(e)));

  // tenant_provider requires a provider
  const noProvider = validateSecretRefForm({
    scope: "tenant_provider",
    key: "k",
    provider: "",
    version: ""
  });
  assert.equal(noProvider.valid, false);
  assert.ok(noProvider.errors.some((e) => /requires a provider/.test(e)));
});

test("describeRef gives a compact human summary", () => {
  assert.equal(
    describeRef({ scope: "tenant", key: "llm.api_key" }),
    "tenant · llm.api_key"
  );
  assert.equal(
    describeRef({
      scope: "tenant_provider",
      key: "k",
      provider: "openai",
      version: "2"
    }),
    "tenant_provider · k · provider=openai · v2"
  );
  assert.equal(describeRef(undefined), "tenant · (unset)");
});
