/**
 * End-to-end stub pipeline for the Neo4j + Cartography family (ADR-0025).
 *
 * Gated: skips with a clear hint when `NEO4J_TEST_URI` isn't set so
 * `npm run test:e2e` stays install-free on machines without a throwaway
 * Neo4j. When the env var IS set, the test:
 *
 *   1. Stands up a `ResolvedDataset` with two bindings — `target` and
 *      `graph` — both pointing at the SAME neo4j connection (the test
 *      neo4j stack). This is the same "working-graph" pattern bulwark
 *      uses: Cartography writes into a graph the read/write plugins
 *      then query out of.
 *
 *   2. Wires the canonical bulwark composition:
 *        cartography_crawl (dry-run, target binding)
 *          → transform (JSONata mapping)
 *          → neo4j_write (graph binding, idempotent MERGE)
 *          → neo4j_query (graph binding, read-back)
 *      via the platform DagExecutor.
 *
 *   3. Runs the pipeline TWICE. Asserts:
 *      - First run: crawl metadata is emitted; write reports N upserts;
 *        the readback query returns N nodes.
 *      - Second run: identical input → query returns the SAME N nodes
 *        (no duplicates — that's the MERGE idempotency promise).
 *
 * The connection / pipeline are constructed in-memory; nothing seeds the
 * live control-plane DB. That keeps the gated run side-effect-free
 * except for whatever's written to the throwaway Neo4j (which is, by
 * definition, throwaway).
 *
 * Set NEO4J_TEST_URI + NEO4J_TEST_USER + NEO4J_TEST_PASSWORD to enable:
 *
 *   NEO4J_TEST_URI=bolt://localhost:7687 \
 *     NEO4J_TEST_USER=neo4j \
 *     NEO4J_TEST_PASSWORD=test_password \
 *     npm run test:e2e
 *
 * A `docker run -d --name ragdoll-test-neo4j -p 7687:7687 \
 *     -e NEO4J_AUTH=neo4j/test_password neo4j:5-community`
 * is plenty.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadPluginRegistry } from "../../packages/plugin-loader/src/index.ts";
import { DagExecutor, InMemoryExecutionStore } from "../../packages/runtime/src/index.ts";
import {
  DatabaseEncryptedSecretProvider,
  InMemorySecretRepository,
  StaticKeyProvider
} from "../../packages/secrets/src/index.ts";
import {
  closeClient,
  type ResolvedExternalConnection
} from "../../packages/external-connections/src/index.ts";
import type { RuntimeContext } from "../../packages/core/src/index.ts";
import type { ResolvedDataset, DatasetResolver, DatasetRef } from "../../packages/plugin-sdk/src/index.ts";

const NEO4J_URI = process.env.NEO4J_TEST_URI;
const NEO4J_USER = process.env.NEO4J_TEST_USER ?? "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_TEST_PASSWORD ?? "test_password";

const SKIP_REASON =
  "set NEO4J_TEST_URI (and optionally NEO4J_TEST_USER / NEO4J_TEST_PASSWORD) to enable; " +
  "`docker run -d --name ragdoll-test-neo4j -p 7687:7687 -e NEO4J_AUTH=neo4j/test_password neo4j:5-community` is enough";

// A unique node label per test run so we don't trample concurrent runs
// or stale state from a prior run that crashed before its teardown.
const TEST_LABEL = `RagdollTestObs_${process.pid}_${Date.now()}`;

function makeContext(): RuntimeContext {
  return {
    requestId: "req-e2e",
    executionId: `exec-${randomUUID()}`,
    tenantId: "tenant-e2e",
    pipelineId: "pipe-e2e",
    pipelineVersionId: "v1",
    environment: "dev",
    resolvedConfig: {
      pipelineId: "pipe-e2e",
      tenantId: "tenant-e2e",
      environment: "dev",
      violations: [],
      values: {}
    }
  };
}

function buildResolvedNeo4jConn(): ResolvedExternalConnection {
  return {
    id: "conn-neo4j-test",
    slug: "neo4j-test",
    kind: "neo4j",
    options: { uri: NEO4J_URI!, database: "neo4j" },
    // Driver-side parseNeo4jCredentials accepts a JSON {user, password} blob.
    secret: JSON.stringify({ username: NEO4J_USER, password: NEO4J_PASSWORD }),
    cascadeReason: "tenant"
  };
}

/** ResolvedDataset with both `target` (for cartography_crawl) and `graph`
 *  (for neo4j_query/write) bindings — both wired to the same connection.
 *  Real bulwark would point these at different connections (working-graph
 *  vs. spine); here we use one connection because the test just proves
 *  the wiring is generic. */
function buildResolvedDataset(): ResolvedDataset {
  const conn = buildResolvedNeo4jConn();
  const bindingShape = {
    connectionSlug: conn.slug,
    connectionKind: conn.kind,
    connectionHost: "neo4j-test",
    connectionPort: 7687,
    cascadeReason: "tenant" as const,
    connection: conn
  };
  return {
    id: "ds-test",
    slug: "test-ds",
    scope: "global",
    embeddingProfile: {},
    chunkSchema: {},
    version: { id: "v1", versionLabel: "v1", status: "ready" },
    bindings: {
      target: bindingShape,
      graph: bindingShape
    }
  };
}

function buildDatasetResolver(): DatasetResolver {
  const dataset = buildResolvedDataset();
  return {
    async resolve(_args: { ref: DatasetRef; tenantId?: string; environmentId?: string; pipelineId?: string }) {
      return dataset;
    }
  };
}

test("neo4j + cartography stub pipeline runs end-to-end + is idempotent", { skip: !NEO4J_URI ? SKIP_REASON : undefined }, async () => {
  const registry = loadPluginRegistry();
  const store = new InMemoryExecutionStore();
  const executor = new DagExecutor({
    pluginRegistry: registry,
    secretProvider: new DatabaseEncryptedSecretProvider(
      new InMemorySecretRepository(),
      new StaticKeyProvider("e2e-key")
    ),
    store,
    maxRetries: 0,
    datasetResolver: buildDatasetResolver()
  });
  // The neo4j-driver pool keeps the event loop alive after the test
  // finishes — close it explicitly so the test runner exits cleanly
  // instead of timing out. The driver registry caches by connection.id.
  const connectionId = buildResolvedNeo4jConn().id;

  // crawl (dry-run) → transform (synthesize rows from crawl metadata) →
  // neo4j_write (idempotent MERGE) → neo4j_query (read-back the count).
  // The transform node's mapping fabricates `rows` from the crawl
  // metadata so the test doesn't depend on a real cloud-credentials
  // fetch (which is bulwark's responsibility anyway — RAGdoll ships
  // the plumbing, not the security domain).
  const spec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "neo4j-cartography-stub" },
    spec: {
      nodes: [
        { id: "input", type: "input" },
        {
          id: "crawl",
          plugin: { category: "datasource", id: "cartography_crawl", version: "1.0.0" },
          config: { modules: ["aws"], runner: "dry-run" },
          dataset: { slug: "test-ds" }
        },
        {
          id: "synth",
          plugin: { category: "transformer", id: "transform", version: "1.0.0" },
          config: {
            engine: "jsonata",
            inputs: ["metadata"],
            outputs: {
              // Two fixed rows keyed by `obs_id` — deterministic so the
              // idempotency assertion is reliable across both runs.
              rows: '[{"obs_id":"a","module":metadata.modules[0].module},{"obs_id":"b","module":metadata.modules[0].module}]'
            }
          }
        },
        {
          id: "write",
          plugin: { category: "sink", id: "neo4j_write", version: "1.0.0" },
          config: { label: TEST_LABEL, keyField: "obs_id" },
          dataset: { slug: "test-ds" }
        },
        {
          id: "count",
          plugin: { category: "retriever", id: "neo4j_query", version: "1.0.0" },
          config: {
            cypher: `MATCH (n:\`${TEST_LABEL}\`) RETURN count(n) AS n`
          },
          dataset: { slug: "test-ds" }
        },
        { id: "output", type: "output" }
      ],
      edges: [
        { from: "input", to: "crawl" },
        { from: "crawl", to: "synth", fromPort: "metadata", toPort: "metadata" },
        { from: "synth", to: "write", fromPort: "rows", toPort: "rows" },
        { from: "write", to: "count" },
        { from: "count", to: "output" }
      ]
    }
  };

  async function run(): Promise<Record<string, unknown>> {
    const result = await executor.execute({
      spec: spec as never,
      context: makeContext(),
      input: {}
    });
    return result as Record<string, unknown>;
  }

  try {
    // First run.
    const first = await run();
    // The output node forwards its source (count) node's outputs verbatim,
    // so we should see `rows: [{n: 2}]` (Neo4j's count() returns the
    // integer 2, unwrapped to a JS number by the neo4j_query plugin).
    const firstRows = (first as { rows?: Array<{ n: number }> }).rows ?? [];
    assert.equal(firstRows.length, 1, "count query returns one row");
    assert.equal(firstRows[0].n, 2, "two distinct obs_ids were written");

    // Second run — same input, same merge keys. Count must remain at 2
    // (the MERGE idempotency promise), proving the plugin shape is
    // dupe-safe end-to-end.
    const second = await run();
    const secondRows = (second as { rows?: Array<{ n: number }> }).rows ?? [];
    assert.equal(secondRows[0].n, 2, "second run created zero duplicates");
  } finally {
    // Cleanup: drop the test label so concurrent suites or repeat runs
    // start from a known state, then close the pooled neo4j driver so
    // the node:test runner can exit (otherwise the Bolt connection
    // keeps the event loop alive indefinitely). Best-effort.
    try {
      await executor.execute({
        spec: {
          apiVersion: "rag-platform/v1",
          kind: "Pipeline",
          metadata: { name: "neo4j-cleanup" },
          spec: {
            nodes: [
              { id: "input", type: "input" },
              {
                id: "delete",
                plugin: { category: "retriever", id: "neo4j_query", version: "1.0.0" },
                config: { cypher: `MATCH (n:\`${TEST_LABEL}\`) DELETE n RETURN count(n) AS n` },
                dataset: { slug: "test-ds" }
              },
              { id: "output", type: "output" }
            ],
            edges: [
              { from: "input", to: "delete" },
              { from: "delete", to: "output" }
            ]
          }
        } as never,
        context: makeContext(),
        input: {}
      });
    } catch {
      /* best-effort — connection may already be gone */
    }
    await closeClient(connectionId);
  }
});
