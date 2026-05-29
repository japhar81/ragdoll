/**
 * Tests for the dataset resolver's new connection-wiring path (PR2).
 *
 * Setup: one global dataset whose `backends.vector` block references a
 * connection by name. The resolver walks (env→tenant→global) for the
 * dataset itself (existing path), then (env→tenant-wide) for the
 * connection lookup (the per-tenant cascade PR1 added).
 *
 * What the tests prove:
 *   - Global dataset + tenant-wide connection → both resolve, plugin
 *     sees `backends.vector.connection.host`.
 *   - Per-env connection override beats the tenant-wide one when the
 *     caller's env matches.
 *   - Different tenants get different connections from the SAME
 *     global dataset slug — the user's "Tenant A vs Tenant B" example.
 *   - Connection-less backend block flows through unchanged (plugin
 *     reads only `provider` / `collection` from it).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildHarness } from "./helpers.ts";
import { buildApiDatasetResolver } from "../src/app/pipeline-execution.ts";

interface SetupOpts {
  globalDatasetBackends: Record<string, Record<string, unknown>>;
  /** Per-tenant connection rows. tenantId map → array of (envId?, name, config). */
  connections: Array<{
    tenantId: string;
    environmentId?: string | null;
    name: string;
    type: string;
    config: Record<string, unknown>;
  }>;
}

async function setup(opts: SetupOpts) {
  const h = buildHarness();
  const now = new Date().toISOString();
  // One global dataset all tenants share.
  const datasetId = randomUUID();
  const versionId = randomUUID();
  await h.deps.datasets!.create({
    id: datasetId,
    scope: "global",
    tenantId: null,
    environmentId: null,
    slug: "shared-docs",
    displayName: "Shared docs",
    description: null,
    embeddingProfile: {},
    chunkSchema: {},
    modalities: Object.keys(opts.globalDatasetBackends),
    backends: opts.globalDatasetBackends,
    currentVersionId: versionId,
    archivedAt: null,
    createdAt: now,
    createdBy: null,
    updatedAt: now
  });
  await h.deps.datasetVersions!.create({
    id: versionId,
    datasetId,
    versionLabel: "v1",
    schemaSpec: {},
    backendCollections: { vector: "docs_v1", text: "docs_v1" },
    status: "ready",
    docCount: 0,
    sizeBytes: 0,
    createdAt: now,
    readyAt: now
  });
  for (const c of opts.connections) {
    await h.deps.datasources!.create({
      id: randomUUID(),
      tenantId: c.tenantId,
      environmentId: c.environmentId ?? null,
      name: c.name,
      datasourceType: c.type,
      secretRefId: null,
      configRedacted: c.config,
      allowedHosts: [],
      denyPrivateNetworks: true,
      createdAt: now,
      updatedAt: now
    });
  }
  return { h, resolver: buildApiDatasetResolver(h.deps)! };
}

test("global dataset + tenant-wide connection → plugin sees host/type/cascadeReason", async () => {
  const { resolver } = await setup({
    globalDatasetBackends: {
      vector: { provider: "opensearch", connectionName: "os", index: "docs" }
    },
    connections: [
      {
        tenantId: "tA",
        environmentId: null,
        name: "os",
        type: "opensearch",
        config: { host: "os.tenantA.example", port: 9200 }
      }
    ]
  });
  const r = await resolver.resolve({
    ref: { slug: "shared-docs", alias: "stable" },
    tenantId: "tA",
    environmentId: "dev"
  });
  assert.ok(r, "dataset resolves");
  // Existing backendCollections path keeps working — pickBackendName() reads it.
  assert.equal(r.backendCollections.vector, "docs_v1");
  // New backends path with connection injection.
  const v = r.backends.vector;
  assert.equal(v.provider, "opensearch");
  assert.equal(v.connectionName, "os");
  assert.equal(v.index, "docs", "raw backend fields flow through unchanged");
  assert.ok(v.connection, "connection injected");
  assert.equal(v.connection!.host, "os.tenantA.example");
  assert.equal(v.connection!.type, "opensearch");
  assert.equal(v.connection!.cascadeReason, "tenant_fallback");
});

test("per-env connection beats tenant-wide when caller env matches", async () => {
  const { resolver } = await setup({
    globalDatasetBackends: {
      vector: { provider: "opensearch", connectionName: "os" }
    },
    connections: [
      // Tenant-wide row (fallback).
      {
        tenantId: "tB",
        environmentId: null,
        name: "os",
        type: "opensearch",
        config: { host: "os-wide.tenantB.example" }
      },
      // Prod-specific override.
      {
        tenantId: "tB",
        environmentId: "prod",
        name: "os",
        type: "opensearch",
        config: { host: "os-prod.tenantB.example" }
      }
    ]
  });
  const prod = await resolver.resolve({
    ref: { slug: "shared-docs" },
    tenantId: "tB",
    environmentId: "prod"
  });
  assert.equal(prod!.backends.vector.connection!.host, "os-prod.tenantB.example");
  assert.equal(prod!.backends.vector.connection!.cascadeReason, "env_specific");
  const dev = await resolver.resolve({
    ref: { slug: "shared-docs" },
    tenantId: "tB",
    environmentId: "dev"
  });
  // dev has no override → falls through to the tenant-wide row.
  assert.equal(dev!.backends.vector.connection!.host, "os-wide.tenantB.example");
  assert.equal(dev!.backends.vector.connection!.cascadeReason, "tenant_fallback");
});

test("different tenants get different connections from the same global dataset", async () => {
  // The user's Tenant A vs Tenant B example: one cluster vs three.
  const { resolver } = await setup({
    globalDatasetBackends: {
      vector: { provider: "opensearch", connectionName: "os" }
    },
    connections: [
      {
        tenantId: "tA",
        environmentId: null,
        name: "os",
        type: "opensearch",
        config: { host: "os.tenantA.example" }
      },
      {
        tenantId: "tB",
        environmentId: "dev",
        name: "os",
        type: "opensearch",
        config: { host: "os-dev.tenantB.example" }
      },
      {
        tenantId: "tB",
        environmentId: "prod",
        name: "os",
        type: "opensearch",
        config: { host: "os-prod.tenantB.example" }
      }
    ]
  });
  // tA in prod → tenant-wide row (their single cluster).
  const a = await resolver.resolve({
    ref: { slug: "shared-docs" },
    tenantId: "tA",
    environmentId: "prod"
  });
  assert.equal(a!.backends.vector.connection!.host, "os.tenantA.example");
  // tB in prod → their prod cluster.
  const b = await resolver.resolve({
    ref: { slug: "shared-docs" },
    tenantId: "tB",
    environmentId: "prod"
  });
  assert.equal(b!.backends.vector.connection!.host, "os-prod.tenantB.example");
});

test("backend block without connectionName flows through with no connection", async () => {
  const { resolver } = await setup({
    globalDatasetBackends: {
      vector: { provider: "opensearch", index: "docs" }
    },
    connections: []
  });
  const r = await resolver.resolve({
    ref: { slug: "shared-docs" },
    tenantId: "tA",
    environmentId: "prod"
  });
  assert.equal(r!.backends.vector.provider, "opensearch");
  assert.equal(r!.backends.vector.index, "docs");
  assert.equal(r!.backends.vector.connection, undefined);
});

test("connectionName that doesn't resolve still flows the rest of the block through", async () => {
  // Operator declared the binding but the connection row isn't there
  // yet — block should still come back with provider/index/etc, just
  // without a `connection`. PR3's plugins will reject if they need it.
  const { resolver } = await setup({
    globalDatasetBackends: {
      vector: { provider: "opensearch", connectionName: "missing", index: "docs" }
    },
    connections: []
  });
  const r = await resolver.resolve({
    ref: { slug: "shared-docs" },
    tenantId: "tA",
    environmentId: "prod"
  });
  assert.equal(r!.backends.vector.connectionName, "missing");
  assert.equal(r!.backends.vector.connection, undefined);
  assert.equal(r!.backends.vector.index, "docs");
});
