/**
 * Cross-language E2E: Node runtime → Python plugin sidecar over connect-rpc.
 * Proves the .proto-as-truth invariant from ADR 0022 holds in practice —
 * the Python side honors the contract the Node SDK speaks.
 *
 * Touches a running python-plugins container (the docker compose stack must
 * be up via `make up` or `make crawl-up`). The test is SKIPPED gracefully
 * when the sidecar isn't reachable, so it doesn't fail offline.
 *
 * What it asserts:
 *   1. Health RPC over Connect returns ok + the expected plugin ids.
 *   2. Execute RPC over Connect against crawl4ai_crawler returns the same
 *      `outputs.documents[*].markdown` shape the legacy /execute used to,
 *      proving the proto Struct ⇄ pydantic translation in
 *      services/python-plugins/app/connect_bridge.py is correct.
 *   3. The full Node plugin-sdk transport path (executeRegisteredPlugin)
 *      flows end-to-end — same wire, same retries, same error envelope.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { externalPluginHealth, executeRegisteredPlugin } from "../../packages/plugin-sdk/src/transport.ts";
import type {
  PluginExecutionInput,
  RegisteredPlugin
} from "../../packages/plugin-sdk/src/index.ts";

const BASE_URL = process.env.PYTHON_PLUGIN_URL ?? "http://localhost:8000";

async function isSidecarReachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    // /healthz (5-line Starlette shim kept for k8s liveness probes) is the
    // cheapest reachability check — a 200 here means the Hypercorn listener
    // is bound. The Connect Health RPC is exercised in the assertions below.
    const r = await fetch(`${BASE_URL}/healthz`, { signal: controller.signal });
    clearTimeout(timer);
    return r.ok;
  } catch {
    return false;
  }
}

function crawl4aiPlugin(): RegisteredPlugin {
  return {
    mode: "external",
    manifest: {
      id: "crawl4ai_crawler",
      name: "Crawl4AI Crawler",
      version: "1.0.0",
      category: "datasource",
      description: "cross-language E2E"
    },
    external: { baseUrl: BASE_URL, timeoutMs: 60_000 }
  };
}

function makeInput(overrides?: Partial<PluginExecutionInput>): PluginExecutionInput {
  return {
    context: {
      requestId: "req-xlang-1",
      executionId: "exec-xlang-1",
      tenantId: "tenant-xlang",
      pipelineId: "pipe-xlang",
      pipelineVersionId: "ver-xlang",
      environment: "test",
      deadline: new Date(Date.now() + 60_000),
      signal: new AbortController().signal,
      resolvedConfig: {
        pipelineId: "pipe-xlang",
        pipelineVersionId: "ver-xlang",
        tenantId: "tenant-xlang",
        environment: "test",
        values: {},
        violations: []
      }
    },
    node: {
      id: "n1",
      plugin: { category: "datasource", id: "crawl4ai_crawler", version: "1.0.0" }
    },
    inputs: {},
    config: { url: "https://example.com", maxPages: 1, timeoutMs: 30_000 },
    secrets: {},
    ...overrides
  };
}

test("cross-language: Connect Health against python-plugins reports expected plugin ids", async (t) => {
  if (!(await isSidecarReachable())) {
    t.skip("python-plugins sidecar not reachable at " + BASE_URL);
    return;
  }
  const health = await externalPluginHealth({ baseUrl: BASE_URL, timeoutMs: 5_000 });
  assert.equal(health.ok, true, `health.ok must be true; got ${JSON.stringify(health)}`);
  // The sidecar registers three plugins (crawl4ai_crawler, scrapy_spider,
  // rerank_bge_local). Don't pin the exact list — assert the most-common
  // one is present, so future additions don't break the test.
  assert.ok(
    health.plugins?.includes("crawl4ai_crawler"),
    `crawl4ai_crawler must be in plugins; got ${JSON.stringify(health.plugins)}`
  );
});

test("cross-language: Node plugin-sdk → Python crawl4ai_crawler round-trip over Connect", async (t) => {
  if (!(await isSidecarReachable())) {
    t.skip("python-plugins sidecar not reachable at " + BASE_URL);
    return;
  }
  const out = await executeRegisteredPlugin(crawl4aiPlugin(), makeInput());
  const outputs = out.outputs as { documents?: Array<{ markdown?: string; url?: string }>; pageCount?: number };
  // The plugin scrapes example.com — a stable RFC document with predictable
  // content. Assert shape and minimal substring rather than exact bytes so
  // upstream wording tweaks don't break the test.
  assert.ok(Array.isArray(outputs.documents), "outputs.documents must be an array");
  assert.ok(outputs.documents.length >= 1, "at least one document expected");
  const first = outputs.documents[0];
  assert.equal(first?.url, "https://example.com");
  assert.ok(
    typeof first?.markdown === "string" && first.markdown.toLowerCase().includes("example domain"),
    "markdown must include 'Example Domain'"
  );
});

test("cross-language: invalid plugin id surfaces a typed Connect error", async (t) => {
  if (!(await isSidecarReachable())) {
    t.skip("python-plugins sidecar not reachable at " + BASE_URL);
    return;
  }
  const bogus: RegisteredPlugin = {
    mode: "external",
    manifest: {
      id: "this_plugin_does_not_exist",
      name: "Bogus",
      version: "1.0.0",
      category: "datasource",
      description: "negative test"
    },
    external: { baseUrl: BASE_URL, timeoutMs: 5_000 }
  };
  await assert.rejects(
    executeRegisteredPlugin(bogus, makeInput()),
    /unknown plugin/,
    "should reject with the server's UNIMPLEMENTED message"
  );
});
