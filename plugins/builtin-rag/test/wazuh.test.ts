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
