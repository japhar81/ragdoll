import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { loadPluginRegistry, loadRegistries } from "../src/index.ts";

/**
 * Tiny in-process node:http stub so PYTHON_PLUGIN_URL points at a real
 * (offline, localhost) base URL during these tests. Registration itself does
 * not call the server, but using a live URL keeps the test honest.
 */
function startStub(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, plugins: [] }));
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

test("no external plugins registered when PYTHON_PLUGIN_URL is unset", () => {
  const prior = process.env.PYTHON_PLUGIN_URL;
  delete process.env.PYTHON_PLUGIN_URL;
  try {
    const registry = loadPluginRegistry();
    assert.equal(
      registry.get({ category: "datasource", id: "crawl4ai_crawler", version: "1.0.0" }),
      undefined
    );
    assert.equal(
      registry.get({ category: "datasource", id: "scrapy_spider", version: "1.0.0" }),
      undefined
    );
    // In-process discovery still works.
    assert.ok(registry.get({ category: "llm", id: "provider_chat", version: "1.0.0" }));
  } finally {
    if (prior === undefined) delete process.env.PYTHON_PLUGIN_URL;
    else process.env.PYTHON_PLUGIN_URL = prior;
  }
});

test("external crawler plugins registered when PYTHON_PLUGIN_URL is set", async () => {
  const stub = await startStub();
  const priorUrl = process.env.PYTHON_PLUGIN_URL;
  const priorTimeout = process.env.PYTHON_PLUGIN_TIMEOUT_MS;
  process.env.PYTHON_PLUGIN_URL = stub.baseUrl;
  process.env.PYTHON_PLUGIN_TIMEOUT_MS = "12345";
  try {
    const registry = loadPluginRegistry();

    const crawl4ai = registry.get({
      category: "datasource",
      id: "crawl4ai_crawler",
      version: "1.0.0"
    });
    assert.ok(crawl4ai, "crawl4ai_crawler registered");
    assert.equal(crawl4ai?.mode, "external");
    assert.equal(crawl4ai?.implementation, undefined);
    assert.deepEqual(crawl4ai?.external, {
      baseUrl: stub.baseUrl,
      timeoutMs: 12345
    });
    // Manifest carries a form-renderable configSchema + ui.
    const c4Schema = crawl4ai?.manifest.configSchema;
    assert.equal(c4Schema?.type, "object");
    assert.equal(c4Schema?.properties?.maxPages?.default, 10);
    assert.equal(c4Schema?.properties?.maxDepth?.default, 1);
    assert.equal(c4Schema?.properties?.sameDomainOnly?.default, true);
    assert.equal(c4Schema?.properties?.timeoutMs?.default, 60000);
    assert.equal(c4Schema?.properties?.allowPrivateNetworks?.default, false);
    assert.deepEqual(c4Schema?.properties?.extract?.enum, ["markdown", "text"]);
    assert.equal(c4Schema?.properties?.extract?.default, "markdown");
    assert.equal(crawl4ai?.manifest.category, "datasource");
    assert.deepEqual(crawl4ai?.manifest.capabilities, ["ingestion"]);
    assert.equal(typeof crawl4ai?.manifest.ui?.icon, "string");
    assert.ok(crawl4ai?.manifest.ui?.formHints, "formHints present");
    assert.ok(crawl4ai?.manifest.secretsSchema, "secretsSchema present");

    const scrapy = registry.get({
      category: "datasource",
      id: "scrapy_spider",
      version: "1.0.0"
    });
    assert.ok(scrapy, "scrapy_spider registered");
    assert.equal(scrapy?.mode, "external");
    const sSchema = scrapy?.manifest.configSchema;
    assert.equal(sSchema?.type, "object");
    assert.deepEqual(sSchema?.required, ["startUrls"]);
    assert.equal(sSchema?.properties?.maxPages?.default, 20);
    assert.equal(sSchema?.properties?.maxDepth?.default, 2);
    assert.equal(sSchema?.properties?.allowPrivateNetworks?.default, false);

    // In-process plugins still discovered alongside external ones.
    assert.ok(registry.get({ category: "llm", id: "provider_chat", version: "1.0.0" }));
  } finally {
    await stub.close();
    if (priorUrl === undefined) delete process.env.PYTHON_PLUGIN_URL;
    else process.env.PYTHON_PLUGIN_URL = priorUrl;
    if (priorTimeout === undefined) delete process.env.PYTHON_PLUGIN_TIMEOUT_MS;
    else process.env.PYTHON_PLUGIN_TIMEOUT_MS = priorTimeout;
  }
});

test("loadRegistries also exposes the external crawler plugins", async () => {
  const stub = await startStub();
  const priorUrl = process.env.PYTHON_PLUGIN_URL;
  process.env.PYTHON_PLUGIN_URL = stub.baseUrl;
  try {
    const { plugins } = loadRegistries();
    assert.ok(
      plugins.get({ category: "datasource", id: "crawl4ai_crawler", version: "1.0.0" })
    );
    assert.ok(plugins.get({ category: "datasource", id: "scrapy_spider", version: "1.0.0" }));
  } finally {
    await stub.close();
    if (priorUrl === undefined) delete process.env.PYTHON_PLUGIN_URL;
    else process.env.PYTHON_PLUGIN_URL = priorUrl;
  }
});

test("default timeout used when PYTHON_PLUGIN_TIMEOUT_MS is unset", async () => {
  const stub = await startStub();
  const priorUrl = process.env.PYTHON_PLUGIN_URL;
  const priorTimeout = process.env.PYTHON_PLUGIN_TIMEOUT_MS;
  process.env.PYTHON_PLUGIN_URL = stub.baseUrl;
  delete process.env.PYTHON_PLUGIN_TIMEOUT_MS;
  try {
    const registry = loadPluginRegistry();
    const crawl4ai = registry.get({
      category: "datasource",
      id: "crawl4ai_crawler",
      version: "1.0.0"
    });
    assert.equal(crawl4ai?.external?.timeoutMs, 300000);
  } finally {
    await stub.close();
    if (priorUrl === undefined) delete process.env.PYTHON_PLUGIN_URL;
    else process.env.PYTHON_PLUGIN_URL = priorUrl;
    if (priorTimeout === undefined) delete process.env.PYTHON_PLUGIN_TIMEOUT_MS;
    else process.env.PYTHON_PLUGIN_TIMEOUT_MS = priorTimeout;
  }
});
