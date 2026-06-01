import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import {
  ExecuteResponseSchema,
  PluginRuntime
} from "@ragdoll/proto-gen/plugin";
import { type PluginExecutionInput, type RegisteredPlugin } from "../src/index.ts";
import { executeRegisteredPlugin, externalPluginHealth } from "../src/transport.ts";

/**
 * Real connect-rpc server stub. We mount an actual `PluginRuntime` handler
 * with `connectNodeAdapter`, listen on an ephemeral port, and let the
 * plugin-sdk talk to it over Connect HTTP/1.1+JSON. Validates the full
 * client/server contract instead of mocking the wire shape.
 */
function startStub(opts?: {
  executeBehavior?: "ok" | "error" | "fail" | "slow";
  streamingTokens?: string[];
}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const handler = connectNodeAdapter({
    routes: (r) => {
      r.service(PluginRuntime, {
        async health() {
          return {
            ok: true,
            plugins: ["crawl4ai_crawler", "scrapy_spider"],
            message: ""
          };
        },
        async execute(req) {
          switch (opts?.executeBehavior) {
            case "error":
              throw new ConnectError("boom from server", Code.Internal);
            case "fail":
              throw new ConnectError("internal explosion", Code.Internal);
            case "slow":
              await new Promise((res) => setTimeout(res, 200));
              return create(ExecuteResponseSchema, { outputs: {} });
            default:
              // Echo the request inputs so tests can assert round-trip.
              return create(ExecuteResponseSchema, {
                outputs: { echoed: req.inputs ?? {}, plugin: req.plugin },
                metadata: { ok: true },
                usage: { provider: "python", inputTokens: 1 }
              });
          }
        },
        async *executeServerStream(req, ctx) {
          for (const token of opts?.streamingTokens ?? []) {
            if (ctx.signal.aborted) return;
            yield { payload: { case: "token", value: token } } as never;
          }
          // Final envelope so the client doesn't have to synthesise one.
          yield {
            payload: {
              case: "final",
              value: create(ExecuteResponseSchema, {
                outputs: { plugin: req.plugin, count: opts?.streamingTokens?.length ?? 0 }
              })
            }
          } as never;
        },
        async executeClientStream() {
          throw new ConnectError("not used in these tests", Code.Unimplemented);
        },
        async *executeBidi() {
          throw new ConnectError("not used in these tests", Code.Unimplemented);
        }
      });
    }
  });
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done()))
      });
    });
  });
}

function makeInput(overrides?: Partial<PluginExecutionInput>): PluginExecutionInput {
  return {
    context: {
      requestId: "req-1",
      executionId: "exec-1",
      tenantId: "tenant-a",
      pipelineId: "pipe-1",
      pipelineVersionId: "ver-1",
      environment: "prod",
      deadline: new Date("2030-01-01T00:00:00.000Z"),
      signal: new AbortController().signal,
      resolvedConfig: {
        pipelineId: "pipe-1",
        pipelineVersionId: "ver-1",
        tenantId: "tenant-a",
        environment: "prod",
        values: {
          "crawl.maxPages": {
            value: 5,
            sourceScope: "pipeline",
            defaulted: false,
            locked: false,
            secret: false,
            sensitive: false,
            redacted: false,
            inherited: false
          }
        },
        violations: []
      }
    },
    node: {
      id: "node-1",
      plugin: { category: "datasource", id: "crawl4ai_crawler", version: "1.0.0" },
      config: { url: "https://example.com" },
      secrets: {}
    },
    inputs: { seed: "https://example.com" },
    config: { maxPages: 3 },
    secrets: {},
    ...overrides
  };
}

function externalPlugin(baseUrl: string, opts?: { timeoutMs?: number; streaming?: boolean }): RegisteredPlugin {
  return {
    mode: "external",
    manifest: {
      id: "crawl4ai_crawler",
      name: "Crawl4AI",
      version: "1.0.0",
      category: "datasource",
      description: "test",
      streaming: opts?.streaming
    },
    external: { baseUrl, timeoutMs: opts?.timeoutMs }
  };
}

test("external execute round-trips inputs through the Connect Execute RPC", async () => {
  const stub = await startStub();
  try {
    const out = await executeRegisteredPlugin(externalPlugin(stub.baseUrl), makeInput());
    assert.deepEqual(out.outputs, {
      echoed: { seed: "https://example.com" },
      plugin: "crawl4ai_crawler"
    });
    assert.deepEqual(out.metadata, { ok: true });
    assert.equal(out.usage?.provider, "python");
    assert.equal(out.usage?.inputTokens, 1);
  } finally {
    await stub.close();
  }
});

test("external execute surfaces a server-side ConnectError message", async () => {
  const stub = await startStub({ executeBehavior: "error" });
  try {
    await assert.rejects(
      executeRegisteredPlugin(externalPlugin(stub.baseUrl), makeInput()),
      /boom from server/
    );
  } finally {
    await stub.close();
  }
});

test("external execute aborts and throws when the timeout elapses", async () => {
  const stub = await startStub({ executeBehavior: "slow" });
  try {
    await assert.rejects(
      executeRegisteredPlugin(externalPlugin(stub.baseUrl, { timeoutMs: 25 }), makeInput()),
      /timed out after 25ms/
    );
  } finally {
    await stub.close();
  }
});

test("externalPluginHealth parses the Health RPC response", async () => {
  const stub = await startStub();
  try {
    const health = await externalPluginHealth({ baseUrl: stub.baseUrl });
    assert.equal(health.ok, true);
    assert.deepEqual(health.plugins, ["crawl4ai_crawler", "scrapy_spider"]);
  } finally {
    await stub.close();
  }
});

test("externalPluginHealth resolves ok:false on transport error (no throw)", async () => {
  // Port 1 is unroutable; the Connect client errors and we surface ok:false.
  const health = await externalPluginHealth({
    baseUrl: "http://127.0.0.1:1",
    timeoutMs: 200
  });
  assert.equal(health.ok, false);
  assert.equal(typeof health.message, "string");
});

test("streaming plugin: tokens fan out through input.onToken; final envelope returned", async () => {
  const stub = await startStub({ streamingTokens: ["alpha", "beta", "gamma"] });
  try {
    const tokens: string[] = [];
    const out = await executeRegisteredPlugin(
      externalPlugin(stub.baseUrl, { streaming: true }),
      makeInput({ onToken: (t) => tokens.push(t) })
    );
    assert.deepEqual(tokens, ["alpha", "beta", "gamma"]);
    assert.equal((out.outputs as { count: number }).count, 3);
  } finally {
    await stub.close();
  }
});

test("streaming-capable plugin called without onToken still uses unary path", async () => {
  // No streamingTokens supplied => Execute branch would echo; if streaming
  // were taken without onToken being present, ExecuteServerStream would
  // return just the final envelope. The dispatch rule is: streaming branch
  // requires BOTH manifest.streaming AND caller-supplied onToken.
  const stub = await startStub();
  try {
    const out = await executeRegisteredPlugin(
      externalPlugin(stub.baseUrl, { streaming: true }),
      makeInput() // no onToken
    );
    assert.deepEqual(out.outputs, {
      echoed: { seed: "https://example.com" },
      plugin: "crawl4ai_crawler"
    });
  } finally {
    await stub.close();
  }
});

test("in-process execution path is unaffected by the Connect transport switch", async () => {
  const plugin: RegisteredPlugin = {
    mode: "in_process",
    manifest: {
      id: "echo",
      name: "echo",
      version: "1.0.0",
      category: "transformer",
      description: "echo"
    },
    implementation: {
      manifest: {
        id: "echo",
        name: "echo",
        version: "1.0.0",
        category: "transformer",
        description: "echo"
      },
      async execute(input) {
        return { outputs: { got: input.inputs } };
      }
    }
  };
  const out = await executeRegisteredPlugin(plugin, makeInput());
  assert.deepEqual(out.outputs, { got: { seed: "https://example.com" } });
});
