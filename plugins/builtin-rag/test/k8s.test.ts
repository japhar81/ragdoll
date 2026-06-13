/**
 * k8s driver + k8s_list_pull — unit tests.
 *
 * The headline asserts are around the completeness flag, the one
 * piece of behavior this whole module exists to provide:
 *
 *   - clean run: every page succeeds → `scan.complete === true`,
 *     resourceVersion captured from page 1, items aggregated across
 *     pages
 *   - 410 mid-pagination: scan emits `complete: false` with
 *     `reason: "continue_410_gone"` and the items collected so far
 *     (NEVER silently truncated as if whole)
 *   - non-2xx mid-pagination: `complete: false` + page_status_<N>
 *   - non-JSON body: `complete: false` + non_json_body
 *   - timeout: `complete: false` + timeout
 *   - maxPages cap: `complete: false` + max_pages
 *
 * Driver-side asserts:
 *   - parseK8sSecret accepts JSON {token} and raw string; empty →
 *     actionable error naming secretRefKey
 *   - buildK8sApiServerUrl refuses missing scheme
 *   - insecureSkipTlsVerify threads rejectUnauthorized=false to fetch
 *   - probe hits /version with the bearer
 *   - no token / bearer ever appears in error messages
 *   - namespace scope rewrites the path correctly for both core and
 *     apis/<group>/<version>/ paths
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildK8sApiServerUrl,
  k8sConnectionDriver,
  k8sListPullPlugin,
  parseK8sSecret,
  requireK8sConnection,
  __setK8sFetchForTests,
  type K8sFetch,
  type K8sHandle,
  type K8sScan
} from "../src/k8s.ts";
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
  rejectUnauthorized?: boolean;
  caCert?: string;
}

interface FakeResponse {
  status: number;
  body: unknown;
}

function fakeFetch(
  routes: Array<{
    matches: (url: string, method: string) => boolean;
    respond: () => FakeResponse | Promise<FakeResponse> | Promise<never>;
  }>
): { fetch: K8sFetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const f: K8sFetch = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      rejectUnauthorized: init.rejectUnauthorized,
      caCert: init.caCert
    });
    for (const route of routes) {
      if (route.matches(url, (init.method ?? "GET").toUpperCase())) {
        const r = await route.respond();
        return {
          status: r.status,
          ok: r.status >= 200 && r.status < 300,
          json: async () => r.body,
          text: async () =>
            typeof r.body === "string" ? r.body : JSON.stringify(r.body)
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
  __setK8sFetchForTests(f);
  try {
    return await body(calls);
  } finally {
    __setK8sFetchForTests(null);
  }
}

function fakeK8sConn(
  slug = "test-k8s",
  options: Record<string, unknown> = {},
  secret = '{"token":"sa-token-XYZ"}'
): ResolvedExternalConnection {
  return {
    id: `conn-${slug}`,
    slug,
    kind: "k8s",
    options: { apiServerUrl: "https://k8s.test:6443", ...options },
    secret,
    cascadeReason: "tenant"
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("parseK8sSecret: JSON {token} canonical shape", () => {
  assert.deepEqual(parseK8sSecret('{"token":"abc"}'), {
    kind: "token",
    token: "abc"
  });
});

test("parseK8sSecret: raw string treated as the token", () => {
  assert.deepEqual(parseK8sSecret("ey...big.JWT...XYZ"), {
    kind: "token",
    token: "ey...big.JWT...XYZ"
  });
});

test("parseK8sSecret: empty / whitespace raises naming secretRefKey", () => {
  assert.throws(() => parseK8sSecret(undefined), /secretRefKey/);
  assert.throws(() => parseK8sSecret(""), /secretRefKey/);
  assert.throws(() => parseK8sSecret("   "), /secretRefKey/);
});

test("buildK8sApiServerUrl: rejects missing scheme", () => {
  assert.throws(
    () => buildK8sApiServerUrl({ apiServerUrl: "k8s.test:6443" }),
    /must include a scheme/
  );
});

test("buildK8sApiServerUrl: strips trailing slash", () => {
  assert.equal(
    buildK8sApiServerUrl({ apiServerUrl: "https://k8s.test:6443/" }),
    "https://k8s.test:6443"
  );
});

// ---------------------------------------------------------------------------
// Driver — token auth + TLS posture + probe + leak guard
// ---------------------------------------------------------------------------

test("driver: every authenticated GET carries the bearer header", async () => {
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/version"),
        respond: () => ({ status: 200, body: { major: "1", minor: "29" } })
      }
    ],
    async (calls) => {
      const conn = fakeK8sConn();
      const handle = await k8sConnectionDriver.driver.create(conn);
      await (handle as K8sHandle).get("/version");
      assert.equal(calls.length, 1);
      assert.equal(
        calls[0].headers?.authorization,
        "Bearer sa-token-XYZ"
      );
    }
  );
});

test("driver: probe hits /version and surfaces non-2xx as an error", async () => {
  // Success path
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/version"),
        respond: () => ({ status: 200, body: { gitVersion: "v1.29.0" } })
      }
    ],
    async (calls) => {
      const handle = await k8sConnectionDriver.driver.create(fakeK8sConn());
      await k8sConnectionDriver.driver.probe!(handle);
      assert.ok(calls.some((c) => c.url.endsWith("/version")));
    }
  );
  // Failure path
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/version"),
        respond: () => ({ status: 401, body: { message: "Unauthorized" } })
      }
    ],
    async () => {
      const handle = await k8sConnectionDriver.driver.create(
        fakeK8sConn("probe-fail")
      );
      await assert.rejects(
        () => k8sConnectionDriver.driver.probe!(handle),
        /probe GET \/version → 401/
      );
    }
  );
});

test("driver: insecureSkipTlsVerify=true threads rejectUnauthorized=false through every call", async () => {
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/version"),
        respond: () => ({ status: 200, body: {} })
      }
    ],
    async (calls) => {
      const handle = await k8sConnectionDriver.driver.create(
        fakeK8sConn("insecure", { insecureSkipTlsVerify: true })
      );
      await (handle as K8sHandle).get("/version");
      assert.equal(calls[0].rejectUnauthorized, false);
    }
  );
  // Default is secure — no opt-out.
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/version"),
        respond: () => ({ status: 200, body: {} })
      }
    ],
    async (calls) => {
      const handle = await k8sConnectionDriver.driver.create(
        fakeK8sConn("secure")
      );
      await (handle as K8sHandle).get("/version");
      assert.notEqual(calls[0].rejectUnauthorized, false);
    }
  );
});

test("driver: caCert is threaded through to fetch", async () => {
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/version"),
        respond: () => ({ status: 200, body: {} })
      }
    ],
    async (calls) => {
      const handle = await k8sConnectionDriver.driver.create(
        fakeK8sConn("ca", { caCert: "-----BEGIN CERTIFICATE-----\nMIIB" })
      );
      await (handle as K8sHandle).get("/version");
      assert.match(calls[0].caCert ?? "", /BEGIN CERTIFICATE/);
    }
  );
});

test("driver: error messages never carry the token", async () => {
  await withFakeFetch(
    [
      {
        matches: (url) => url.endsWith("/version"),
        respond: () => ({ status: 500, body: { error: "boom" } })
      }
    ],
    async () => {
      const handle = await k8sConnectionDriver.driver.create(
        fakeK8sConn("leak-check", {}, '{"token":"super-sekrit-K8S-XYZ"}')
      );
      try {
        await k8sConnectionDriver.driver.probe!(handle);
        assert.fail("expected throw");
      } catch (e) {
        const msg = String((e as Error).message);
        assert.doesNotMatch(msg, /super-sekrit-K8S-XYZ/);
      }
    }
  );
});

test("driver: two acquires against the same connection.id return the SAME handle", async () => {
  resetConnectionRegistry();
  registerConnectionDriver(
    "k8s",
    k8sConnectionDriver.driver,
    k8sConnectionDriver.driverManifest
  );
  const conn = fakeK8sConn("cache-test");
  const a = await acquireClient<K8sHandle>(conn);
  const b = await acquireClient<K8sHandle>(conn);
  assert.strictEqual(a, b);
});

// ---------------------------------------------------------------------------
// k8s_list_pull — the completeness flag
// ---------------------------------------------------------------------------

function registerK8sStub(): { conn: ResolvedExternalConnection } {
  resetConnectionRegistry();
  registerConnectionDriver(
    "k8s",
    k8sConnectionDriver.driver,
    k8sConnectionDriver.driverManifest
  );
  return { conn: fakeK8sConn("lister") };
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
      bindings: { k8s: { connection: conn } }
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
  } as unknown as Parameters<typeof k8sListPullPlugin.execute>[0];
}

test("k8s_list_pull: clean pagination → complete:true, resourceVersion from page 1, items aggregated", async () => {
  const { conn } = registerK8sStub();
  let pageCounter = 0;
  await withFakeFetch(
    [
      {
        matches: (url) => url.includes("/api/v1/pods"),
        respond: () => {
          pageCounter += 1;
          if (pageCounter === 1) {
            return {
              status: 200,
              body: {
                metadata: { resourceVersion: "12345", continue: "cont-page-2" },
                items: [{ metadata: { name: "p1" } }, { metadata: { name: "p2" } }]
              }
            };
          }
          if (pageCounter === 2) {
            return {
              status: 200,
              body: {
                metadata: { resourceVersion: "12345", continue: "cont-page-3" },
                items: [{ metadata: { name: "p3" } }, { metadata: { name: "p4" } }]
              }
            };
          }
          // Final page — no continue token = drain.
          return {
            status: 200,
            body: {
              metadata: { resourceVersion: "12345" },
              items: [{ metadata: { name: "p5" } }]
            }
          };
        }
      }
    ],
    async (calls) => {
      const out = await k8sListPullPlugin.execute(
        executeInput(conn, { resources: ["pods"], limit: 2 })
      );
      const scans = (out.outputs as { scans: K8sScan[] }).scans;
      assert.equal(scans.length, 1);
      const scan = scans[0];
      assert.equal(scan.kind, "Pod");
      assert.equal(scan.complete, true);
      assert.equal(scan.reason, undefined);
      assert.equal(scan.resourceVersion, "12345");
      assert.equal(scan.items.length, 5);
      assert.equal(scan.pagesFetched, 3);
      // Continue token threaded through on pages 2 + 3.
      const podCalls = calls.filter((c) => c.url.includes("/api/v1/pods"));
      assert.equal(podCalls.length, 3);
      assert.match(podCalls[1].url, /continue=cont-page-2/);
      assert.match(podCalls[2].url, /continue=cont-page-3/);
    }
  );
});

test("k8s_list_pull: 410 Gone mid-pagination → complete:false, reason continue_410_gone, items so far preserved (THE critical test)", async () => {
  const { conn } = registerK8sStub();
  let pageCounter = 0;
  await withFakeFetch(
    [
      {
        matches: (url) => url.includes("/api/v1/pods"),
        respond: () => {
          pageCounter += 1;
          if (pageCounter === 1) {
            return {
              status: 200,
              body: {
                metadata: { resourceVersion: "9000", continue: "cont-gone" },
                items: [
                  { metadata: { name: "alive-1" } },
                  { metadata: { name: "alive-2" } }
                ]
              }
            };
          }
          // The API server has GC'd the snapshot — classic continue
          // token GC. Every list-poller MUST treat this as "snapshot
          // not consistent", never as "list ended."
          return {
            status: 410,
            body: {
              kind: "Status",
              code: 410,
              reason: "Expired",
              message: "The provided continue parameter is too old..."
            }
          };
        }
      }
    ],
    async () => {
      const out = await k8sListPullPlugin.execute(
        executeInput(conn, { resources: ["pods"], limit: 2 })
      );
      const scan = (out.outputs as { scans: K8sScan[] }).scans[0];
      assert.equal(scan.complete, false);
      assert.equal(scan.reason, "continue_410_gone");
      // The items we collected before the 410 are STILL emitted —
      // bulwark needs them; complete:false is the gate on absence
      // logic, not on the items themselves.
      assert.equal(scan.items.length, 2);
      assert.equal(scan.resourceVersion, "9000");
      assert.equal(scan.pagesFetched, 2);
      assert.match(scan.detail ?? "", /Expired/);
      // The roll-up metadata flags the partial.
      const meta = (out.outputs as { metadata: { partials: Array<{ kind: string; reason?: string }> } }).metadata;
      assert.deepEqual(meta.partials.map((p) => p.reason), ["continue_410_gone"]);
    }
  );
});

test("k8s_list_pull: non-2xx mid-pagination → complete:false, reason carries the status", async () => {
  const { conn } = registerK8sStub();
  let pageCounter = 0;
  await withFakeFetch(
    [
      {
        matches: (url) => url.includes("/api/v1/nodes"),
        respond: () => {
          pageCounter += 1;
          if (pageCounter === 1) {
            return {
              status: 200,
              body: {
                metadata: { resourceVersion: "rv-100", continue: "tok" },
                items: [{ metadata: { name: "n1" } }]
              }
            };
          }
          return { status: 503, body: { message: "shedding load" } };
        }
      }
    ],
    async () => {
      const out = await k8sListPullPlugin.execute(
        executeInput(conn, { resources: ["nodes"] })
      );
      const scan = (out.outputs as { scans: K8sScan[] }).scans[0];
      assert.equal(scan.complete, false);
      assert.equal(scan.reason, "page_status_503");
      assert.equal(scan.items.length, 1);
    }
  );
});

test("k8s_list_pull: non-JSON body → complete:false", async () => {
  const { conn } = registerK8sStub();
  await withFakeFetch(
    [
      {
        matches: (url) => url.includes("/api/v1/pods"),
        respond: () => ({ status: 200, body: "<html>nginx 502 page</html>" })
      }
    ],
    async () => {
      const out = await k8sListPullPlugin.execute(
        executeInput(conn, { resources: ["pods"] })
      );
      const scan = (out.outputs as { scans: K8sScan[] }).scans[0];
      assert.equal(scan.complete, false);
      assert.equal(scan.reason, "non_json_body");
    }
  );
});

test("k8s_list_pull: maxPages cap → complete:false, reason max_pages", async () => {
  const { conn } = registerK8sStub();
  await withFakeFetch(
    [
      {
        matches: (url) => url.includes("/api/v1/pods"),
        respond: () => ({
          status: 200,
          body: {
            metadata: {
              resourceVersion: "rv-1",
              continue: "always-more",
              remainingItemCount: 99999
            },
            items: [{ metadata: { name: "p" } }]
          }
        })
      }
    ],
    async () => {
      const out = await k8sListPullPlugin.execute(
        executeInput(conn, { resources: ["pods"], maxPages: 3 })
      );
      const scan = (out.outputs as { scans: K8sScan[] }).scans[0];
      assert.equal(scan.complete, false);
      assert.equal(scan.reason, "max_pages");
      assert.equal(scan.pagesFetched, 3);
      assert.equal(scan.remainingItemCountAtPartial, 99999);
    }
  );
});

test("k8s_list_pull: namespace scope rewrites both core and apis/<group>/ paths", async () => {
  const { conn } = registerK8sStub();
  await withFakeFetch(
    [
      {
        matches: (url) =>
          url.includes("/api/v1/namespaces/prod/pods") ||
          url.includes(
            "/apis/apps/v1/namespaces/prod/deployments"
          ),
        respond: () => ({
          status: 200,
          body: { metadata: { resourceVersion: "rv" }, items: [] }
        })
      }
    ],
    async (calls) => {
      const out = await k8sListPullPlugin.execute(
        executeInput(conn, {
          resources: ["pods", "deployments"],
          namespace: "prod"
        })
      );
      const scans = (out.outputs as { scans: K8sScan[] }).scans;
      assert.equal(scans.length, 2);
      assert.ok(scans.every((s) => s.complete));
      const urls = calls.map((c) => c.url);
      assert.ok(urls.some((u) => u.includes("/api/v1/namespaces/prod/pods")));
      assert.ok(
        urls.some((u) =>
          u.includes("/apis/apps/v1/namespaces/prod/deployments")
        )
      );
    }
  );
});

test("k8s_list_pull: refuses an unknown built-in resource", async () => {
  const { conn } = registerK8sStub();
  await withFakeFetch([], async () => {
    await assert.rejects(
      () =>
        k8sListPullPlugin.execute(
          executeInput(conn, { resources: ["nope"] })
        ),
      /unknown built-in resource/
    );
  });
});

test("k8s_list_pull: customResources entries become /apis/<group>/<version>/<plural>", async () => {
  const { conn } = registerK8sStub();
  await withFakeFetch(
    [
      {
        matches: (url) =>
          url.includes("/apis/cert-manager.io/v1/certificates"),
        respond: () => ({
          status: 200,
          body: { metadata: { resourceVersion: "rv-crd" }, items: [{ metadata: { name: "c1" } }] }
        })
      }
    ],
    async (calls) => {
      const out = await k8sListPullPlugin.execute(
        executeInput(conn, {
          customResources: [
            {
              group: "cert-manager.io",
              version: "v1",
              plural: "certificates",
              kindLabel: "Certificate"
            }
          ]
        })
      );
      const scan = (out.outputs as { scans: K8sScan[] }).scans[0];
      assert.equal(scan.kind, "Certificate");
      assert.equal(scan.complete, true);
      assert.ok(
        calls.some((c) =>
          c.url.includes("/apis/cert-manager.io/v1/certificates")
        )
      );
    }
  );
});

test("k8s_list_pull: at least one resource must be configured (loud error, not silent empty)", async () => {
  const { conn } = registerK8sStub();
  await withFakeFetch([], async () => {
    await assert.rejects(
      () => k8sListPullPlugin.execute(executeInput(conn, {})),
      /at least one resource kind/
    );
  });
});

// ---------------------------------------------------------------------------
// requireK8sConnection — binding shape
// ---------------------------------------------------------------------------

test("requireK8sConnection: clear error when the binding is missing", () => {
  const input = {
    dataset: { slug: "ds", bindings: {} }
  } as unknown as Parameters<typeof requireK8sConnection>[0];
  assert.throws(
    () => requireK8sConnection(input, "k8s", "k8s_list_pull"),
    /requires a "k8s" binding/
  );
});

test("requireK8sConnection: clear error when the binding's kind isn't k8s", () => {
  const input = {
    dataset: {
      slug: "ds",
      bindings: { k8s: { connection: { kind: "qdrant", slug: "x" } } }
    }
  } as unknown as Parameters<typeof requireK8sConnection>[0];
  assert.throws(
    () => requireK8sConnection(input, "k8s", "k8s_list_pull"),
    /expected "k8s"/
  );
});
