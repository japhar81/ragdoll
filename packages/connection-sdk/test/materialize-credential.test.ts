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
