/**
 * wazuh driver + pull plugins — unit tests.
 *
 * Coverage:
 *   - parseWazuhSecret: every accepted format (JSON token, JSON basic,
 *     user:pass, raw token) → correct shape; empty/null → actionable
 *     error
 *   - buildWazuhBaseUrl: hostname → https + port; full URL passes
 *     through; missing baseUrl → error
 *   - driver.create(): basic-auth path calls /security/user/authenticate
 *     on first request and caches the token until expiry
 *   - driver: 401 mid-flight triggers ONE refresh + retry; subsequent
 *     401 surfaces as an error
 *   - driver: static-token path skips authenticate entirely
 *   - probe(): hits /agents?limit=1
 *   - verifyTls=false threads `rejectUnauthorized: false` through to
 *     the fetch implementation; default true does not
 *   - No credentials, tokens, or password fragments appear in error
 *     messages (token leak guard)
 *   - wazuh_agents_pull: walks pagination until items.length < limit;
 *     respects select / q / sort; reports `truncated` when capped
 *   - wazuh_syscollector_pull: empty inventory per agent → goes to
 *     metadata.missingAgents, batch keeps going; 404 = empty (not
 *     fatal); non-404 errors land in perItemErrors; scanTime carried
 *
 * Test harness: `__setWazuhFetchForTests` swaps the fetch
 * implementation for a recorded queue. Each test restores via the
 * try/finally in `withFakeFetch`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWazuhBaseUrl,
  parseWazuhSecret,
  requireWazuhConnection,
  wazuhAgentsPullPlugin,
  wazuhConnectionDriver,
  wazuhSyscollectorPullPlugin,
  wazuhVulnsPullPlugin,
  __setWazuhFetchForTests,
  type WazuhFetch,
  type WazuhHandle
} from "../src/wazuh.ts";
import {
  registerConnectionDriver,
  resetConnectionRegistry,
  acquireClient,
  type ResolvedExternalConnection
} from "../../../packages/external-connections/src/index.ts";

// ---------------------------------------------------------------------------
// Tiny fake-fetch harness
// ---------------------------------------------------------------------------

interface FakeCall {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  rejectUnauthorized?: boolean;
}

interface FakeResponse {
  status: number;
  body: unknown;
}

function fakeFetch(
  routes: Array<{
    matches: (url: string, method: string) => boolean;
    respond: () => FakeResponse | Promise<FakeResponse>;
  }>
): { fetch: WazuhFetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const f: WazuhFetch = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
      rejectUnauthorized: init.rejectUnauthorized
    });
    for (const route of routes) {
      if (route.matches(url, (init.method ?? "GET").toUpperCase())) {
        const r = await route.respond();
        return {
          status: r.status,
          ok: r.status >= 200 && r.status < 300,
          json: async () => r.body,
          text: async () => JSON.stringify(r.body)
        };
      }
    }
    return {
      status: 599,
      ok: false,
      json: async () => ({ error: "no fake route matched", url }),
      text: async () => `no fake route matched: ${url}`
    };
  };
  return { fetch: f, calls };
}

async function withFakeFetch<T>(
  routes: Parameters<typeof fakeFetch>[0],
  body: (calls: FakeCall[]) => Promise<T>
): Promise<T> {
  const { fetch: f, calls } = fakeFetch(routes);
  __setWazuhFetchForTests(f);
  try {
    return await body(calls);
  } finally {
    __setWazuhFetchForTests(null);
  }
}

function fakeWazuhConn(
  slug = "test-wazuh",
  options: Record<string, unknown> = {},
  secret = '{"username":"admin","password":"hunter2"}'
): ResolvedExternalConnection {
  return {
    id: `conn-${slug}`,
    slug,
    kind: "wazuh",
    options: { baseUrl: "wazuh.local", port: 55000, ...options },
    secret,
    cascadeReason: "tenant"
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("parseWazuhSecret: JSON basic creds", () => {
  const c = parseWazuhSecret('{"username":"u","password":"p"}');
  assert.deepEqual(c, { kind: "basic", username: "u", password: "p" });
});

test("parseWazuhSecret: JSON token wins over basic creds in same blob", () => {
  const c = parseWazuhSecret('{"token":"t","username":"u","password":"p"}');
  assert.deepEqual(c, { kind: "token", token: "t" });
});

test("parseWazuhSecret: user:pass form", () => {
  const c = parseWazuhSecret("admin:hunter2");
  assert.deepEqual(c, { kind: "basic", username: "admin", password: "hunter2" });
});

test("parseWazuhSecret: raw string treated as bearer token", () => {
  const c = parseWazuhSecret("eyJ...long.token...XYZ");
  assert.deepEqual(c, { kind: "token", token: "eyJ...long.token...XYZ" });
});

test("parseWazuhSecret: malformed JSON falls back to user:pass parse", () => {
  // Not valid JSON, contains a colon → user:pass shape.
  const c = parseWazuhSecret("{notjson:abc:def}");
  assert.equal(c.kind, "basic");
});

test("parseWazuhSecret: empty / undefined raises an actionable error naming secretRefKey", () => {
  assert.throws(() => parseWazuhSecret(undefined), /secretRefKey/);
  assert.throws(() => parseWazuhSecret(""), /secretRefKey/);
});

test("buildWazuhBaseUrl: hostname → https + port", () => {
  assert.equal(
    buildWazuhBaseUrl({ baseUrl: "wazuh.acme.com" }),
    "https://wazuh.acme.com:55000"
  );
  assert.equal(
    buildWazuhBaseUrl({ baseUrl: "wazuh.acme.com", port: 8443 }),
    "https://wazuh.acme.com:8443"
  );
});

test("buildWazuhBaseUrl: full URL passes through (trailing slash stripped)", () => {
  assert.equal(
    buildWazuhBaseUrl({ baseUrl: "https://wazuh.acme.com:55000/" }),
    "https://wazuh.acme.com:55000"
  );
  assert.equal(
    buildWazuhBaseUrl({ baseUrl: "http://test:8080" }),
    "http://test:8080"
  );
});

test("buildWazuhBaseUrl: missing baseUrl is loud", () => {
  assert.throws(() => buildWazuhBaseUrl({}), /baseUrl is required/);
  assert.throws(() => buildWazuhBaseUrl({ baseUrl: "" }), /baseUrl is required/);
});

// ---------------------------------------------------------------------------
// Driver — auth + refresh + verifyTls
// ---------------------------------------------------------------------------

test("driver: basic-auth → authenticate hop runs once, then GETs reuse the token", async () => {
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/security/user/authenticate"),
        respond: () => ({
          status: 200,
          body: { data: { token: "fresh-token" } }
        })
      },
      {
        matches: (url) => url.includes("/agents"),
        respond: () => ({
          status: 200,
          body: { data: { affected_items: [], total_affected_items: 0 } }
        })
      }
    ],
    async (calls) => {
      const conn = fakeWazuhConn();
      const handle = await wazuhConnectionDriver.driver.create(conn);
      await (handle as WazuhHandle).request("/agents?limit=1");
      await (handle as WazuhHandle).request("/agents?limit=1");
      // Exactly ONE authenticate even after two GETs.
      const authCalls = calls.filter((c) =>
        c.url.endsWith("/security/user/authenticate")
      );
      assert.equal(authCalls.length, 1);
      // Basic-auth header on the authenticate call only — never on a
      // bearer call.
      assert.match(authCalls[0].headers!.authorization, /^Basic /);
      const agentCalls = calls.filter((c) => c.url.includes("/agents"));
      assert.equal(agentCalls.length, 2);
      for (const c of agentCalls) {
        assert.equal(c.headers!.authorization, "Bearer fresh-token");
      }
    }
  );
});

test("driver: 401 mid-flight triggers ONE refresh + retry", async () => {
  let agentHits = 0;
  let authHits = 0;
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/security/user/authenticate"),
        respond: () => {
          authHits += 1;
          return { status: 200, body: { data: { token: `tok-${authHits}` } } };
        }
      },
      {
        matches: (url) => url.includes("/agents"),
        respond: () => {
          agentHits += 1;
          // First request 401s; second succeeds (the retry).
          if (agentHits === 1) {
            return { status: 401, body: { error: "expired" } };
          }
          return {
            status: 200,
            body: { data: { affected_items: [], total_affected_items: 0 } }
          };
        }
      }
    ],
    async () => {
      const conn = fakeWazuhConn();
      const handle = await wazuhConnectionDriver.driver.create(conn);
      const json = await (handle as WazuhHandle).request<{
        data: { affected_items: unknown[] };
      }>("/agents?limit=1");
      assert.deepEqual(json.data.affected_items, []);
      // Two authenticate hits: first on the cold start, second on the
      // 401 retry. Two agent hits.
      assert.equal(authHits, 2);
      assert.equal(agentHits, 2);
    }
  );
});

test("driver: persistent 401 after a refresh surfaces as an error (no infinite loop)", async () => {
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/security/user/authenticate"),
        respond: () => ({ status: 200, body: { data: { token: "tok" } } })
      },
      {
        matches: (url) => url.includes("/agents"),
        respond: () => ({ status: 401, body: { error: "expired" } })
      }
    ],
    async () => {
      const conn = fakeWazuhConn();
      const handle = await wazuhConnectionDriver.driver.create(conn);
      await assert.rejects(
        () => (handle as WazuhHandle).request("/agents?limit=1"),
        /401/
      );
    }
  );
});

test("driver: static-token secret skips authenticate entirely", async () => {
  await withFakeFetch(
    [
      {
        matches: (url) => url.includes("/agents"),
        respond: () => ({
          status: 200,
          body: { data: { affected_items: [], total_affected_items: 0 } }
        })
      }
    ],
    async (calls) => {
      const conn = fakeWazuhConn(
        "static",
        {},
        '{"token":"longlived-bearer"}'
      );
      const handle = await wazuhConnectionDriver.driver.create(conn);
      await (handle as WazuhHandle).request("/agents?limit=1");
      // No authenticate call.
      assert.equal(
        calls.filter((c) => c.url.endsWith("/authenticate")).length,
        0
      );
      // The static token is what the request used.
      assert.equal(
        calls[0].headers!.authorization,
        "Bearer longlived-bearer"
      );
    }
  );
});

test("driver: probe() hits /agents?limit=1", async () => {
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/security/user/authenticate"),
        respond: () => ({ status: 200, body: { data: { token: "t" } } })
      },
      {
        matches: (url) => url.includes("/agents"),
        respond: () => ({
          status: 200,
          body: { data: { affected_items: [], total_affected_items: 0 } }
        })
      }
    ],
    async (calls) => {
      const conn = fakeWazuhConn();
      const handle = await wazuhConnectionDriver.driver.create(conn);
      await wazuhConnectionDriver.driver.probe!(handle);
      const probeCall = calls.find((c) => c.url.includes("/agents"));
      assert.ok(probeCall);
      assert.match(probeCall!.url, /limit=1/);
    }
  );
});

test("driver: verifyTls=false threads rejectUnauthorized=false through every call; default true does not", async () => {
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/security/user/authenticate"),
        respond: () => ({ status: 200, body: { data: { token: "t" } } })
      },
      {
        matches: (url) => url.includes("/agents"),
        respond: () => ({
          status: 200,
          body: { data: { affected_items: [], total_affected_items: 0 } }
        })
      }
    ],
    async (calls) => {
      // verifyTls=false — every call gets the opt-out flag.
      const insecure = await wazuhConnectionDriver.driver.create(
        fakeWazuhConn("insecure", { verifyTls: false })
      );
      await (insecure as WazuhHandle).request("/agents?limit=1");
      for (const c of calls) {
        assert.equal(c.rejectUnauthorized, false);
      }
      calls.length = 0;
      // verifyTls=true (default) — no opt-out flag set.
      const secure = await wazuhConnectionDriver.driver.create(
        fakeWazuhConn("secure")
      );
      await (secure as WazuhHandle).request("/agents?limit=1");
      for (const c of calls) {
        assert.notEqual(c.rejectUnauthorized, false);
      }
    }
  );
});

test("driver: error messages never carry the password or the token", async () => {
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/security/user/authenticate"),
        respond: () => ({
          status: 401,
          body: { error: "Invalid credentials" }
        })
      }
    ],
    async () => {
      const conn = fakeWazuhConn(
        "leak-check",
        {},
        '{"username":"admin","password":"super-sekrit-XYZ"}'
      );
      const handle = await wazuhConnectionDriver.driver.create(conn);
      try {
        await (handle as WazuhHandle).request("/agents");
        assert.fail("expected throw");
      } catch (e) {
        const msg = String((e as Error).message);
        assert.doesNotMatch(msg, /super-sekrit-XYZ/);
        // Also belt-and-braces: the basic-auth base64 must not leak.
        const b64 = Buffer.from("admin:super-sekrit-XYZ").toString("base64");
        assert.doesNotMatch(msg, new RegExp(b64));
      }
    }
  );
});

// ---------------------------------------------------------------------------
// wazuh_agents_pull
// ---------------------------------------------------------------------------

function registerWazuhAndAcquire(slug = "wzh"): {
  conn: ResolvedExternalConnection;
} {
  resetConnectionRegistry();
  registerConnectionDriver(
    "wazuh",
    wazuhConnectionDriver.driver,
    wazuhConnectionDriver.driverManifest
  );
  return { conn: fakeWazuhConn(slug) };
}

function executeInput(
  conn: ResolvedExternalConnection,
  config: Record<string, unknown>,
  inputs: Record<string, unknown> = {}
) {
  return {
    node: { id: "test", category: "datasource" },
    plugin: { id: "x", version: "1.0.0", category: "datasource" },
    config,
    inputs,
    secrets: {},
    dataset: {
      slug: "ds",
      bindings: { wazuh: { connection: conn } }
    },
    context: {
      executionId: "ex-1",
      tenantId: "t-1",
      environment: "dev",
      resolvedConfig: {
        pipelineId: "p",
        tenantId: "t-1",
        environment: "dev",
        violations: [],
        values: {}
      }
    }
  } as unknown as Parameters<typeof wazuhAgentsPullPlugin.execute>[0];
}

test("wazuh_agents_pull: walks pagination until short page; respects select / q / sort", async () => {
  const { conn } = registerWazuhAndAcquire();
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/security/user/authenticate"),
        respond: () => ({ status: 200, body: { data: { token: "t" } } })
      },
      {
        matches: (url) => url.includes("/agents"),
        respond: async () => {
          // Implement a deterministic 3-page pagination: pages 1 and 2
          // are full (limit=2), page 3 is short (1) → stops.
          // We index off the offset query param the plugin sends.
          // (Captured via the .calls list outside; here we just count
          // how many "/agents?" calls have come in by side effect.)
          counter += 1;
          if (counter === 1)
            return {
              status: 200,
              body: {
                data: {
                  affected_items: [
                    { id: "001", name: "a1" },
                    { id: "002", name: "a2" }
                  ],
                  total_affected_items: 5
                }
              }
            };
          if (counter === 2)
            return {
              status: 200,
              body: {
                data: {
                  affected_items: [
                    { id: "003", name: "a3" },
                    { id: "004", name: "a4" }
                  ],
                  total_affected_items: 5
                }
              }
            };
          return {
            status: 200,
            body: {
              data: {
                affected_items: [{ id: "005", name: "a5" }],
                total_affected_items: 5
              }
            }
          };
        }
      }
    ],
    async (calls) => {
      let _counter = 0;
      void _counter;
      const out = await wazuhAgentsPullPlugin.execute(
        executeInput(conn, {
          limit: 2,
          select: ["id", "name"],
          q: "status=active",
          sort: "+id"
        })
      );
      const agents = (out.outputs as { agents: unknown[] }).agents;
      assert.equal(agents.length, 5);
      const meta = (out.outputs as { metadata: { pages: number; total: number; truncated: boolean } }).metadata;
      assert.equal(meta.pages, 3);
      assert.equal(meta.total, 5);
      assert.equal(meta.truncated, false);
      // Every /agents call carried the operator-supplied query params.
      const agentCalls = calls.filter((c) => c.url.includes("/agents"));
      for (const c of agentCalls) {
        assert.match(c.url, /select=id%2Cname/);
        assert.match(c.url, /q=status%3Dactive/);
        assert.match(c.url, /sort=%2Bid/);
        assert.match(c.url, /limit=2/);
      }
    }
  );
});

let counter = 0;

test("wazuh_agents_pull: maxPages cap surfaces as truncated", async () => {
  counter = 0;
  const { conn } = registerWazuhAndAcquire("trunc");
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/security/user/authenticate"),
        respond: () => ({ status: 200, body: { data: { token: "t" } } })
      },
      {
        matches: (url) => url.includes("/agents"),
        respond: () => ({
          status: 200,
          body: {
            data: {
              affected_items: [{ id: "x" }, { id: "y" }],
              total_affected_items: 1_000_000 // pretend megafleet
            }
          }
        })
      }
    ],
    async () => {
      const out = await wazuhAgentsPullPlugin.execute(
        executeInput(conn, { limit: 2, maxPages: 3 })
      );
      const meta = (out.outputs as { metadata: { pages: number; truncated: boolean } }).metadata;
      assert.equal(meta.pages, 3);
      assert.equal(meta.truncated, true);
    }
  );
});

// ---------------------------------------------------------------------------
// wazuh_syscollector_pull — empty-inventory tolerance is the headline
// ---------------------------------------------------------------------------

test("wazuh_syscollector_pull: agent with empty inventory (404) ends up in metadata.missingAgents, batch keeps going", async () => {
  counter = 0;
  const { conn } = registerWazuhAndAcquire("sysco");
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/security/user/authenticate"),
        respond: () => ({ status: 200, body: { data: { token: "t" } } })
      },
      {
        // agent 001 has hardware + os; 002 returns 404s for everything.
        matches: (url) => url.includes("/syscollector/001/hardware"),
        respond: () => ({
          status: 200,
          body: {
            data: {
              affected_items: [
                {
                  board_serial: "ABC123",
                  scan_time: "2026-06-12T10:00:00Z"
                }
              ]
            }
          }
        })
      },
      {
        matches: (url) => url.includes("/syscollector/001/os"),
        respond: () => ({
          status: 200,
          body: {
            data: {
              affected_items: [
                { hostname: "host1", scan_time: "2026-06-12T10:00:01Z" }
              ]
            }
          }
        })
      },
      {
        // 001's netiface returns affected_items=[] (200, empty) —
        // covered by the "no rows" branch.
        matches: (url) => url.includes("/syscollector/001/netiface"),
        respond: () => ({ status: 200, body: { data: { affected_items: [] } } })
      },
      {
        matches: (url) => url.includes("/syscollector/001/netaddr"),
        respond: () => ({ status: 200, body: { data: { affected_items: [] } } })
      },
      {
        // Agent 002 has NOTHING — every item 404s. Should not fail
        // the batch; should land in missingAgents.
        matches: (url) => url.includes("/syscollector/002/"),
        respond: () => ({ status: 404, body: { error: "no inventory" } })
      }
    ],
    async () => {
      const out = await wazuhSyscollectorPullPlugin.execute(
        executeInput(conn, { items: ["hardware", "os", "netiface", "netaddr"] }, {
          agentIds: ["001", "002"]
        })
      );
      const enrichment = (out.outputs as { enrichment: Array<{ agentId: string; inventory: Record<string, unknown[]>; scanTime?: string }> }).enrichment;
      const meta = (out.outputs as { metadata: { missingAgents: string[]; fetched: number; perItemErrors: unknown[] } }).metadata;
      assert.equal(enrichment.length, 1);
      assert.equal(enrichment[0].agentId, "001");
      assert.ok(enrichment[0].inventory.hardware);
      assert.ok(enrichment[0].inventory.os);
      // scanTime is the latest among the inventory rows.
      assert.equal(enrichment[0].scanTime, "2026-06-12T10:00:01Z");
      assert.deepEqual(meta.missingAgents, ["002"]);
      assert.equal(meta.fetched, 1);
      assert.equal(meta.perItemErrors.length, 0);
    }
  );
});

test("wazuh_syscollector_pull: non-404 per-item errors land in perItemErrors but don't kill the batch", async () => {
  counter = 0;
  const { conn } = registerWazuhAndAcquire("sysco-err");
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/security/user/authenticate"),
        respond: () => ({ status: 200, body: { data: { token: "t" } } })
      },
      {
        matches: (url) => url.includes("/syscollector/A/hardware"),
        respond: () => ({
          status: 200,
          body: { data: { affected_items: [{ board_serial: "x" }] } }
        })
      },
      {
        // A 500 on a single item — bubbles into perItemErrors, the
        // other items still get fetched.
        matches: (url) => url.includes("/syscollector/A/os"),
        respond: () => ({ status: 500, body: { error: "boom" } })
      },
      {
        matches: (url) => url.includes("/syscollector/A/"),
        respond: () => ({ status: 200, body: { data: { affected_items: [] } } })
      }
    ],
    async () => {
      const out = await wazuhSyscollectorPullPlugin.execute(
        executeInput(conn, {}, { agentIds: ["A"] })
      );
      const meta = (out.outputs as {
        metadata: { perItemErrors: Array<{ status?: number; item: string }> };
      }).metadata;
      assert.equal(meta.perItemErrors.length, 1);
      assert.equal(meta.perItemErrors[0].item, "os");
      assert.equal(meta.perItemErrors[0].status, 500);
      const enrichment = (out.outputs as { enrichment: unknown[] }).enrichment;
      assert.equal(enrichment.length, 1);
    }
  );
});

test("wazuh_syscollector_pull: reads agentIds off `inputs.agents` via agentIdField (chain from wazuh_agents_pull)", async () => {
  counter = 0;
  const { conn } = registerWazuhAndAcquire("sysco-chain");
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/security/user/authenticate"),
        respond: () => ({ status: 200, body: { data: { token: "t" } } })
      },
      {
        matches: (url) => url.includes("/syscollector/099/hardware"),
        respond: () => ({
          status: 200,
          body: { data: { affected_items: [{ board_serial: "Z" }] } }
        })
      },
      {
        matches: (url) => url.includes("/syscollector/099/"),
        respond: () => ({ status: 200, body: { data: { affected_items: [] } } })
      }
    ],
    async () => {
      const out = await wazuhSyscollectorPullPlugin.execute(
        executeInput(
          conn,
          { items: ["hardware", "os"] },
          { agents: [{ id: "099", name: "agent99" }] }
        )
      );
      const enrichment = (out.outputs as { enrichment: Array<{ agentId: string }> }).enrichment;
      assert.equal(enrichment[0].agentId, "099");
    }
  );
});

test("wazuh_syscollector_pull: no agent ids → empty output, no crash", async () => {
  counter = 0;
  const { conn } = registerWazuhAndAcquire("sysco-empty");
  await withFakeFetch([], async () => {
    const out = await wazuhSyscollectorPullPlugin.execute(
      executeInput(conn, {}, {})
    );
    const enrichment = (out.outputs as { enrichment: unknown[] }).enrichment;
    const meta = (out.outputs as { metadata: { fetched: number } }).metadata;
    assert.equal(enrichment.length, 0);
    assert.equal(meta.fetched, 0);
  });
});

// ---------------------------------------------------------------------------
// requireWazuhConnection — binding shape
// ---------------------------------------------------------------------------

test("requireWazuhConnection: clear error when the binding is missing", () => {
  const input = {
    dataset: { slug: "ds", bindings: {} }
  } as unknown as Parameters<typeof requireWazuhConnection>[0];
  assert.throws(
    () => requireWazuhConnection(input, "wazuh", "wazuh_agents_pull"),
    /requires a "wazuh" binding/
  );
});

test("requireWazuhConnection: clear error when the binding's kind isn't wazuh", () => {
  const input = {
    dataset: {
      slug: "ds",
      bindings: { wazuh: { connection: { kind: "qdrant", slug: "x" } } }
    }
  } as unknown as Parameters<typeof requireWazuhConnection>[0];
  assert.throws(
    () => requireWazuhConnection(input, "wazuh", "wazuh_agents_pull"),
    /expected "wazuh"/
  );
});

// ---------------------------------------------------------------------------
// driver: acquireClient cache key (sibling driver-pattern test)
// ---------------------------------------------------------------------------

test("driver: two acquires against the same connection.id return the SAME handle", async () => {
  resetConnectionRegistry();
  registerConnectionDriver(
    "wazuh",
    wazuhConnectionDriver.driver,
    wazuhConnectionDriver.driverManifest
  );
  const conn = fakeWazuhConn("shared");
  const a = await acquireClient<WazuhHandle>(conn);
  const b = await acquireClient<WazuhHandle>(conn);
  assert.strictEqual(a, b);
});

// ---------------------------------------------------------------------------
// Phase 5.2 wazuh-freshness provenance contract (ADR-0031)
//
// Every wazuh pull plugin stamps `metadata.pullId` + `metadata.pulledAt`,
// derived from `RuntimeContext.requestId`. Bulwark stamps each emitted
// row with that pair via `$$.metadata.pullId` / `$$.metadata.pulledAt`
// and gates windowed close-by-absence on "pulled CVEs/agents that were
// absent from the NEXT pull stamp." If these stop appearing in the
// envelope, bulwark's freshness windows go dark — break loud here.
// ---------------------------------------------------------------------------

function executeInputWithRequestId(
  conn: ResolvedExternalConnection,
  config: Record<string, unknown>,
  inputs: Record<string, unknown> = {},
  requestId = "req-fixed-123"
) {
  const base = executeInput(conn, config, inputs) as unknown as {
    context: { requestId?: string };
  };
  base.context.requestId = requestId;
  return base as unknown as Parameters<typeof wazuhAgentsPullPlugin.execute>[0];
}

test("wazuh_agents_pull: metadata stamps pullId (from context.requestId) + pulledAt", async () => {
  counter = 0;
  const { conn } = registerWazuhAndAcquire("prov-agents");
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/security/user/authenticate"),
        respond: () => ({ status: 200, body: { data: { token: "t" } } })
      },
      {
        matches: (url) => url.includes("/agents"),
        respond: () => ({
          status: 200,
          body: {
            data: {
              affected_items: [{ id: "001" }],
              total_affected_items: 1
            }
          }
        })
      }
    ],
    async () => {
      const out = await wazuhAgentsPullPlugin.execute(
        executeInputWithRequestId(conn, { limit: 50 }, {}, "req-AGENTS-42")
      );
      const meta = (out.outputs as {
        metadata: { pullId: string; pulledAt: string };
      }).metadata;
      assert.equal(meta.pullId, "req-AGENTS-42");
      // pulledAt is ISO-8601 — exact value depends on wall clock; just
      // assert shape.
      assert.match(meta.pulledAt, /^\d{4}-\d{2}-\d{2}T/);
    }
  );
});

test("wazuh_syscollector_pull: metadata stamps pullId + pulledAt", async () => {
  counter = 0;
  const { conn } = registerWazuhAndAcquire("prov-sysco");
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/security/user/authenticate"),
        respond: () => ({ status: 200, body: { data: { token: "t" } } })
      },
      {
        matches: (url) => url.includes("/syscollector/001/hardware"),
        respond: () => ({
          status: 200,
          body: { data: { affected_items: [{ board_serial: "S" }] } }
        })
      },
      {
        matches: (url) => url.includes("/syscollector/001/"),
        respond: () => ({ status: 200, body: { data: { affected_items: [] } } })
      }
    ],
    async () => {
      const out = await wazuhSyscollectorPullPlugin.execute(
        executeInputWithRequestId(
          conn,
          { items: ["hardware", "os"] },
          { agentIds: ["001"] },
          "req-SYSCO-99"
        )
      );
      const meta = (out.outputs as {
        metadata: { pullId: string; pulledAt: string };
      }).metadata;
      assert.equal(meta.pullId, "req-SYSCO-99");
      assert.match(meta.pulledAt, /^\d{4}-\d{2}-\d{2}T/);
      // Per-row stamping is bulwark's job (it reads
      // `$$.metadata.pullId` during projection) — the pull plugin
      // itself only stamps the metadata envelope. Sanity-check that:
      // a misguided "stamp each row in-place" would change the wire
      // contract upstream of bulwark.
      const enrichment = (out.outputs as {
        enrichment: Array<Record<string, unknown>>;
      }).enrichment;
      assert.equal(enrichment.length, 1);
      assert.equal((enrichment[0] as { pullId?: string }).pullId, undefined);
    }
  );
});

// ---------------------------------------------------------------------------
// wazuh_vulns_pull — NEW (Phase C1, Job 1). Two API variants.
// ---------------------------------------------------------------------------

test("wazuh_vulns_pull (server-api): per-agent pagination, missingAgents tolerance, 404 lands as missing", async () => {
  const { conn } = registerWazuhAndAcquire("vulns-server");
  // Three agents. A: two pages then short page. B: empty inventory
  // (200 with affected_items=[]). C: 404 (vuln detector not enabled).
  // The batch must finish; A → vulns, B + C → missingAgents.
  let aPage = 0;
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/security/user/authenticate"),
        respond: () => ({ status: 200, body: { data: { token: "t" } } })
      },
      {
        matches: (url) => url.includes("/vulnerability/A"),
        respond: () => {
          aPage += 1;
          if (aPage === 1) {
            return {
              status: 200,
              body: {
                data: {
                  affected_items: [
                    { name: "CVE-2024-0001", severity: "High" },
                    { name: "CVE-2024-0002", severity: "Medium" }
                  ],
                  total_affected_items: 3
                }
              }
            };
          }
          // Short page → terminates the loop.
          return {
            status: 200,
            body: {
              data: {
                affected_items: [{ name: "CVE-2024-0003", severity: "Low" }],
                total_affected_items: 3
              }
            }
          };
        }
      },
      {
        matches: (url) => url.includes("/vulnerability/B"),
        respond: () => ({
          status: 200,
          body: { data: { affected_items: [], total_affected_items: 0 } }
        })
      },
      {
        matches: (url) => url.includes("/vulnerability/C"),
        respond: () => ({ status: 404, body: { error: "no vuln data" } })
      }
    ],
    async (calls) => {
      const out = await wazuhVulnsPullPlugin.execute(
        executeInputWithRequestId(
          conn,
          { apiVariant: "server-api", limitPerAgent: 2 },
          { agentIds: ["A", "B", "C"] },
          "req-VULNS-1"
        )
      );
      const vulns = (out.outputs as {
        vulns: Array<{ agentId: string; vulns: Array<{ name: string }> }>;
      }).vulns;
      const meta = (out.outputs as {
        metadata: {
          pullId: string;
          pulledAt: string;
          apiVariant: string;
          fetched: number;
          totalVulns: number;
          missingAgents: string[];
          perAgentErrors: Array<{ agentId: string; status?: number }>;
        };
      }).metadata;

      assert.equal(vulns.length, 1);
      assert.equal(vulns[0].agentId, "A");
      assert.deepEqual(
        vulns[0].vulns.map((v) => v.name),
        ["CVE-2024-0001", "CVE-2024-0002", "CVE-2024-0003"]
      );

      // Empty inventory AND 404 both land in missingAgents — bulwark
      // distinguishes "absent from pull" from "errored on fetch."
      assert.deepEqual(meta.missingAgents.sort(), ["B", "C"]);
      assert.equal(meta.fetched, 1);
      assert.equal(meta.totalVulns, 3);
      assert.equal(meta.perAgentErrors.length, 0);

      // Provenance — ADR-0031 contract.
      assert.equal(meta.pullId, "req-VULNS-1");
      assert.match(meta.pulledAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(meta.apiVariant, "server-api");

      // Pagination params on A's calls.
      const aCalls = calls.filter((c) => c.url.includes("/vulnerability/A"));
      assert.equal(aCalls.length, 2);
      assert.match(aCalls[0].url, /limit=2/);
      assert.match(aCalls[0].url, /offset=0/);
      assert.match(aCalls[1].url, /offset=2/);
    }
  );
});

test("wazuh_vulns_pull (server-api): non-404 errors land in perAgentErrors, batch keeps going", async () => {
  const { conn } = registerWazuhAndAcquire("vulns-err");
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/security/user/authenticate"),
        respond: () => ({ status: 200, body: { data: { token: "t" } } })
      },
      {
        matches: (url) => url.includes("/vulnerability/OK"),
        respond: () => ({
          status: 200,
          body: {
            data: {
              affected_items: [{ name: "CVE-OK" }],
              total_affected_items: 1
            }
          }
        })
      },
      {
        matches: (url) => url.includes("/vulnerability/BOOM"),
        respond: () => ({ status: 500, body: { error: "indexer down" } })
      }
    ],
    async () => {
      const out = await wazuhVulnsPullPlugin.execute(
        executeInputWithRequestId(
          conn,
          { apiVariant: "server-api" },
          { agentIds: ["OK", "BOOM"] }
        )
      );
      const meta = (out.outputs as {
        metadata: {
          perAgentErrors: Array<{ agentId: string; status?: number }>;
          fetched: number;
          missingAgents: string[];
        };
      }).metadata;
      assert.equal(meta.perAgentErrors.length, 1);
      assert.equal(meta.perAgentErrors[0].agentId, "BOOM");
      assert.equal(meta.perAgentErrors[0].status, 500);
      // OK agent still made it through.
      assert.equal(meta.fetched, 1);
      // A 5xx is an error, NOT absence — it must not land in missingAgents.
      assert.deepEqual(meta.missingAgents, []);
    }
  );
});

// ---------------------------------------------------------------------------
// wazuh_vulns_pull — indexer variant (Wazuh 4.8+ / OpenSearch).
//
// The proven contract (bulwark direct pull, 1917 CVEs live):
//   - OpenSearch endpoint on :9200, NOT the server API on :55000
//   - HTTP Basic auth per request (server-API JWT does NOT work)
//   - Real POST /<indexPattern>/_search with a JSON DSL body
//   - _source hits surfaced verbatim
//
// These tests pin all four properties. A regression that re-routes
// the indexer path back through `authedRequest` (bearer JWT, GET-with-
// q=) fails LOUDLY here so the scheduled pipeline can't silently go
// dark again.
// ---------------------------------------------------------------------------

test("wazuh_vulns_pull (indexer): POST /<indexPattern>/_search to indexerBaseUrl with Basic auth + JSON body (the proven contract)", async () => {
  // Connection points at the server API on :55000; the indexer lives
  // at a SEPARATE host on :9200. The plugin MUST hit the latter.
  resetConnectionRegistry();
  registerConnectionDriver(
    "wazuh",
    wazuhConnectionDriver.driver,
    wazuhConnectionDriver.driverManifest
  );
  const conn = fakeWazuhConn("vulns-indexer", {
    baseUrl: "https://wazuh-server.acme.com",
    port: 55000
  });
  await withFakeFetch(
    [
      {
        matches: (url, method) =>
          method === "POST" &&
          url.startsWith("https://wazuh-indexer.acme.com:9200/") &&
          url.endsWith("/_search"),
        respond: () => ({
          status: 200,
          body: {
            hits: {
              total: { value: 2 },
              hits: [
                {
                  _source: {
                    "vulnerability.id": "CVE-2025-1234",
                    "vulnerability.severity": "Critical",
                    "package.name": "openssl"
                  }
                },
                {
                  _source: {
                    "vulnerability.id": "CVE-2025-5678",
                    "vulnerability.severity": "High",
                    "package.name": "libc"
                  }
                }
              ]
            }
          }
        })
      }
    ],
    async (calls) => {
      const out = await wazuhVulnsPullPlugin.execute(
        executeInputWithRequestId(
          conn,
          {
            apiVariant: "indexer",
            indexerBaseUrl: "https://wazuh-indexer.acme.com:9200",
            indexerIndexPattern: "wazuh-states-vulnerabilities-*",
            limitPerAgent: 500
          },
          { agentIds: ["007"] },
          "req-INDEXER-7"
        )
      );
      const vulns = (out.outputs as {
        vulns: Array<{ agentId: string; vulns: Array<Record<string, unknown>> }>;
      }).vulns;
      const meta = (out.outputs as {
        metadata: { pullId: string; apiVariant: string; totalVulns: number };
      }).metadata;

      // _source surfaced verbatim — bulwark's wire contract.
      assert.equal(vulns.length, 1);
      assert.equal(vulns[0].agentId, "007");
      assert.equal(vulns[0].vulns.length, 2);
      assert.equal(vulns[0].vulns[0]["vulnerability.id"], "CVE-2025-1234");
      assert.equal(meta.apiVariant, "indexer");
      assert.equal(meta.totalVulns, 2);
      assert.equal(meta.pullId, "req-INDEXER-7");

      // 1. The plugin MUST NOT call /security/user/authenticate on
      //    the indexer path — that returns 400 on OpenSearch and is
      //    exactly the bug the original variant shipped with.
      const authCalls = calls.filter((c) =>
        c.url.endsWith("/security/user/authenticate")
      );
      assert.equal(authCalls.length, 0, "indexer path must NOT call authenticate");

      // 2. Exactly one call to the indexer host on :9200, POST, /_search.
      const search = calls.find((c) =>
        c.url.startsWith("https://wazuh-indexer.acme.com:9200/")
      );
      assert.ok(search, "must hit indexerBaseUrl, not the server-API baseUrl");
      assert.equal(search!.method, "POST");
      assert.match(search!.url, /\/_search$/);
      assert.equal(
        search!.url,
        "https://wazuh-indexer.acme.com:9200/wazuh-states-vulnerabilities-*/_search"
      );

      // 3. NO call to the server-API host on :55000 from the indexer path.
      const serverApiCalls = calls.filter((c) =>
        c.url.startsWith("https://wazuh-server.acme.com")
      );
      assert.equal(
        serverApiCalls.length,
        0,
        "indexer variant must not hit the server-API baseUrl"
      );

      // 4. Authorization header is HTTP Basic with the connection's
      //    creds — NOT a bearer JWT. (fakeWazuhConn defaults to
      //    {"username":"admin","password":"hunter2"}.)
      assert.ok(search!.headers, "search call needs headers");
      const auth = search!.headers!.authorization;
      assert.match(auth, /^Basic /);
      const decoded = Buffer.from(auth.replace(/^Basic /, ""), "base64").toString(
        "utf8"
      );
      assert.equal(decoded, "admin:hunter2");
      assert.equal(search!.headers!["content-type"], "application/json");

      // 5. Body is a real OpenSearch DSL — `size` + `term` on
      //    `agent.id`. Not URL-encoded `q=` lucene.
      assert.ok(search!.body, "POST _search must carry a body");
      const body = JSON.parse(search!.body!);
      assert.equal(body.size, 500);
      assert.deepEqual(body.query, { term: { "agent.id": "007" } });
    }
  );
});

test("wazuh_vulns_pull (indexer): empty hits → agent lands in missingAgents (unchanged tolerance)", async () => {
  resetConnectionRegistry();
  registerConnectionDriver(
    "wazuh",
    wazuhConnectionDriver.driver,
    wazuhConnectionDriver.driverManifest
  );
  const conn = fakeWazuhConn("vulns-indexer-empty");
  await withFakeFetch(
    [
      {
        matches: (url, method) =>
          method === "POST" && url.endsWith("/_search"),
        respond: () => ({
          status: 200,
          body: { hits: { total: { value: 0 }, hits: [] } }
        })
      }
    ],
    async () => {
      const out = await wazuhVulnsPullPlugin.execute(
        executeInputWithRequestId(
          conn,
          {
            apiVariant: "indexer",
            indexerBaseUrl: "https://wazuh-indexer.acme.com:9200"
          },
          { agentIds: ["NOPE"] }
        )
      );
      const meta = (out.outputs as {
        metadata: { missingAgents: string[]; perAgentErrors: unknown[]; fetched: number };
      }).metadata;
      assert.deepEqual(meta.missingAgents, ["NOPE"]);
      assert.equal(meta.fetched, 0);
      assert.equal(meta.perAgentErrors.length, 0);
    }
  );
});

test("wazuh_vulns_pull (indexer): indexerBaseUrl accepts a bare hostname → defaults to https://<host>:9200", async () => {
  resetConnectionRegistry();
  registerConnectionDriver(
    "wazuh",
    wazuhConnectionDriver.driver,
    wazuhConnectionDriver.driverManifest
  );
  const conn = fakeWazuhConn("vulns-indexer-host");
  await withFakeFetch(
    [
      {
        matches: (url, method) =>
          method === "POST" && url.endsWith("/_search"),
        respond: () => ({
          status: 200,
          body: { hits: { hits: [{ _source: { x: 1 } }] } }
        })
      }
    ],
    async (calls) => {
      await wazuhVulnsPullPlugin.execute(
        executeInputWithRequestId(
          conn,
          { apiVariant: "indexer", indexerBaseUrl: "indexer.acme.com" },
          { agentIds: ["A"] }
        )
      );
      const search = calls.find((c) => c.url.endsWith("/_search"))!;
      // Bare hostname → schema + 9200 default.
      assert.ok(search.url.startsWith("https://indexer.acme.com:9200/"));
    }
  );
});

test("wazuh_vulns_pull (indexer): static-token connection (no Basic creds) → actionable error, NOT a silent failure", async () => {
  // An operator configured the connection with `{"token":"..."}` for
  // the server-API surface and switched the plugin to apiVariant=indexer.
  // The indexer cannot use that token — refuse loudly rather than
  // emit 0 rows that look like an empty fleet.
  resetConnectionRegistry();
  registerConnectionDriver(
    "wazuh",
    wazuhConnectionDriver.driver,
    wazuhConnectionDriver.driverManifest
  );
  const conn = fakeWazuhConn(
    "vulns-token-only",
    {},
    '{"token":"longlived-bearer"}'
  );
  await withFakeFetch([], async () => {
    const out = await wazuhVulnsPullPlugin.execute(
      executeInputWithRequestId(
        conn,
        {
          apiVariant: "indexer",
          indexerBaseUrl: "https://wazuh-indexer.acme.com:9200"
        },
        { agentIds: ["A"] }
      )
    );
    // Per-agent error surfaces in the metadata envelope (mirroring the
    // 500-error tolerance contract: error is NOT absence — it must NOT
    // land in missingAgents).
    const meta = (out.outputs as {
      metadata: { perAgentErrors: Array<{ agentId: string; message: string }>; missingAgents: string[] };
    }).metadata;
    assert.equal(meta.perAgentErrors.length, 1);
    assert.equal(meta.perAgentErrors[0].agentId, "A");
    assert.match(meta.perAgentErrors[0].message, /HTTP Basic credentials/);
    assert.deepEqual(meta.missingAgents, []);
  });
});

test("wazuh_vulns_pull (indexer): unset indexerBaseUrl → falls back to the connection baseUrl (co-located case)", async () => {
  // Co-located deploys (rare, but supported) — operator didn't supply
  // indexerBaseUrl. Plugin falls back to handle.baseUrl. This MUST
  // remain a valid default so a stock single-host install still works
  // without an extra config knob.
  resetConnectionRegistry();
  registerConnectionDriver(
    "wazuh",
    wazuhConnectionDriver.driver,
    wazuhConnectionDriver.driverManifest
  );
  // Bare hostname so `buildWazuhBaseUrl` applies the port — full URLs
  // are used verbatim and would ignore the `port` option (existing
  // contract; documented on buildWazuhBaseUrl).
  const conn = fakeWazuhConn("vulns-colocated", {
    baseUrl: "wazuh.acme.com",
    port: 55000
  });
  await withFakeFetch(
    [
      {
        matches: (url, method) =>
          method === "POST" && url.endsWith("/_search"),
        respond: () => ({
          status: 200,
          body: { hits: { hits: [{ _source: { x: 1 } }] } }
        })
      }
    ],
    async (calls) => {
      await wazuhVulnsPullPlugin.execute(
        executeInputWithRequestId(
          conn,
          { apiVariant: "indexer" },
          { agentIds: ["A"] }
        )
      );
      const search = calls.find((c) => c.url.endsWith("/_search"))!;
      assert.ok(search.url.startsWith("https://wazuh.acme.com:55000/"));
    }
  );
});

test("wazuh_vulns_pull: reads agent ids from inputs.agents via agentIdField (chain off wazuh_agents_pull)", async () => {
  const { conn } = registerWazuhAndAcquire("vulns-chain");
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/security/user/authenticate"),
        respond: () => ({ status: 200, body: { data: { token: "t" } } })
      },
      {
        matches: (url) => url.includes("/vulnerability/abc-123"),
        respond: () => ({
          status: 200,
          body: { data: { affected_items: [{ name: "CVE-X" }], total_affected_items: 1 } }
        })
      }
    ],
    async () => {
      const out = await wazuhVulnsPullPlugin.execute(
        executeInputWithRequestId(
          conn,
          { apiVariant: "server-api" },
          { agents: [{ id: "abc-123", name: "host-1" }] }
        )
      );
      const vulns = (out.outputs as { vulns: Array<{ agentId: string }> }).vulns;
      assert.equal(vulns[0].agentId, "abc-123");
    }
  );
});

test("wazuh_vulns_pull: no agent ids → empty output with pullId stamp (no crash)", async () => {
  const { conn } = registerWazuhAndAcquire("vulns-empty");
  await withFakeFetch([], async () => {
    const out = await wazuhVulnsPullPlugin.execute(
      executeInputWithRequestId(conn, { apiVariant: "server-api" }, {}, "req-EMPTY")
    );
    const meta = (out.outputs as {
      metadata: { pullId: string; fetched: number; missingAgents: string[] };
    }).metadata;
    assert.equal(meta.fetched, 0);
    assert.deepEqual(meta.missingAgents, []);
    // Provenance still stamped even on the no-op path — bulwark needs
    // a stamp on every run, including pulls that didn't see any agents.
    assert.equal(meta.pullId, "req-EMPTY");
  });
});
