/**
 * cartography_crawl manifest contract tests.
 *
 * After ADR-0025 the cartography handler runs in the python-plugins
 * sidecar, so the TS side has no `execute()` to exercise — the tests
 * here lock the manifest the runtime + UI + spec validator depend on.
 *
 * Subprocess behaviour (argv shape, env injection, exit handling) is
 * tested in the Python sidecar's own test suite under
 * `services/python-plugins/tests/`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  cartographyCrawlManifest,
  CARTOGRAPHY_MODULES
} from "../src/cartography.ts";
import { loadPluginRegistry } from "../../../packages/plugin-loader/src/index.ts";

test("cartography_crawl manifest: id / category / contract are stable", () => {
  assert.equal(cartographyCrawlManifest.id, "cartography_crawl");
  assert.equal(cartographyCrawlManifest.category, "datasource");
  assert.equal(cartographyCrawlManifest.contract, 2);
});

test("cartography_crawl manifest: requires a neo4j 'target' binding", () => {
  // ADR-0023 binding-shape requires entry. The validator surfaces a
  // `dataset_binding_kind_mismatch` error at /validate when this isn't
  // satisfied — which is the whole reason bulwark's blocker #5 got
  // server-side validation in the first place.
  const requires = cartographyCrawlManifest.requires as unknown as Array<{
    binding?: string;
    kind?: string;
  }>;
  assert.ok(Array.isArray(requires) && requires.length === 1);
  assert.equal(requires[0].binding, "target");
  assert.equal(requires[0].kind, "neo4j");
});

test("cartography_crawl manifest: modules enum + runner + timeout are surfaced on configSchema", () => {
  const schema = cartographyCrawlManifest.configSchema as {
    required?: string[];
    properties?: Record<string, { enum?: unknown[]; default?: unknown; items?: { enum?: unknown[] } }>;
  };
  assert.deepEqual(schema.required, ["modules"]);
  const modulesProp = schema.properties?.modules;
  // Items.enum must mirror the TS allowlist verbatim so the UI picker
  // and the validator agree on the universe. (Adding a module on one
  // side without the other = quiet silent dropdown drift.)
  const items = modulesProp?.items as { enum?: unknown[] };
  assert.deepEqual(items.enum, [...CARTOGRAPHY_MODULES]);
  // runner: subprocess | dry-run
  const runnerEnum = schema.properties?.runner?.enum as string[] | undefined;
  assert.deepEqual(runnerEnum, ["subprocess", "dry-run"]);
  assert.equal(schema.properties?.runner?.default, "subprocess");
  // timeout default is 30 min
  assert.equal(schema.properties?.timeoutMs?.default, 1_800_000);
});

test("cartography_crawl manifest: outputs a single `metadata` port", () => {
  const out = cartographyCrawlManifest.outputPorts ?? [];
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "metadata");
});

// ---------------------------------------------------------------------------
// Loader registration
// ---------------------------------------------------------------------------

test("plugin-loader: cartography_crawl is registered as external when PYTHON_PLUGIN_URL is set", () => {
  const prev = process.env.PYTHON_PLUGIN_URL;
  process.env.PYTHON_PLUGIN_URL = "http://python-plugins:8000";
  try {
    const registry = loadPluginRegistry();
    const reg = registry.get({
      category: "datasource",
      id: "cartography_crawl",
      version: "1.0.0"
    });
    assert.ok(reg, "cartography_crawl should be registered");
    assert.equal(reg!.mode, "external");
    assert.equal(reg!.external?.baseUrl, "http://python-plugins:8000");
    // Per-plugin timeout: cartography uses the longer default (30 min)
    // because real cloud crawls routinely run that long.
    assert.equal(reg!.external?.timeoutMs, 1_800_000);
  } finally {
    if (prev === undefined) delete process.env.PYTHON_PLUGIN_URL;
    else process.env.PYTHON_PLUGIN_URL = prev;
  }
});

test("plugin-loader: cartography_crawl is NOT registered when PYTHON_PLUGIN_URL is unset", () => {
  const prev = process.env.PYTHON_PLUGIN_URL;
  delete process.env.PYTHON_PLUGIN_URL;
  try {
    const registry = loadPluginRegistry();
    const reg = registry.get({
      category: "datasource",
      id: "cartography_crawl",
      version: "1.0.0"
    });
    assert.equal(
      reg,
      undefined,
      "without PYTHON_PLUGIN_URL the loader should skip the external sidecar plugins"
    );
  } finally {
    if (prev !== undefined) process.env.PYTHON_PLUGIN_URL = prev;
  }
});
