/**
 * PLUGIN-ARCH-2: RAGdoll-side discovery of git-loaded sidecar plugins.
 *
 * The sidecar exposes `GET /manifests` listing every plugin it loaded
 * from a git repo (with its manifest dict + provenance).
 * `registerSidecarGitPlugins` queries it and registers each as an
 * external plugin pointed at the sidecar — so a git-loaded Python
 * plugin appears in RAGdoll's catalog + builder palette.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  registerSidecarGitPlugins,
  applyExternalPlugins
} from "../src/index.ts";
import { PluginRegistry } from "../../plugin-sdk/src/index.ts";

/** Stub sidecar that serves a fixed `/manifests` body. */
function startManifestStub(body: unknown, opts: { status?: number } = {}): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  manifestHits: () => number;
}> {
  let hits = 0;
  const server = http.createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/manifests") {
        hits += 1;
        res.writeHead(opts.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(404);
      res.end();
    }
  );
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        manifestHits: () => hits,
        close: () =>
          new Promise<void>((done) => server.close(() => done()))
      });
    });
  });
}

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  body: () => Promise<T>
): Promise<T> {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await body();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("registerSidecarGitPlugins: registers each /manifests plugin with its manifest + git provenance", async () => {
  const stub = await startManifestStub({
    plugins: [
      {
        id: "acme_hello",
        manifest: {
          id: "acme_hello",
          name: "Acme Hello",
          version: "2.0.0",
          category: "datasource",
          description: "git-loaded",
          outputPorts: [{ name: "out" }]
        },
        source: { repoId: "acme", kind: "git", commitSha: "a".repeat(40) }
      }
    ]
  });
  try {
    await withEnv({ PYTHON_PLUGIN_URL: stub.baseUrl }, async () => {
      const registry = new PluginRegistry();
      await registerSidecarGitPlugins(registry);
      const reg = registry.get({
        category: "datasource",
        id: "acme_hello",
        version: "2.0.0"
      });
      assert.ok(reg, "git-loaded plugin must be registered");
      assert.equal(reg!.mode, "external");
      assert.equal(reg!.external?.baseUrl, stub.baseUrl);
      assert.equal(reg!.manifest.name, "Acme Hello");
      // Provenance carries the git source + sha for the catalog badge.
      assert.equal(reg!.source?.repoId, "acme");
      assert.equal(reg!.source?.kind, "git");
      assert.equal(reg!.source?.commitSha, "a".repeat(40));
    });
  } finally {
    await stub.close();
  }
});

test("registerSidecarGitPlugins: synthesises a minimal manifest when the module omits MANIFEST", async () => {
  const stub = await startManifestStub({
    plugins: [
      {
        id: "bare_plugin",
        manifest: null,
        source: { repoId: "vendor", kind: "git", commitSha: "b".repeat(40) }
      }
    ]
  });
  try {
    await withEnv({ PYTHON_PLUGIN_URL: stub.baseUrl }, async () => {
      const registry = new PluginRegistry();
      await registerSidecarGitPlugins(registry);
      const reg = registry.get({
        category: "datasource",
        id: "bare_plugin",
        version: "1.0.0"
      });
      assert.ok(reg, "plugin with no MANIFEST still registers + runs");
      assert.equal(reg!.manifest.id, "bare_plugin");
      assert.equal(reg!.mode, "external");
      assert.match(reg!.manifest.description, /vendor/);
    });
  } finally {
    await stub.close();
  }
});

test("registerSidecarGitPlugins: no PYTHON_PLUGIN_URL → no-op (no fetch attempted)", async () => {
  await withEnv({ PYTHON_PLUGIN_URL: undefined }, async () => {
    const registry = new PluginRegistry();
    await registerSidecarGitPlugins(registry);
    assert.equal(registry.list().length, 0);
  });
});

test("registerSidecarGitPlugins: sidecar 404 on /manifests (older image) → silent no-op", async () => {
  const stub = await startManifestStub({}, { status: 404 });
  try {
    await withEnv({ PYTHON_PLUGIN_URL: stub.baseUrl }, async () => {
      const registry = new PluginRegistry();
      await registerSidecarGitPlugins(registry);
      assert.equal(registry.list().length, 0);
    });
  } finally {
    await stub.close();
  }
});

test("registerSidecarGitPlugins: sidecar unreachable → silent no-op (registry still usable)", async () => {
  // Point at a port nothing is listening on.
  await withEnv({ PYTHON_PLUGIN_URL: "http://127.0.0.1:1" }, async () => {
    const registry = new PluginRegistry();
    await registerSidecarGitPlugins(registry); // must not throw
    assert.equal(registry.list().length, 0);
  });
});

test("applyExternalPlugins: layers hardcoded built-in sidecar manifests AND git-loaded plugins", async () => {
  const stub = await startManifestStub({
    plugins: [
      {
        id: "git_only",
        manifest: {
          id: "git_only",
          name: "Git Only",
          version: "1.0.0",
          category: "datasource",
          description: "x"
        },
        source: { repoId: "r", kind: "git", commitSha: "c".repeat(40) }
      }
    ]
  });
  try {
    await withEnv({ PYTHON_PLUGIN_URL: stub.baseUrl }, async () => {
      const registry = new PluginRegistry();
      await applyExternalPlugins(registry);
      // Hardcoded built-in sidecar plugin (cartography) present...
      assert.ok(
        registry.get({
          category: "datasource",
          id: "cartography_crawl",
          version: "1.0.0"
        }),
        "hardcoded built-in sidecar manifest must be layered"
      );
      // ...AND the git-loaded one.
      assert.ok(
        registry.get({
          category: "datasource",
          id: "git_only",
          version: "1.0.0"
        }),
        "git-loaded sidecar plugin must be layered"
      );
    });
  } finally {
    await stub.close();
  }
});
