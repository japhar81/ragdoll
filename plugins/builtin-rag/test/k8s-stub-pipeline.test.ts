/**
 * k8s_list_pull stub run (Phase 3b acceptance).
 *
 * Wires the chain the brief calls out:
 *   k8s_list_pull → shape → neo4j_write
 *
 * Two passes through the same harness:
 *
 *   1. Clean pull — every page succeeds → `scan.complete: true`,
 *      resourceVersion from page 1 carried through, items written.
 *   2. Forced 410 mid-pagination — `scan.complete: false`,
 *      `scan.reason: "continue_410_gone"`, items present but the
 *      flag signals "trust nothing about absence." This is the
 *      central guard bulwark needs against delete-by-absence
 *      shredding placement history.
 *
 * Same inline-shape pattern as the wazuh stub test — keeps focus on
 * the wiring, not on JSONata expression syntax.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DagExecutor,
  InMemoryExecutionStore
} from "../../../packages/runtime/src/index.ts";
import {
  PluginRegistry,
  type ResolvedDataset,
  type InProcessPlugin
} from "../../../packages/plugin-sdk/src/index.ts";
import {
  registerConnectionDriver,
  resetConnectionRegistry,
  type ResolvedExternalConnection
} from "../../../packages/external-connections/src/index.ts";
import {
  DatabaseEncryptedSecretProvider,
  InMemorySecretRepository,
  StaticKeyProvider
} from "../../../packages/secrets/src/index.ts";
import type { PipelineSpec } from "../../../packages/core/src/index.ts";
import {
  k8sConnectionDriver,
  k8sListPullPlugin,
  __setK8sFetchForTests,
  type K8sFetch,
  type K8sScan
} from "../src/k8s.ts";
import { neo4jWritePlugin } from "../src/neo4j.ts";

// ---------------------------------------------------------------------------
// Shared scaffolding
// ---------------------------------------------------------------------------

function jsonRes(status: number, body: unknown): ReturnType<K8sFetch> {
  return Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body)
  });
}

interface CapturedWrite {
  cypher: string;
  params: Record<string, unknown>;
  database: string;
}

function setupNeo4jStub(captured: CapturedWrite[]): void {
  registerConnectionDriver(
    "neo4j",
    {
      async create() {
        return {
          driver: {
            session(opts: { database?: string }) {
              return {
                async run(
                  cypher: string,
                  params: Record<string, unknown>
                ): Promise<{ records: unknown[] }> {
                  captured.push({
                    cypher,
                    params,
                    database: opts.database ?? "neo4j"
                  });
                  return { records: [] };
                },
                async close(): Promise<void> {
                  /* no-op */
                }
              };
            },
            async verifyConnectivity(): Promise<void> {
              /* no-op */
            },
            async close(): Promise<void> {
              /* no-op */
            }
          },
          database: "neo4j",
          slug: "stub-neo4j",
          hasSecret: true,
          username: "neo4j"
        };
      },
      async dispose() {
        /* no-op */
      },
      async probe() {
        /* no-op */
      }
    },
    {
      displayName: "Neo4j (stub)",
      configSchema: { type: "object", properties: {} },
      datasetBindings: ["graph"],
      transport: "in_process"
    }
  );
}

function fakeDataset(): ResolvedDataset {
  const k8sConn: ResolvedExternalConnection = {
    id: "k8s-conn",
    slug: "k8s-test",
    kind: "k8s",
    options: { apiServerUrl: "https://k8s.test:6443", insecureSkipTlsVerify: true },
    secret: '{"token":"stub-sa-token"}',
    cascadeReason: "tenant"
  };
  const neo4jConn: ResolvedExternalConnection = {
    id: "neo4j-conn",
    slug: "neo4j-test",
    kind: "neo4j",
    options: { uri: "bolt://stub:7687", database: "neo4j" },
    secret: "x",
    cascadeReason: "tenant"
  };
  return {
    id: "ds-test",
    slug: "k8s-spine",
    scope: "tenant",
    tenantId: "t1",
    environmentId: undefined,
    embeddingProfile: {},
    chunkSchema: {},
    version: { id: "v1", versionLabel: "v1", status: "published" },
    bindings: {
      k8s: {
        connectionSlug: k8sConn.slug,
        connectionKind: k8sConn.kind,
        cascadeReason: "tenant",
        connection: k8sConn
      },
      graph: {
        connectionSlug: neo4jConn.slug,
        connectionKind: neo4jConn.kind,
        cascadeReason: "tenant",
        connection: neo4jConn
      }
    }
  } as unknown as ResolvedDataset;
}

/** Inline shape — flattens each scan's items into Cypher-ready rows
 *  and propagates the `complete` flag onto every row (so bulwark's
 *  diff sees the per-batch signal). Stands in for the JSONata
 *  `transform` plugin so the test is focused on wiring. */
const shapePlugin: InProcessPlugin = {
  manifest: {
    id: "k8s_test_shape",
    name: "k8s test shape",
    version: "1.0.0",
    category: "transformer",
    description: "Test-only inline shaper used by the stub run.",
    inputPorts: [{ name: "scans", description: "k8s_list_pull scans output" }],
    outputPorts: [{ name: "rows", description: "shaped resource rows" }]
  },
  async execute({ inputs }) {
    const scans = (inputs.scans ?? []) as K8sScan[];
    const rows: Array<Record<string, unknown>> = [];
    for (const scan of scans) {
      for (const item of scan.items) {
        const meta = (item as { metadata?: { name?: string; uid?: string } }).metadata ?? {};
        rows.push({
          id: meta.uid ?? meta.name ?? "",
          name: meta.name,
          kind: scan.kind,
          resourceVersion: scan.resourceVersion,
          scanComplete: scan.complete
        });
      }
    }
    return { outputs: { rows } };
  }
};

function buildRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register({
    mode: "in_process",
    manifest: k8sListPullPlugin.manifest,
    implementation: k8sListPullPlugin
  });
  registry.register({
    mode: "in_process",
    manifest: shapePlugin.manifest,
    implementation: shapePlugin
  });
  registry.register({
    mode: "in_process",
    manifest: neo4jWritePlugin.manifest,
    implementation: neo4jWritePlugin
  });
  return registry;
}

const spec: PipelineSpec = {
  apiVersion: "rag-platform/v1",
  kind: "Pipeline",
  metadata: { name: "k8s-stub-spine" },
  spec: {
    nodes: [
      { id: "in", type: "input" },
      {
        id: "pull_k8s",
        plugin: {
          category: "datasource",
          id: "k8s_list_pull",
          version: "1.0.0"
        },
        dataset: { slug: "k8s-spine" },
        config: { resources: ["pods", "nodes"], limit: 2 }
      },
      {
        id: "shape",
        plugin: {
          category: "transformer",
          id: "k8s_test_shape",
          version: "1.0.0"
        }
      },
      {
        id: "write",
        plugin: { category: "sink", id: "neo4j_write", version: "1.0.0" },
        dataset: { slug: "k8s-spine" },
        config: { label: "K8sResource", keyField: "id" }
      },
      { id: "out", type: "output" }
    ],
    edges: [
      { from: "in", to: "pull_k8s" },
      { from: "pull_k8s", to: "shape" },
      { from: "shape", to: "write" },
      { from: "write", to: "out" }
    ]
  }
};

async function runStub(fetchImpl: K8sFetch): Promise<{
  writes: CapturedWrite[];
  result: unknown;
}> {
  resetConnectionRegistry();
  registerConnectionDriver(
    "k8s",
    k8sConnectionDriver.driver,
    k8sConnectionDriver.driverManifest
  );
  const writes: CapturedWrite[] = [];
  setupNeo4jStub(writes);
  __setK8sFetchForTests(fetchImpl);
  const registry = buildRegistry();
  const dataset = fakeDataset();
  const secrets = new DatabaseEncryptedSecretProvider(
    new InMemorySecretRepository(),
    new StaticKeyProvider("dev-secret")
  );
  const executor = new DagExecutor({
    pluginRegistry: registry,
    secretProvider: secrets,
    store: new InMemoryExecutionStore(),
    datasetResolver: {
      async resolve() {
        return dataset;
      }
    }
  });
  let result: unknown;
  try {
    result = await executor.execute({
      spec,
      context: {
        requestId: "r",
        executionId: "ex-1",
        tenantId: "t1",
        pipelineId: "p1",
        pipelineVersionId: "v1",
        environment: "dev",
        resolvedConfig: {
          pipelineId: "p1",
          pipelineVersionId: "v1",
          tenantId: "t1",
          environment: "dev",
          values: {},
          violations: []
        }
      },
      input: {}
    });
  } finally {
    __setK8sFetchForTests(null);
    resetConnectionRegistry();
  }
  return { writes, result };
}

// ---------------------------------------------------------------------------
// Pass 1: clean pull → complete:true
// ---------------------------------------------------------------------------

test("stub run (clean): pull → shape → write completes, scan.complete:true rides every row", async () => {
  let podPage = 0;
  let nodePage = 0;
  const fakeFetch: K8sFetch = async (url) => {
    if (url.includes("/api/v1/pods")) {
      podPage += 1;
      if (podPage === 1) {
        return jsonRes(200, {
          metadata: { resourceVersion: "rv-pods-100", continue: "tok-pods-2" },
          items: [
            { metadata: { name: "pod-a", uid: "uid-pod-a" } },
            { metadata: { name: "pod-b", uid: "uid-pod-b" } }
          ]
        });
      }
      return jsonRes(200, {
        metadata: { resourceVersion: "rv-pods-100" },
        items: [{ metadata: { name: "pod-c", uid: "uid-pod-c" } }]
      });
    }
    if (url.includes("/api/v1/nodes")) {
      nodePage += 1;
      return jsonRes(200, {
        metadata: { resourceVersion: "rv-nodes-50" },
        items: [{ metadata: { name: "node-1", uid: "uid-node-1" } }]
      });
    }
    return jsonRes(404, { error: "unhandled", url });
  };
  const { writes } = await runStub(fakeFetch);
  // neo4j_write called exactly once with an UNWIND batch containing
  // every (pod, node) row.
  assert.equal(writes.length, 1);
  const rows = writes[0].params.rows as Array<{
    id: string;
    kind: string;
    resourceVersion: string | null;
    scanComplete: boolean;
  }>;
  assert.equal(rows.length, 4);
  // All four rows carry scan.complete = true.
  assert.ok(rows.every((r) => r.scanComplete === true));
  // resourceVersion is preserved per scan.
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  assert.equal(byKind.get("Pod")?.resourceVersion, "rv-pods-100");
  assert.equal(byKind.get("Node")?.resourceVersion, "rv-nodes-50");
});

// ---------------------------------------------------------------------------
// Pass 2: forced 410 → complete:false propagates through the chain
// ---------------------------------------------------------------------------

test("stub run (forced 410): items still write but rows carry scanComplete:false — bulwark MUST refuse close-by-absence on this batch", async () => {
  let podPage = 0;
  const fakeFetch: K8sFetch = async (url) => {
    if (url.includes("/api/v1/pods")) {
      podPage += 1;
      if (podPage === 1) {
        return jsonRes(200, {
          metadata: { resourceVersion: "rv-pods-200", continue: "tok-gone" },
          items: [
            { metadata: { name: "pod-x", uid: "uid-x" } },
            { metadata: { name: "pod-y", uid: "uid-y" } }
          ]
        });
      }
      // Snapshot GC'd — the load-bearing failure mode the whole
      // module exists to handle. Items collected pre-410 are still
      // emitted, but complete must flip to false.
      return jsonRes(410, {
        kind: "Status",
        code: 410,
        message: "The provided continue parameter is too old; the snapshot has been deleted."
      });
    }
    if (url.includes("/api/v1/nodes")) {
      return jsonRes(200, {
        metadata: { resourceVersion: "rv-nodes-99" },
        items: [{ metadata: { name: "node-z", uid: "uid-z" } }]
      });
    }
    return jsonRes(404, { error: "unhandled", url });
  };
  const { writes } = await runStub(fakeFetch);
  const rows = writes[0].params.rows as Array<{
    id: string;
    kind: string;
    scanComplete: boolean;
  }>;
  // Both pods we got pre-410 are written + the node scan that
  // completed cleanly. The pod rows carry scanComplete=false (the
  // critical signal); the node rows carry scanComplete=true (its
  // scan was independent and clean).
  const pods = rows.filter((r) => r.kind === "Pod");
  const nodes = rows.filter((r) => r.kind === "Node");
  assert.equal(pods.length, 2);
  assert.equal(nodes.length, 1);
  assert.ok(pods.every((r) => r.scanComplete === false));
  assert.ok(nodes.every((r) => r.scanComplete === true));
});
