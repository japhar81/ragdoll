/**
 * OpenSearch connection driver (storage-drivers.ts) — the create/probe path
 * used by "Test connection". Regression for the AOSS report: an IAM-secured /
 * Serverless connection must be probed with a SIGNED request against an
 * endpoint the serverless API actually exposes, or "Test connection" 403s even
 * when indexing works.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { opensearchConnectionDriver } from "../src/plugins/storage-drivers.ts";

type ConnLike = Parameters<typeof opensearchConnectionDriver.driver.create>[0];
type Handle = { url: string; username?: string; password?: string; aws?: Record<string, unknown> };
const create = (c: ConnLike) =>
  opensearchConnectionDriver.driver.create(c) as Promise<Handle>;

function conn(options: Record<string, unknown>, secret?: string): ConnLike {
  return {
    id: "c1",
    slug: "os",
    kind: "opensearch",
    options,
    secret,
    cascadeReason: "global"
  } as ConnLike;
}

/** Swap global fetch for a capturing stub; returns the captured calls + a restore. */
function stubFetch(): {
  calls: { url: string; headers: Record<string, string> }[];
  restore: () => void;
} {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    return {
      ok: true,
      status: 200,
      text: async () => "[]"
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = orig) };
}

test("create: url + AWS options → handle carries the SigV4 config", async () => {
  const client = await create(
    conn({
      url: "https://abc.us-east-1.aoss.amazonaws.com",
      awsRegion: "us-east-1",
      awsService: "aoss"
    })
  );
  assert.equal(client.url, "https://abc.us-east-1.aoss.amazonaws.com");
  assert.deepEqual(client.aws, {
    region: "us-east-1",
    service: "aoss",
    accessKeyId: undefined,
    secretAccessKey: undefined,
    sessionToken: undefined
  });
});

test("create: no AWS options → no SigV4 (basic-auth path)", async () => {
  const client = await create(
    conn({ host: "os.internal", port: 9200 })
  );
  assert.equal(client.aws, undefined);
  assert.equal(client.url, "http://os.internal:9200");
});

test("probe: AOSS connection issues a SIGNED request to _cat/indices", async () => {
  const { calls, restore } = stubFetch();
  try {
    const client = await create(
      conn({
        url: "https://abc.us-east-1.aoss.amazonaws.com",
        awsRegion: "us-east-1",
        awsService: "aoss",
        // Explicit creds so the credential chain doesn't need env in CI.
        awsAccessKeyId: "AKIA_TEST",
        awsSecretAccessKey: "secret"
      })
    );
    await opensearchConnectionDriver.driver.probe!(client);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes("/_cat/indices"), calls[0].url);
    assert.ok(
      !calls[0].url.includes("_cluster/health"),
      "aoss must not use the cluster API"
    );
    const auth = calls[0].headers["authorization"] ?? calls[0].headers["Authorization"];
    assert.ok(
      typeof auth === "string" && auth.startsWith("AWS4-HMAC-SHA256"),
      `probe must be SigV4-signed, got: ${auth}`
    );
  } finally {
    restore();
  }
});

test("probe: non-AWS connection uses an unsigned _cluster/health check", async () => {
  const { calls, restore } = stubFetch();
  try {
    const client = await create(
      conn({ host: "os.internal", port: 9200, scheme: "http" })
    );
    await opensearchConnectionDriver.driver.probe!(client);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes("/_cluster/health"), calls[0].url);
    const auth = calls[0].headers["authorization"] ?? calls[0].headers["Authorization"];
    assert.equal(auth, undefined, "no basic creds → no auth header");
  } finally {
    restore();
  }
});
