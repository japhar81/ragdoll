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
  applyExternalPlugins,
  pushSidecarSources,
  buildPluginRegistry,
  InMemoryPluginSourceStore,
  __clearPluginCacheForTests,
  type PluginSource
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

// ---------------------------------------------------------------------------
// pushSidecarSources — single source of truth: RAGdoll pushes
// host:"sidecar" plugin_sources rows to the sidecar's /admin/reload.
// ---------------------------------------------------------------------------

/** Stub sidecar that records the /admin/reload body + token, replies
 *  with a status report. */
function startReloadStub(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  lastBody: () => unknown;
  lastToken: () => string | undefined;
}> {
  let body: unknown;
  let token: string | undefined;
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url === "/admin/reload") {
      token = req.headers["x-ragdoll-admin-token"] as string | undefined;
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const sources = (body as { sources?: Array<{ id: string }> }).sources ?? [];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sources: sources.map((s) => ({
              id: s.id,
              status: "loaded",
              pluginCount: 1,
              commitSha: "f".repeat(40),
              error: null,
              errorStage: null,
              pluginIds: [`${s.id}_plug`]
            }))
          })
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        lastBody: () => body,
        lastToken: () => token,
        close: () => new Promise<void>((done) => server.close(() => done()))
      });
    });
  });
}

const sidecarRow = (id: string): PluginSource => ({
  id,
  kind: "git",
  host: "sidecar",
  enabled: true,
  gitUrl: `https://git.invalid/${id}.git`,
  ref: "main",
  subpath: "plugins"
});

const workerRow = (id: string): PluginSource => ({
  id,
  kind: "git",
  host: "worker",
  enabled: true,
  gitUrl: `https://git.invalid/${id}.git`,
  ref: "main"
});

test("pushSidecarSources: POSTs ONLY host:sidecar rows to /admin/reload with the admin token; marks results on the store", async () => {
  const stub = await startReloadStub();
  const store = new InMemoryPluginSourceStore([
    sidecarRow("py_a"),
    workerRow("ts_b") // must NOT be pushed
  ]);
  try {
    await withEnv(
      {
        PYTHON_PLUGIN_URL: stub.baseUrl,
        RAGDOLL_SIDECAR_ADMIN_TOKEN: "sekret"
      },
      async () => {
        const result = await pushSidecarSources(store);
        assert.equal(result.pushed, true);
        assert.equal(stub.lastToken(), "sekret");
        // Only the sidecar row is in the pushed body.
        const sources = (stub.lastBody() as { sources: Array<{ id: string }> })
          .sources;
        assert.deepEqual(sources.map((s) => s.id), ["py_a"]);
        // The sidecar's status was marked on the store row.
        const row = await store.get!("py_a");
        assert.equal(row?.lastLoadOk, true);
        assert.equal(row?.lastCommitSha, "f".repeat(40));
      }
    );
  } finally {
    await stub.close();
  }
});

test("pushSidecarSources: pushes an EMPTY list when there are no sidecar rows (so a removed source is dropped)", async () => {
  const stub = await startReloadStub();
  const store = new InMemoryPluginSourceStore([workerRow("ts_only")]);
  try {
    await withEnv({ PYTHON_PLUGIN_URL: stub.baseUrl }, async () => {
      const result = await pushSidecarSources(store);
      assert.equal(result.pushed, true);
      const sources = (stub.lastBody() as { sources: unknown[] }).sources;
      assert.deepEqual(sources, []);
    });
  } finally {
    await stub.close();
  }
});

test("pushSidecarSources: no PYTHON_PLUGIN_URL → not pushed, no throw", async () => {
  const store = new InMemoryPluginSourceStore([sidecarRow("py_a")]);
  await withEnv({ PYTHON_PLUGIN_URL: undefined }, async () => {
    const result = await pushSidecarSources(store);
    assert.equal(result.pushed, false);
    assert.match(result.reason ?? "", /PYTHON_PLUGIN_URL/);
  });
});

test("pushSidecarSources: sidecar unreachable → not pushed, reason surfaced, no throw", async () => {
  const store = new InMemoryPluginSourceStore([sidecarRow("py_a")]);
  await withEnv({ PYTHON_PLUGIN_URL: "http://127.0.0.1:1" }, async () => {
    const result = await pushSidecarSources(store);
    assert.equal(result.pushed, false);
    assert.match(result.reason ?? "", /unreachable/);
  });
});

test("buildPluginRegistry: host:sidecar rows are NOT loaded in-process (they're pushed to the sidecar instead)", async () => {
  __clearPluginCacheForTests();
  // A sidecar row with a bogus git URL. If the in-process lifecycle
  // TRIED to load it, it'd appear in the statuses as a failed source.
  // It must be skipped entirely.
  const store = new InMemoryPluginSourceStore([sidecarRow("py_skip")]);
  const { statuses } = await buildPluginRegistry({
    store,
    loadOpts: {
      resolveBuiltinPath: (s) => `__memory__/${s.id}/local/`,
      importFn: async () => ({})
    }
  });
  // Only the two built-in (local) sources were walked — the sidecar
  // row never reached the lifecycle.
  assert.ok(!statuses.some((s) => s.id === "py_skip"));
  assert.ok(statuses.every((s) => s.kind === "local"));
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
