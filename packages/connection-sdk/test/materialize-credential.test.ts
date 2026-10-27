/**
 * ADR-0039: the opt-in credential-materialisation seam. `materializeExternalCredential`
 * runs a driver's hook so core can project a connection into a serialisable
 * credential for a sidecar — returning `undefined` for in-process-only drivers
 * (no hook) and throwing when the kind has no driver at all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  registerConnectionDriver,
  resetConnectionRegistry,
  materializeExternalCredential,
  type ConnectionDriver,
  type CredentialMaterializationContext,
  type ResolvedExternalConnection
} from "../src/index.ts";

function conn(kind: string): ResolvedExternalConnection {
  return {
    id: "c1",
    slug: "crm-identity",
    kind,
    secret: "stored-dsn",
    options: { region: "eu" },
    cascadeReason: "tenant"
  };
}

test("runs the driver's materializeExternalCredential hook when it opts in", async () => {
  resetConnectionRegistry();
  const driver: ConnectionDriver = {
    async create() {
      return {};
    },
    async materializeExternalCredential(c) {
      // The hook sees the full resolved connection (incl. options).
      return {
        value: `token-for-${c.slug}`,
        headers: { Authorization: `Bearer token-for-${c.slug}` },
        expiresAt: "2030-01-01T00:00:00.000Z",
        options: { region: c.options.region }
      };
    }
  };
  registerConnectionDriver("identity_http", driver);
  const cred = await materializeExternalCredential(conn("identity_http"));
  assert.equal(cred?.value, "token-for-crm-identity");
  assert.deepEqual(cred?.headers, { Authorization: "Bearer token-for-crm-identity" });
  assert.equal(cred?.expiresAt, "2030-01-01T00:00:00.000Z");
  assert.deepEqual(cred?.options, { region: "eu" });
  resetConnectionRegistry();
});

test("ADR-0040: forwards the run context to the hook and strips refreshContext onto the return", async () => {
  resetConnectionRegistry();
  let seen: CredentialMaterializationContext | undefined;
  const driver: ConnectionDriver = {
    async create() {
      return {};
    },
    async materializeExternalCredential(c, context) {
      seen = context;
      // Resolve the per-run credential from the run context (config OR an input
      // port), not from the connection — so ONE connection serves many tenants.
      const tenantRef =
        (context?.config.tenantRef as string | undefined) ??
        (context?.inputs.tenantRef as string | undefined) ??
        "none";
      return {
        value: `token-${c.slug}-${tenantRef}`,
        expiresAt: "2030-01-01T00:00:00.000Z",
        refreshContext: { tenantRef }
      };
    }
  };
  registerConnectionDriver("identity_http", driver);
  const cred = await materializeExternalCredential(conn("identity_http"), {
    tenantId: "tenant-a",
    environment: "prod",
    executionId: "exec-1",
    nodeId: "n1",
    requestId: "req-1",
    config: { tenantRef: "acme" },
    inputs: { tenantRef: "ignored-because-config-wins" }
  });
  assert.equal(cred?.value, "token-crm-identity-acme");
  assert.deepEqual(cred?.refreshContext, { tenantRef: "acme" });
  // The hook received the full run context.
  assert.equal(seen?.tenantId, "tenant-a");
  assert.equal(seen?.nodeId, "n1");
  assert.deepEqual(seen?.config, { tenantRef: "acme" });
  resetConnectionRegistry();
});

test("ADR-0040: a driver resolves from an input port when config has no selector", async () => {
  resetConnectionRegistry();
  const driver: ConnectionDriver = {
    async create() {
      return {};
    },
    async materializeExternalCredential(_c, context) {
      const tenantRef = context?.inputs.tenantRef as string | undefined;
      return { value: `token-${tenantRef}`, refreshContext: { tenantRef } };
    }
  };
  registerConnectionDriver("identity_http", driver);
  const cred = await materializeExternalCredential(conn("identity_http"), {
    tenantId: "tenant-a",
    environment: "prod",
    executionId: "exec-1",
    nodeId: "n1",
    config: {},
    inputs: { tenantRef: "from-port" }
  });
  assert.equal(cred?.value, "token-from-port");
  resetConnectionRegistry();
});

test("returns undefined for an in-process-only driver (no hook)", async () => {
  resetConnectionRegistry();
  const driver: ConnectionDriver = {
    async create() {
      return {};
    }
    // no materializeExternalCredential — pooled/live-client driver
  };
  registerConnectionDriver("postgres", driver);
  const cred = await materializeExternalCredential(conn("postgres"));
  assert.equal(cred, undefined);
  resetConnectionRegistry();
});

test("throws when no driver is registered for the kind", async () => {
  resetConnectionRegistry();
  await assert.rejects(
    () => materializeExternalCredential(conn("nonexistent")),
    /no driver registered for connection kind "nonexistent"/
  );
});
