/**
 * ADR-0039: the credential-grant bridge. Two halves:
 *  - buildConnectionCredentialRuntimeOptions: mint a grant bounded by the run
 *    deadline, and revoke a run's grants.
 *  - redeemConnectionCredentialGrant: validate a token (unknown / revoked /
 *    expired), re-resolve + re-materialise, stamp the redemption.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildConnectionCredentialRuntimeOptions,
  redeemConnectionCredentialGrant,
  CONNECTION_CREDENTIAL_REFRESH_PATH,
  registerConnectionDriver,
  resetConnectionRegistry,
  type ResolvedExternalConnection
} from "../src/index.ts";
import type {
  ConnectionCredentialGrantRow,
  ConnectionCredentialGrantRepository
} from "../../db/src/types.ts";

/** Minimal in-memory grant repo (the real one is unit-tested in @ragdoll/db). */
function fakeGrants(seed: ConnectionCredentialGrantRow[] = []): ConnectionCredentialGrantRepository & {
  rows: Map<string, ConnectionCredentialGrantRow>;
} {
  const rows = new Map<string, ConnectionCredentialGrantRow>();
  for (const r of seed) rows.set(r.token, { ...r });
  return {
    rows,
    async create(row) {
      rows.set(row.token, { ...row });
      return { ...row };
    },
    async getByToken(token) {
      const r = rows.get(token);
      return r ? { ...r } : undefined;
    },
    async recordRedemption(token, at) {
      const r = rows.get(token);
      if (r) {
        r.redeemCount += 1;
        r.lastRedeemedAt = at;
      }
    },
    async revokeForExecution(executionId, at) {
      let n = 0;
      for (const r of rows.values()) {
        if (r.executionId === executionId && !r.revokedAt) {
          r.revokedAt = at;
          n += 1;
        }
      }
      return n;
    },
    async deleteExpired() {
      return 0;
    }
  };
}

const resolvedConn: ResolvedExternalConnection = {
  id: "c1",
  slug: "crm-identity",
  kind: "identity_http",
  options: { region: "eu" },
  cascadeReason: "tenant"
};

test("issueConnectionRefreshGrant writes a grant and bounds expiry by the run deadline", async () => {
  const grants = fakeGrants();
  const opts = buildConnectionCredentialRuntimeOptions({
    grants,
    callbackBaseUrl: "https://api.internal/"
  });
  const deadline = new Date(Date.now() + 5 * 60 * 1000); // 5 min out, well under 1h cap
  const grant = await opts.issueConnectionRefreshGrant({
    executionId: "exec-1",
    nodeId: "n1",
    tenantId: "tenant-a",
    environment: "prod",
    connectionSlug: "crm-identity",
    deadline
  });
  assert.ok(grant);
  assert.equal(grant.url, `https://api.internal${CONNECTION_CREDENTIAL_REFRESH_PATH}`);
  assert.ok(grant.token.length >= 32);
  // Expiry bounded by the deadline (not the 1h ceiling).
  assert.equal(new Date(grant.expiresAt!).getTime(), deadline.getTime());
  const row = grants.rows.get(grant.token)!;
  assert.equal(row.executionId, "exec-1");
  assert.equal(row.connectionSlug, "crm-identity");
  assert.equal(row.redeemCount, 0);
  assert.equal(row.revokedAt, null);
});

test("issueConnectionRefreshGrant caps expiry at the TTL ceiling when there is no deadline", async () => {
  const grants = fakeGrants();
  const opts = buildConnectionCredentialRuntimeOptions({
    grants,
    callbackBaseUrl: "https://api.internal",
    maxTtlMs: 1000
  });
  const before = Date.now();
  const grant = await opts.issueConnectionRefreshGrant({
    executionId: "exec-1",
    nodeId: "n1",
    tenantId: "t",
    environment: "prod",
    connectionSlug: "crm-identity"
  });
  const exp = new Date(grant!.expiresAt!).getTime();
  assert.ok(exp >= before + 1000 && exp <= Date.now() + 1000 + 50);
});

test("revokeConnectionRefreshGrants revokes every grant for the execution", async () => {
  const grants = fakeGrants();
  const opts = buildConnectionCredentialRuntimeOptions({
    grants,
    callbackBaseUrl: "https://api.internal"
  });
  await opts.issueConnectionRefreshGrant({
    executionId: "exec-1", nodeId: "a", tenantId: "t", environment: "prod", connectionSlug: "s"
  });
  await opts.issueConnectionRefreshGrant({
    executionId: "exec-1", nodeId: "b", tenantId: "t", environment: "prod", connectionSlug: "s"
  });
  await opts.revokeConnectionRefreshGrants("exec-1");
  for (const r of grants.rows.values()) assert.ok(r.revokedAt, "all grants revoked");
});

function grantRow(over: Partial<ConnectionCredentialGrantRow>): ConnectionCredentialGrantRow {
  return {
    id: "g1",
    token: "tok",
    executionId: "exec-1",
    nodeId: "n1",
    tenantId: "tenant-a",
    environment: "prod",
    connectionSlug: "crm-identity",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revokedAt: null,
    redeemCount: 0,
    lastRedeemedAt: null,
    createdAt: new Date().toISOString(),
    ...over
  };
}

const okResolver = {
  async resolve() {
    return resolvedConn;
  }
};

test("redeem: unknown token", async () => {
  const res = await redeemConnectionCredentialGrant({
    token: "nope",
    grants: fakeGrants(),
    resolver: okResolver
  });
  assert.equal(res.status, "unknown_token");
});

test("redeem: revoked and expired grants are refused", async () => {
  const revoked = await redeemConnectionCredentialGrant({
    token: "tok",
    grants: fakeGrants([grantRow({ revokedAt: new Date().toISOString() })]),
    resolver: okResolver
  });
  assert.equal(revoked.status, "revoked");

  const expired = await redeemConnectionCredentialGrant({
    token: "tok",
    grants: fakeGrants([grantRow({ expiresAt: new Date(Date.now() - 1000).toISOString() })]),
    resolver: okResolver
  });
  assert.equal(expired.status, "expired");
});

test("redeem: no connection / not materializable", async () => {
  resetConnectionRegistry();
  // Resolver returns nothing → no_connection.
  const none = await redeemConnectionCredentialGrant({
    token: "tok",
    grants: fakeGrants([grantRow({})]),
    resolver: { async resolve() { return undefined; } }
  });
  assert.equal(none.status, "no_connection");

  // Resolver returns a conn but the driver has no materialize hook.
  registerConnectionDriver("identity_http", { async create() { return {}; } });
  const nm = await redeemConnectionCredentialGrant({
    token: "tok",
    grants: fakeGrants([grantRow({})]),
    resolver: okResolver
  });
  assert.equal(nm.status, "not_materializable");
  resetConnectionRegistry();
});

test("redeem: ok re-materialises a fresh credential and records the redemption", async () => {
  resetConnectionRegistry();
  registerConnectionDriver("identity_http", {
    async create() { return {}; },
    async materializeExternalCredential() {
      return { value: "fresh-token", expiresAt: "2030-01-01T00:00:00.000Z" };
    }
  });
  const grants = fakeGrants([grantRow({})]);
  const res = await redeemConnectionCredentialGrant({ token: "tok", grants, resolver: okResolver });
  assert.equal(res.status, "ok");
  assert.equal(res.credential?.value, "fresh-token");
  assert.equal(grants.rows.get("tok")!.redeemCount, 1);
  assert.ok(grants.rows.get("tok")!.lastRedeemedAt);
  resetConnectionRegistry();
});

test("ADR-0040: issueConnectionRefreshGrant persists the driver's refreshContext on the grant", async () => {
  const grants = fakeGrants();
  const opts = buildConnectionCredentialRuntimeOptions({
    grants,
    callbackBaseUrl: "https://api.internal"
  });
  const grant = await opts.issueConnectionRefreshGrant({
    executionId: "exec-1",
    nodeId: "n1",
    tenantId: "tenant-a",
    environment: "prod",
    connectionSlug: "crm-identity",
    refreshContext: { tenantRef: "acme", credId: "cred-7" }
  });
  const row = grants.rows.get(grant!.token)!;
  assert.deepEqual(row.materializationContext, { tenantRef: "acme", credId: "cred-7" });
});

test("ADR-0040: a connection-only grant persists null materializationContext", async () => {
  const grants = fakeGrants();
  const opts = buildConnectionCredentialRuntimeOptions({
    grants,
    callbackBaseUrl: "https://api.internal"
  });
  const grant = await opts.issueConnectionRefreshGrant({
    executionId: "exec-1",
    nodeId: "n1",
    tenantId: "t",
    environment: "prod",
    connectionSlug: "crm-identity"
  });
  assert.equal(grants.rows.get(grant!.token)!.materializationContext, null);
});

test("ADR-0040: redeem replays the persisted context into the hook and strips refreshContext from the wire credential", async () => {
  resetConnectionRegistry();
  let seenRefreshContext: Record<string, unknown> | undefined = "unset" as never;
  let seenConfigEmpty = false;
  registerConnectionDriver("identity_http", {
    async create() { return {}; },
    async materializeExternalCredential(_c, context) {
      seenRefreshContext = context?.refreshContext;
      seenConfigEmpty =
        !!context && Object.keys(context.config).length === 0 &&
        Object.keys(context.inputs).length === 0;
      const tenantRef = context?.refreshContext?.tenantRef as string | undefined;
      return {
        value: `fresh-${tenantRef}`,
        expiresAt: "2030-01-01T00:00:00.000Z",
        refreshContext: context?.refreshContext // driver echoes it; must be stripped
      };
    }
  });
  const grants = fakeGrants([
    grantRow({ materializationContext: { tenantRef: "acme", credId: "cred-7" } })
  ]);
  const res = await redeemConnectionCredentialGrant({ token: "tok", grants, resolver: okResolver });
  assert.equal(res.status, "ok");
  // Driver re-resolved from the replayed selectors.
  assert.equal(res.credential?.value, "fresh-acme");
  assert.deepEqual(seenRefreshContext, { tenantRef: "acme", credId: "cred-7" });
  // The callback path carries no live node config / input ports.
  assert.ok(seenConfigEmpty, "config + inputs are empty on the refresh path");
  // refreshContext is core-only and must NOT be returned to the sidecar.
  assert.ok(
    !("refreshContext" in (res.credential ?? {})),
    "refreshContext stripped from the wire credential"
  );
  resetConnectionRegistry();
});
