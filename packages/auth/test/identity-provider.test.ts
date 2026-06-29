/**
 * Identity-provider SPI (ADR 0035): registry resolution, the built-in OIDC +
 * SAML adapters' input validation, and the boot loader's handling of every
 * custom-module export shape. Network-touching paths (OIDC discovery, SAML
 * verification) are out of scope here — those belong to oidc/saml.test — so
 * we exercise the synchronous validation + wiring the SPI owns.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultIdentityProviderRegistry,
  IdentityProviderRegistry,
  loadIdentityProviderModule,
  type IdentityProvider,
  type SsoProviderInstance
} from "../src/identity-provider.ts";

const fakeProvider = (kinds: string[], tag: string): IdentityProvider => ({
  kinds,
  build: (): SsoProviderInstance => ({
    start: async () => `https://idp.test/${tag}/authorize`,
    callback: async () => ({ subject: `${tag}-subject`, email: `${tag}@test` })
  })
});

test("default registry resolves the built-in oidc + saml kinds", () => {
  const r = defaultIdentityProviderRegistry();
  assert.deepEqual(r.kinds().sort(), ["oidc", "saml"]);
  assert.ok(r.resolve("oidc"));
  assert.ok(r.resolve("saml"));
  assert.equal(r.resolve("ldap"), undefined);
});

test("registry.build throws a clear error for an unregistered kind", () => {
  const r = defaultIdentityProviderRegistry();
  assert.throws(
    () => r.build({ kind: "ldap", config: {} }),
    /no identity provider registered for kind "ldap"/
  );
});

test("built-in oidc adapter validates the callback before any network call", () => {
  const r = defaultIdentityProviderRegistry();
  const sso = r.build({ kind: "oidc", config: { issuer: "https://i.test", clientId: "c" } });
  // Missing authorization code → synchronous rejection (no discovery fetch).
  return assert.rejects(
    () => sso.callback({ redirectUri: "https://app/cb", expectedNonce: "n" }),
    /oidc callback requires an authorization code/
  );
});

test("built-in saml adapter requires a SAMLResponse on callback", () => {
  const r = defaultIdentityProviderRegistry();
  const sso = r.build({ kind: "saml", config: { entryPoint: "https://i", issuer: "x" } });
  return assert.rejects(
    () => sso.callback({ redirectUri: "https://app/cb", expectedNonce: "n" }),
    /saml callback requires a SAMLResponse/
  );
});

test("a custom provider can ADD a new kind", async () => {
  const r = defaultIdentityProviderRegistry();
  r.register(fakeProvider(["ldap"], "ldap"));
  assert.ok(r.resolve("ldap"));
  const sso = r.build({ kind: "ldap", config: {} });
  assert.equal(await sso.start({ redirectUri: "x", state: "s", nonce: "n" }), "https://idp.test/ldap/authorize");
  assert.deepEqual(await sso.callback({ redirectUri: "x", expectedNonce: "n" }), {
    subject: "ldap-subject",
    email: "ldap@test"
  });
});

test("a custom provider can OVERRIDE a built-in kind (last registration wins)", () => {
  const r = defaultIdentityProviderRegistry();
  r.register(fakeProvider(["oidc"], "custom-oidc"));
  const sso = r.build({ kind: "oidc", config: {} });
  return sso.start({ redirectUri: "x", state: "s", nonce: "n" }).then((url) =>
    assert.equal(url, "https://idp.test/custom-oidc/authorize")
  );
});

test("loadIdentityProviderModule: unset moduleUrl is a no-op (built-ins only)", async () => {
  const r = defaultIdentityProviderRegistry();
  const out = await loadIdentityProviderModule(r, undefined);
  assert.equal(out.loaded, false);
  assert.deepEqual(out.kinds.sort(), ["oidc", "saml"]);
});

test("loadIdentityProviderModule: default-export IdentityProvider is registered", async () => {
  const r = new IdentityProviderRegistry();
  const importer = async () => ({ default: fakeProvider(["ldap"], "ldap") });
  const out = await loadIdentityProviderModule(r, "@acme/ldap", importer);
  assert.equal(out.loaded, true);
  assert.deepEqual(out.kinds, ["ldap"]);
});

test("loadIdentityProviderModule: registrar-function export gets the registry", async () => {
  const r = defaultIdentityProviderRegistry();
  const importer = async () => ({
    default: (reg: IdentityProviderRegistry) => {
      reg.register(fakeProvider(["ldap", "scim"], "multi"));
    }
  });
  const out = await loadIdentityProviderModule(r, "/opt/p.js", importer);
  assert.equal(out.loaded, true);
  assert.deepEqual(out.kinds.sort(), ["ldap", "oidc", "saml", "scim"]);
});

test("loadIdentityProviderModule: array export registers each provider", async () => {
  const r = new IdentityProviderRegistry();
  const importer = async () => ({
    default: [fakeProvider(["ldap"], "a"), fakeProvider(["scim"], "b")]
  });
  const out = await loadIdentityProviderModule(r, "x", importer);
  assert.deepEqual(out.kinds.sort(), ["ldap", "scim"]);
});

test("loadIdentityProviderModule: a bad export throws (fail-closed)", async () => {
  const r = new IdentityProviderRegistry();
  const importer = async () => ({ default: { not: "a provider" } });
  await assert.rejects(
    () => loadIdentityProviderModule(r, "x", importer),
    /not an IdentityProvider/
  );
});
