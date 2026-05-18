import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildExternalRequestBody,
  executeRegisteredPlugin,
  externalPluginHealth,
  type PluginExecutionInput,
  type RegisteredPlugin
} from "../src/index.ts";

/**
 * In-process node:http stub implementing the External Plugin HTTP Contract v1.
 * Offline, install-free. Routes:
 *   GET  /healthz       -> 200 {ok:true,plugins:[...]}
 *   POST /execute       -> 200 {outputs: <echo of inputs>, metadata, usage, artifacts}
 *   POST /error         -> 200 {error:"boom"}
 *   POST /fail          -> 500 plain non-2xx
 *   POST /slow          -> responds after 200ms (to exercise timeout)
 */
function startStub(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, plugins: ["crawl4ai_crawler", "scrapy_spider"] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw.length > 0 ? JSON.parse(raw) : {};
      if (url === "/execute") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            outputs: { echoed: body.inputs, plugin: body.plugin },
            metadata: { ok: true },
            usage: { provider: "python", inputTokens: 1 },
            artifacts: [{ kind: "doc", uri: "mem://1" }]
          })
        );
        return;
      }
      if (url === "/error") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom from server" }));
        return;
      }
      if (url === "/fail") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("internal explosion");
        return;
      }
      if (url === "/slow") {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ outputs: {} }));
        }, 200);
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          })
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

function externalPlugin(baseUrl: string, executePath: string, timeoutMs?: number): RegisteredPlugin {
  return {
    mode: "external",
    manifest: {
      id: "crawl4ai_crawler",
      name: "Crawl4AI",
      version: "1.0.0",
      category: "datasource",
      description: "test"
    },
    external: { mode: "http", baseUrl, healthPath: "/healthz", executePath, timeoutMs }
  };
}

test("buildExternalRequestBody produces a JSON-safe wire body", () => {
  const body = buildExternalRequestBody(externalPlugin("http://x", "/execute"), makeInput());
  // Round-trips cleanly: no functions, no AbortSignal.
  const roundTripped = JSON.parse(JSON.stringify(body));
  assert.deepEqual(roundTripped, body);

  assert.deepEqual(body.plugin, {
    category: "datasource",
    id: "crawl4ai_crawler",
    version: "1.0.0"
  });
  const ctx = body.context as Record<string, unknown>;
  assert.equal(ctx.requestId, "req-1");
  assert.equal(ctx.executionId, "exec-1");
  assert.equal(ctx.tenantId, "tenant-a");
  assert.equal(ctx.environment, "prod");
  // Date deadline -> ISO string.
  assert.equal(ctx.deadline, "2030-01-01T00:00:00.000Z");
  // No AbortSignal leaked into the wire body.
  assert.equal("signal" in ctx, false);
  // resolvedConfig collapsed to { values: { key: { value } } } only.
  assert.deepEqual(ctx.resolvedConfig, { values: { "crawl.maxPages": { value: 5 } } });
});

test("buildExternalRequestBody serializes a missing deadline as null", () => {
  const input = makeInput();
  delete (input.context as { deadline?: unknown }).deadline;
  const body = buildExternalRequestBody(externalPlugin("http://x", "/execute"), input);
  assert.equal((body.context as Record<string, unknown>).deadline, null);
});

test("external execute maps a 200 success body to PluginExecutionOutput", async () => {
  const stub = await startStub();
  try {
    const out = await executeRegisteredPlugin(
      externalPlugin(stub.baseUrl, "/execute"),
      makeInput()
    );
    assert.deepEqual(out.outputs, {
      echoed: { seed: "https://example.com" },
      plugin: { category: "datasource", id: "crawl4ai_crawler", version: "1.0.0" }
    });
    assert.deepEqual(out.metadata, { ok: true });
    assert.deepEqual(out.usage, { provider: "python", inputTokens: 1 });
    assert.deepEqual(out.artifacts, [{ kind: "doc", uri: "mem://1" }]);
  } finally {
    await stub.close();
  }
});

test("external execute throws when the server returns {error}", async () => {
  const stub = await startStub();
  try {
    await assert.rejects(
      executeRegisteredPlugin(externalPlugin(stub.baseUrl, "/error"), makeInput()),
      /boom from server/
    );
  } finally {
    await stub.close();
  }
});

test("external execute throws on a non-2xx response", async () => {
  const stub = await startStub();
  try {
    await assert.rejects(
      executeRegisteredPlugin(externalPlugin(stub.baseUrl, "/fail"), makeInput()),
      /HTTP 500/
    );
  } finally {
    await stub.close();
  }
});

test("external execute aborts and throws when the timeout elapses", async () => {
  const stub = await startStub();
  try {
    await assert.rejects(
      executeRegisteredPlugin(externalPlugin(stub.baseUrl, "/slow", 25), makeInput()),
      /timed out after 25ms/
    );
  } finally {
    await stub.close();
  }
});

test("externalPluginHealth parses the health payload", async () => {
  const stub = await startStub();
  try {
    const health = await externalPluginHealth({
      mode: "http",
      baseUrl: stub.baseUrl,
      healthPath: "/healthz"
    });
    assert.equal(health.ok, true);
    assert.deepEqual(health.plugins, ["crawl4ai_crawler", "scrapy_spider"]);
  } finally {
    await stub.close();
  }
});

test("externalPluginHealth resolves ok:false on transport error", async () => {
  // Port 1 is unroutable; fetch rejects and we surface ok:false (no throw).
  const health = await externalPluginHealth({
    mode: "http",
    baseUrl: "http://127.0.0.1:1",
    healthPath: "/healthz",
    timeoutMs: 200
  });
  assert.equal(health.ok, false);
  assert.equal(typeof health.message, "string");
});

test("grpc external transport is not implemented", async () => {
  const plugin: RegisteredPlugin = {
    mode: "external",
    manifest: {
      id: "x",
      name: "x",
      version: "1.0.0",
      category: "datasource",
      description: "x"
    },
    external: { mode: "grpc", baseUrl: "http://x" }
  };
  await assert.rejects(
    executeRegisteredPlugin(plugin, makeInput()),
    /grpc external transport not implemented/
  );
  const health = await externalPluginHealth({ mode: "grpc", baseUrl: "http://x" });
  assert.equal(health.ok, false);
  assert.match(health.message ?? "", /grpc external transport not implemented/);
});

test("in-process execution path is unaffected", async () => {
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
