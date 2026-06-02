/**
 * Round-trip the example plugins through the full executeRegisteredPlugin
 * Connect transport. Catches SDK contract drift before the examples
 * bit-rot — they're the canonical "starting template" for new plugin
 * authors, so a broken example breaks every future plugin's path.
 *
 * Node-echo is exercised in-process (the example exports
 * `createEchoServer()` exactly so the test can listen on an ephemeral
 * port without docker). Python-echo is exercised against a running
 * container — set `PYTHON_ECHO_URL` to its baseUrl to enable, otherwise
 * the test skips gracefully (no docker required for CI).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createEchoServer } from "../../examples/plugins/node-echo/src/server.ts";
import { executeRegisteredPlugin, externalPluginHealth } from "../../packages/plugin-sdk/src/transport.ts";
import type { PluginExecutionInput, RegisteredPlugin } from "../../packages/plugin-sdk/src/index.ts";

function makeInput(overrides?: Partial<PluginExecutionInput>): PluginExecutionInput {
  return {
    context: {
      requestId: "req-ex-1",
      executionId: "exec-ex-1",
      tenantId: "tenant-ex",
      pipelineId: "pipe-ex",
      pipelineVersionId: "ver-ex",
      environment: "test",
      deadline: new Date(Date.now() + 10_000),
      signal: new AbortController().signal,
      resolvedConfig: {
        pipelineId: "pipe-ex",
        pipelineVersionId: "ver-ex",
        tenantId: "tenant-ex",
        environment: "test",
        values: {},
        violations: []
      }
    },
    node: {
      id: "n1",
      plugin: { category: "transformer", id: "node_echo", version: "0.1.0" }
    },
    inputs: { text: "hello world" },
    config: {},
    secrets: {},
    ...overrides
  };
}

function echoPlugin(pluginId: string, baseUrl: string): RegisteredPlugin {
  return {
    mode: "external",
    manifest: {
      id: pluginId,
      name: pluginId,
      version: "0.1.0",
      category: "transformer",
      description: "example echo"
    },
    external: { baseUrl, timeoutMs: 10_000 }
  };
}

// ---- node-echo (in-process) -------------------------------------------------

test("examples/node-echo: Health RPC + Execute round-trip via the SDK transport", async () => {
  const server = createEchoServer();
  const port: number = await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve(addr.port);
    })
  );
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await externalPluginHealth({ baseUrl, timeoutMs: 5_000 });
    assert.equal(health.ok, true);
    assert.deepEqual(health.plugins, ["node_echo"]);

    const out = await executeRegisteredPlugin(
      echoPlugin("node_echo", baseUrl),
      makeInput()
    );
    const outputs = out.outputs as { echoed: string; length: number };
    assert.equal(outputs.echoed, "hello world");
    assert.equal(outputs.length, 11);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// ---- python-echo (against a running container) ------------------------------

test("examples/python-echo: round-trip when PYTHON_ECHO_URL is set", async (t) => {
  const url = process.env.PYTHON_ECHO_URL;
  if (!url) {
    t.skip("set PYTHON_ECHO_URL=http://localhost:8002 (after `docker run python-echo`) to enable");
    return;
  }
  // Reachability probe first — fail-fast on a stale env var.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const r = await fetch(`${url}/ragdoll.plugin.v1.PluginRuntime/Health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!r.ok) {
      t.skip(`python-echo unreachable at ${url} (HTTP ${r.status})`);
      return;
    }
  } catch {
    t.skip(`python-echo unreachable at ${url}`);
    return;
  }

  const out = await executeRegisteredPlugin(
    echoPlugin("python_echo", url),
    makeInput({
      node: { id: "n1", plugin: { category: "transformer", id: "python_echo", version: "0.1.0" } }
    })
  );
  const outputs = out.outputs as { echoed: string; length: number };
  assert.equal(outputs.echoed, "hello world");
  assert.equal(outputs.length, 11);
});
