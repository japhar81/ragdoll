/**
 * cloudquery_aws_sync manifest contract tests.
 *
 * The handler runs in the python-plugins sidecar (mode: "external"), so
 * the TS side has no `execute()` to exercise — these tests lock the
 * manifest the runtime + UI + spec validator depend on. Subprocess
 * behaviour (spec-YAML emission, env injection, exit handling) is
 * tested in the Python sidecar's own test suite under
 * `services/python-plugins/tests/test_cloudquery_aws_sync.py`.
 *
 * Seam discipline reminder (per ADR-0033):
 *   bulwark AUTHORS pipelines that USE this plugin. RAGdoll PULLS.
 *   Manifest changes that imply RAGdoll-side resolution/correlation
 *   should be reviewed against the seam.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  cloudqueryAwsSyncManifest,
  CLOUDQUERY_AWS_ALLOWED_TABLES,
  CLOUDQUERY_AWS_DEFAULT_TABLES,
  CLOUDQUERY_WRITE_MODES
} from "../src/cloudquery.ts";
import { loadPluginRegistry } from "../../../packages/plugin-loader/src/index.ts";

test("cloudquery_aws_sync manifest: id / category / contract are stable", () => {
  assert.equal(cloudqueryAwsSyncManifest.id, "cloudquery_aws_sync");
  assert.equal(cloudqueryAwsSyncManifest.category, "datasource");
  assert.equal(cloudqueryAwsSyncManifest.contract, 2);
});

test("cloudquery_aws_sync manifest: requires a postgres 'destination' binding (NOT host/port in config)", () => {
  // ADR-0023 binding shape: per the PluginManifest.requires contract, a
  // plugin that declares `requires` MUST NOT also expose host/port/URL
  // in its `configSchema` — the dataset connection is the single source
  // of truth. This test pins both halves.
  const requires = cloudqueryAwsSyncManifest.requires as unknown as Array<{
    binding?: string;
    kind?: string;
  }>;
  assert.ok(Array.isArray(requires) && requires.length === 1);
  assert.equal(requires[0].binding, "destination");
  assert.equal(requires[0].kind, "postgres");

  // No host/port/url/dsn anywhere in the configSchema — contract guard.
  const schema = cloudqueryAwsSyncManifest.configSchema as {
    properties?: Record<string, unknown>;
  };
  const propNames = Object.keys(schema.properties ?? {}).map((k) => k.toLowerCase());
  for (const forbidden of ["host", "port", "url", "baseurl", "dsn", "connectionstring"]) {
    assert.ok(
      !propNames.includes(forbidden),
      `configSchema must NOT expose ${forbidden} — destination binding owns it`
    );
  }
});

test("cloudquery_aws_sync manifest: tables enum mirrors the TS allowlist verbatim (no drift)", () => {
  const schema = cloudqueryAwsSyncManifest.configSchema as {
    required?: string[];
    properties?: Record<string, { items?: { enum?: unknown[] }; default?: unknown }>;
  };
  assert.deepEqual(schema.required, ["tables"]);
  const tablesProp = schema.properties?.tables;
  assert.deepEqual(tablesProp?.items?.enum, [...CLOUDQUERY_AWS_ALLOWED_TABLES]);
  // Default is the route-table set (Z6a headline scope).
  assert.deepEqual(tablesProp?.default, [...CLOUDQUERY_AWS_DEFAULT_TABLES]);
});

test("cloudquery_aws_sync manifest: route-table tables are in the default + allowlist (Z6a headline)", () => {
  // If route tables ever fall out of the default, the scheduled
  // pipeline Z6a depends on would silently sync nothing useful.
  assert.ok(CLOUDQUERY_AWS_DEFAULT_TABLES.includes("aws_ec2_route_tables"));
  assert.ok(CLOUDQUERY_AWS_DEFAULT_TABLES.includes("aws_ec2_routes"));
  for (const t of CLOUDQUERY_AWS_DEFAULT_TABLES) {
    assert.ok(
      (CLOUDQUERY_AWS_ALLOWED_TABLES as readonly string[]).includes(t),
      `default table ${t} must also be in the allowlist`
    );
  }
});

test("cloudquery_aws_sync manifest: writeMode enum + runner enum are surfaced", () => {
  const schema = cloudqueryAwsSyncManifest.configSchema as {
    properties?: Record<string, { enum?: unknown[]; default?: unknown }>;
  };
  assert.deepEqual(schema.properties?.writeMode?.enum, [...CLOUDQUERY_WRITE_MODES]);
  assert.equal(schema.properties?.writeMode?.default, "overwrite");
  assert.deepEqual(schema.properties?.runner?.enum, ["subprocess", "dry-run"]);
  assert.equal(schema.properties?.runner?.default, "subprocess");
  // 30-minute default timeout — matches cartography_crawl (long syncs are normal).
  assert.equal(schema.properties?.timeoutMs?.default, 1_800_000);
});

test("cloudquery_aws_sync manifest: credsSecretRef is a secret-ref AND warns about the dual-declaration trap", () => {
  // The "wired one half, not the other" gotcha — without `node.secrets`
  // the runtime never resolves anything and cloudquery silently syncs
  // nothing. Same warning shape cartography_crawl learned the hard way.
  const schema = cloudqueryAwsSyncManifest.configSchema as {
    properties?: Record<string, { format?: string; description?: string }>;
  };
  assert.equal(schema.properties?.credsSecretRef?.format, "secret-ref");
  const desc = schema.properties?.credsSecretRef?.description ?? "";
  assert.match(desc, /node\.secrets/);
  assert.match(desc, /not enough/i);
});

test("cloudquery_aws_sync manifest: outputs a single `metadata` port (pure transport telemetry)", () => {
  const out = cloudqueryAwsSyncManifest.outputPorts ?? [];
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "metadata");
  // The description should call out the seam — bulwark reads the
  // ROWS from Postgres directly; this output is just sync telemetry.
  assert.match(
    out[0].description ?? "",
    /bulwark reads the actual rows back from Postgres/i
  );
});

test("cloudquery_aws_sync manifest: declares streaming so the trace UI sees progress", () => {
  // 30-min syncs without streaming look like a stalled worker.
  assert.equal(cloudqueryAwsSyncManifest.streaming, true);
});

test("cloudquery_aws_sync manifest: description carries the seam-discipline rule (RAGdoll PULLS only)", () => {
  // The seam discipline is the load-bearing decision behind this
  // whole plugin. If the description stops carrying it, the next
  // contributor won't know not to add canonical-mapping logic here.
  const d = cloudqueryAwsSyncManifest.description ?? "";
  assert.match(d, /Seam discipline/i);
  assert.match(d, /RAGdoll PULLS only/i);
  assert.match(d, /bulwark/i);
});

// ---------------------------------------------------------------------------
// Loader registration
// ---------------------------------------------------------------------------

test("plugin-loader: cloudquery_aws_sync is registered as external when PYTHON_PLUGIN_URL is set", () => {
  const prev = process.env.PYTHON_PLUGIN_URL;
  process.env.PYTHON_PLUGIN_URL = "http://python-plugins:8000";
  try {
    const registry = loadPluginRegistry();
    const reg = registry.get({
      category: "datasource",
      id: "cloudquery_aws_sync",
      version: "1.0.0"
    });
    assert.ok(reg, "cloudquery_aws_sync should be registered");
    assert.equal(reg!.mode, "external");
    assert.equal(reg!.implementation, undefined);
    assert.equal(reg!.external?.baseUrl, "http://python-plugins:8000");
    // Long-default timeout — multi-region AWS syncs run for tens of
    // minutes; same budget cartography_crawl gets.
    assert.equal(reg!.external?.timeoutMs, 1_800_000);
  } finally {
    if (prev === undefined) delete process.env.PYTHON_PLUGIN_URL;
    else process.env.PYTHON_PLUGIN_URL = prev;
  }
});

test("plugin-loader: cloudquery_aws_sync is NOT registered when PYTHON_PLUGIN_URL is unset", () => {
  const prev = process.env.PYTHON_PLUGIN_URL;
  delete process.env.PYTHON_PLUGIN_URL;
  try {
    const registry = loadPluginRegistry();
    const reg = registry.get({
      category: "datasource",
      id: "cloudquery_aws_sync",
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

test("plugin-loader: PYTHON_PLUGIN_CLOUDQUERY_TIMEOUT_MS overrides the default", () => {
  const prevUrl = process.env.PYTHON_PLUGIN_URL;
  const prevTimeout = process.env.PYTHON_PLUGIN_CLOUDQUERY_TIMEOUT_MS;
  process.env.PYTHON_PLUGIN_URL = "http://python-plugins:8000";
  process.env.PYTHON_PLUGIN_CLOUDQUERY_TIMEOUT_MS = "987654";
  try {
    const registry = loadPluginRegistry();
    const reg = registry.get({
      category: "datasource",
      id: "cloudquery_aws_sync",
      version: "1.0.0"
    });
    assert.equal(reg!.external?.timeoutMs, 987654);
  } finally {
    if (prevUrl === undefined) delete process.env.PYTHON_PLUGIN_URL;
    else process.env.PYTHON_PLUGIN_URL = prevUrl;
    if (prevTimeout === undefined) delete process.env.PYTHON_PLUGIN_CLOUDQUERY_TIMEOUT_MS;
    else process.env.PYTHON_PLUGIN_CLOUDQUERY_TIMEOUT_MS = prevTimeout;
  }
});
