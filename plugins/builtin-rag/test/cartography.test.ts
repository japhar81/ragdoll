/**
 * cartography_crawl unit tests (ADR-0025). Offline — the spawn() call is
 * intercepted via `__setCartographySpawnerForTests` so no real
 * Cartography binary is required on the test PATH. Tests cover:
 *
 *   - manifest shape (third crawler beside crawl4ai + scrapy)
 *   - binding refusal (no target → clear error)
 *   - kind mismatch (target binding points at non-neo4j → clear error)
 *   - module enum guard (rejects unknown modules)
 *   - dry-run mode emits synthetic metadata, neo4j is never touched
 *   - subprocess mode assembles argv + env (NEO4J_URI / USER / PASSWORD,
 *     --selected-modules, accountSelectors mapping)
 *   - subprocess failure paths (non-zero exit → modules marked failed)
 *   - idempotency: re-running with the same config produces the same
 *     deterministic shape (modulo crawlId / timestamps)
 *   - pure helpers (`buildCartographyArgs`, `buildCartographyEnv`)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  cartographyCrawlPlugin,
  buildCartographyArgs,
  buildCartographyEnv,
  __setCartographySpawnerForTests,
  type CartographyRunArgs,
  CARTOGRAPHY_MODULES
} from "../src/cartography.ts";
import type {
  PluginExecutionInput,
  PluginExecutionOutput,
  ResolvedDataset
} from "../../../packages/plugin-sdk/src/index.ts";
import type { RuntimeContext } from "../../../packages/core/src/index.ts";
import type { ResolvedExternalConnection } from "../../../packages/external-connections/src/index.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fakeContext(): RuntimeContext {
  return {
    requestId: "r",
    executionId: "e-1",
    tenantId: "t-1",
    pipelineId: "p",
    pipelineVersionId: "v1",
    environment: "dev",
    resolvedConfig: {
      pipelineId: "p",
      tenantId: "t-1",
      environment: "dev",
      violations: [],
      values: {}
    }
  };
}

function fakeNeo4jConn(slug = "test-target"): ResolvedExternalConnection {
  return {
    id: `conn-${slug}`,
    slug,
    kind: "neo4j",
    options: { uri: "bolt://stub:7687", database: "stub-db" },
    secret: "stub-password",
    cascadeReason: "tenant"
  };
}

function fakeTargetDataset(opts: { wrongKind?: boolean; noUri?: boolean } = {}): ResolvedDataset {
  const baseConn = fakeNeo4jConn();
  const conn = opts.wrongKind
    ? { ...baseConn, kind: "qdrant" }
    : opts.noUri
      ? { ...baseConn, options: { database: "stub-db" } }
      : baseConn;
  return {
    id: "ds",
    slug: "ds",
    scope: "global",
    embeddingProfile: {},
    chunkSchema: {},
    version: { id: "v1", versionLabel: "v1", status: "ready" },
    bindings: {
      target: {
        connectionSlug: conn.slug,
        connectionKind: conn.kind,
        connectionHost: "stub",
        connectionPort: 7687,
        cascadeReason: "tenant",
        connection: conn
      }
    }
  };
}

function runPlugin(args: {
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
  dataset?: ResolvedDataset;
}): Promise<PluginExecutionOutput> {
  const input: PluginExecutionInput = {
    context: fakeContext(),
    node: {
      id: "n",
      plugin: {
        category: cartographyCrawlPlugin.manifest.category,
        id: cartographyCrawlPlugin.manifest.id,
        version: "1.0.0"
      }
    },
    inputs: {},
    config: args.config ?? {},
    secrets: args.secrets ?? {},
    dataset: args.dataset
  };
  return cartographyCrawlPlugin.execute(input);
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

test("cartography_crawl: manifest declares the third crawler beside crawl4ai + scrapy", () => {
  const m = cartographyCrawlPlugin.manifest;
  assert.equal(m.id, "cartography_crawl");
  assert.equal(m.category, "datasource");
  assert.equal(m.contract, 2);
  // Target binding — bulwark wires this to its working-graph.
  assert.deepEqual(m.requires, [{ binding: "target", kind: "neo4j" }]);
  // Module enum must be the curated set we surface in the UI dropdown.
  const cfg = m.configSchema as {
    properties?: { modules?: { items?: { enum?: string[] } } };
    required?: string[];
  };
  assert.ok(cfg.required?.includes("modules"));
  assert.deepEqual(
    cfg.properties?.modules?.items?.enum?.sort(),
    [...CARTOGRAPHY_MODULES].sort()
  );
  // No neo4j-URI / cloud-creds inlined in config — uri comes from the
  // target binding, creds via the secret ref. ADR-0023 hygiene.
  const props = (m.configSchema as { properties?: Record<string, unknown> }).properties;
  assert.equal(props?.uri, undefined);
  assert.equal(props?.host, undefined);
  // metadata is the only output port.
  assert.deepEqual(
    m.outputPorts?.map((p) => p.name),
    ["metadata"]
  );
});

// ---------------------------------------------------------------------------
// Binding hygiene
// ---------------------------------------------------------------------------

test("cartography_crawl: refuses to run without a target binding", async () => {
  await assert.rejects(
    runPlugin({ config: { modules: ["aws"] }, dataset: undefined }),
    /requires a "target" binding/
  );
});

test("cartography_crawl: refuses to run when target binding's kind isn't neo4j", async () => {
  await assert.rejects(
    runPlugin({ config: { modules: ["aws"] }, dataset: fakeTargetDataset({ wrongKind: true }) }),
    /expected "neo4j"/
  );
});

test("cartography_crawl: rejects unknown modules before any spawn happens", async () => {
  let spawned = 0;
  __setCartographySpawnerForTests(async () => {
    spawned++;
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  try {
    await assert.rejects(
      runPlugin({
        config: { modules: ["aws", "made_up_module"], runner: "subprocess" },
        dataset: fakeTargetDataset()
      }),
      /unknown module "made_up_module"/
    );
    assert.equal(spawned, 0, "spawn must not fire when module validation fails");
  } finally {
    __setCartographySpawnerForTests(null);
  }
});

test("cartography_crawl: rejects an empty modules list", async () => {
  await assert.rejects(
    runPlugin({ config: { modules: [] }, dataset: fakeTargetDataset() }),
    /at least one module/
  );
});

// ---------------------------------------------------------------------------
// dry-run
// ---------------------------------------------------------------------------

test("cartography_crawl dry-run: emits per-module synthetic metadata, never touches Cartography", async () => {
  let spawned = 0;
  __setCartographySpawnerForTests(async () => {
    spawned++;
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  try {
    const result = await runPlugin({
      config: { modules: ["aws", "gcp"], runner: "dry-run" },
      dataset: fakeTargetDataset()
    });
    const md = result.outputs.metadata as {
      mode: string;
      target: { connectionSlug: string };
      modules: Array<{ module: string; status: string }>;
      crawlId: string;
    };
    assert.equal(md.mode, "dry-run");
    assert.equal(md.target.connectionSlug, "test-target");
    assert.deepEqual(
      md.modules.map((m) => ({ module: m.module, status: m.status })),
      [
        { module: "aws", status: "skipped" },
        { module: "gcp", status: "skipped" }
      ]
    );
    assert.ok(md.crawlId.length > 0);
    assert.equal(spawned, 0, "dry-run must NOT spawn Cartography");
  } finally {
    __setCartographySpawnerForTests(null);
  }
});

test("cartography_crawl dry-run idempotency: re-running yields the same module shape", async () => {
  __setCartographySpawnerForTests(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  try {
    const first = (
      await runPlugin({
        config: { modules: ["aws"], runner: "dry-run" },
        dataset: fakeTargetDataset()
      })
    ).outputs.metadata as { modules: unknown; target: unknown; mode: string };
    const second = (
      await runPlugin({
        config: { modules: ["aws"], runner: "dry-run" },
        dataset: fakeTargetDataset()
      })
    ).outputs.metadata as { modules: unknown; target: unknown; mode: string };
    // The deterministic shape (mode + target + modules) must match
    // byte-for-byte across runs — crawlId / timestamps are the only
    // delta and are intentionally NOT compared.
    assert.deepEqual(first.modules, second.modules);
    assert.deepEqual(first.target, second.target);
    assert.equal(first.mode, second.mode);
  } finally {
    __setCartographySpawnerForTests(null);
  }
});

// ---------------------------------------------------------------------------
// Subprocess argv + env shape
// ---------------------------------------------------------------------------

test("cartography_crawl subprocess: argv carries --selected-modules + env carries NEO4J_* + creds", async () => {
  const calls: CartographyRunArgs[] = [];
  __setCartographySpawnerForTests(async (args) => {
    calls.push(args);
    return { exitCode: 0, stdout: "synced 12 nodes", stderr: "" };
  });
  try {
    const result = await runPlugin({
      config: {
        modules: ["aws", "gcp"],
        runner: "subprocess",
        cartographyBin: "/usr/local/bin/cartography",
        credsSecretRef: "creds",
        accountSelectors: {
          aws: { "sync-all-profiles": true },
          gcp: { "project-id": "demo-proj" }
        }
      },
      secrets: { creds: '{"aws_access_key_id":"AK","aws_secret_access_key":"SK"}' },
      dataset: fakeTargetDataset()
    });
    assert.equal(calls.length, 1, "exactly one spawn");
    const call = calls[0];
    // argv shape
    assert.equal(call.bin, "/usr/local/bin/cartography");
    assert.deepEqual(call.args.slice(0, 3), ["sync", "--selected-modules", "aws,gcp"]);
    assert.ok(call.args.includes("--aws-sync-all-profiles"));
    assert.ok(call.args.includes("--gcp-project-id"));
    assert.ok(call.args.includes("demo-proj"));
    // env shape
    assert.equal(call.env.NEO4J_URI, "bolt://stub:7687");
    assert.equal(call.env.NEO4J_USER, "neo4j");
    assert.equal(call.env.NEO4J_PASSWORD, "stub-password");
    assert.equal(
      call.env.CARTOGRAPHY_CREDS,
      '{"aws_access_key_id":"AK","aws_secret_access_key":"SK"}'
    );
    // Metadata reports success per module on exitCode 0.
    const md = result.outputs.metadata as {
      mode: string;
      exitCode: number | null;
      modules: Array<{ status: string }>;
    };
    assert.equal(md.mode, "subprocess");
    assert.equal(md.exitCode, 0);
    for (const m of md.modules) assert.equal(m.status, "succeeded");
  } finally {
    __setCartographySpawnerForTests(null);
  }
});

test("cartography_crawl subprocess: refuses when target binding lacks options.uri", async () => {
  __setCartographySpawnerForTests(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  try {
    await assert.rejects(
      runPlugin({
        config: { modules: ["aws"], runner: "subprocess" },
        dataset: fakeTargetDataset({ noUri: true })
      }),
      /no options\.uri/
    );
  } finally {
    __setCartographySpawnerForTests(null);
  }
});

test("cartography_crawl subprocess: non-zero exit marks every module failed with the stderr tail", async () => {
  __setCartographySpawnerForTests(async () => ({
    exitCode: 2,
    stdout: "",
    stderr: "ConnectionError: could not reach AWS STS"
  }));
  try {
    const result = await runPlugin({
      config: { modules: ["aws"], runner: "subprocess" },
      dataset: fakeTargetDataset()
    });
    const md = result.outputs.metadata as {
      exitCode: number | null;
      modules: Array<{ status: string; error?: string }>;
    };
    assert.equal(md.exitCode, 2);
    assert.equal(md.modules[0].status, "failed");
    assert.match(md.modules[0].error ?? "", /ConnectionError/);
  } finally {
    __setCartographySpawnerForTests(null);
  }
});

test("cartography_crawl subprocess: spawn error (e.g. ENOENT for missing binary) yields failed per module", async () => {
  __setCartographySpawnerForTests(async () => {
    const err = new Error("spawn cartography ENOENT");
    throw err;
  });
  try {
    const result = await runPlugin({
      config: { modules: ["aws"], runner: "subprocess" },
      dataset: fakeTargetDataset()
    });
    const md = result.outputs.metadata as {
      modules: Array<{ status: string; error?: string }>;
      exitCode: number | null;
    };
    assert.equal(md.exitCode, null);
    assert.equal(md.modules[0].status, "failed");
    assert.match(md.modules[0].error ?? "", /ENOENT/);
  } finally {
    __setCartographySpawnerForTests(null);
  }
});

// ---------------------------------------------------------------------------
// Pure helpers — assert wire shapes without touching the plugin's plumbing.
// ---------------------------------------------------------------------------

test("buildCartographyArgs: encodes modules + accountSelectors + incremental tag", () => {
  const args = buildCartographyArgs({
    modules: ["aws", "okta"],
    incremental: true,
    accountSelectors: { aws: { "sync-all-profiles": true } }
  });
  assert.deepEqual(args.slice(0, 3), ["sync", "--selected-modules", "aws,okta"]);
  // incremental sets --update-tag with a unix timestamp.
  const updateIdx = args.indexOf("--update-tag");
  assert.ok(updateIdx > 0, "--update-tag must be present");
  assert.ok(/^\d+$/.test(args[updateIdx + 1]));
  assert.ok(args.includes("--aws-sync-all-profiles"));
});

test("buildCartographyArgs: ignores account-selector flag names with shell-meta characters", () => {
  // Hostile config shouldn't reach the CLI even if a future caller
  // bypasses the validator. Flag-name sanitiser drops anything outside
  // [a-z0-9-].
  const args = buildCartographyArgs({
    modules: ["aws"],
    incremental: false,
    accountSelectors: { aws: { "evil; rm -rf /": "x", "ok-flag": "y" } }
  });
  assert.ok(!args.some((a) => a.includes("rm -rf")));
  assert.ok(args.includes("--aws-ok-flag"));
});

test("buildCartographyEnv: never includes a creds field when none was provided", () => {
  const env = buildCartographyEnv({
    neo4jUri: "bolt://x",
    neo4jUsername: "n",
    neo4jPassword: "p"
  });
  assert.deepEqual(env, { NEO4J_URI: "bolt://x", NEO4J_USER: "n", NEO4J_PASSWORD: "p" });
  assert.equal("CARTOGRAPHY_CREDS" in env, false);
});
