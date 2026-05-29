/**
 * Shared test helpers for plugin unit tests.
 *
 * Every storage plugin now declares `requires: [{modality, provider?}]`
 * and hard-fails on a missing connection (PR1 of the requires
 * roll-out). Plugin unit tests don't want to stand up a real Qdrant /
 * OpenSearch / Dgraph — they use the in-memory store as a stand-in.
 *
 * To keep the plugin's hard-fail path exercised end-to-end (so tests
 * catch a refactor that loses the requireBackendConnection call), we
 * synthesise a fake ResolvedDataset whose backend connection uses the
 * sentinel `memory` host. The vector / graph store factories recognise
 * that host and route to the in-memory store. Tests therefore go
 * through the SAME code path as production except for the very last
 * step (storage layer choice), which is exactly the slice we want.
 */
import type { ResolvedDataset } from "../../../packages/plugin-sdk/src/index.ts";

/** Fake vector-backend dataset for qdrant_* plugin tests. */
export function fakeVectorDataset(opts: { provider?: string; host?: string } = {}): ResolvedDataset {
  const host = opts.host ?? "memory";
  const provider = opts.provider ?? "qdrant";
  return {
    id: "ds-test-vector",
    slug: "test-vector",
    scope: "global",
    modalities: ["vector"],
    embeddingProfile: {},
    chunkSchema: {},
    version: { id: "v1", versionLabel: "v1", status: "ready" },
    backendCollections: {},
    backends: {
      vector: {
        provider,
        connectionName: `test-${provider}`,
        connection: {
          name: `test-${provider}`,
          type: provider,
          host,
          port: 6333,
          secretRefId: null,
          config: { host, port: 6333 },
          cascadeReason: "tenant_fallback"
        }
      }
    }
  };
}

/** Fake text-backend dataset for opensearch_* plugin tests. */
export function fakeTextDataset(opts: { host?: string } = {}): ResolvedDataset {
  const host = opts.host ?? "memory";
  return {
    id: "ds-test-text",
    slug: "test-text",
    scope: "global",
    modalities: ["text"],
    embeddingProfile: {},
    chunkSchema: {},
    version: { id: "v1", versionLabel: "v1", status: "ready" },
    backendCollections: {},
    backends: {
      text: {
        provider: "opensearch",
        connectionName: "test-opensearch",
        connection: {
          name: "test-opensearch",
          type: "opensearch",
          host,
          port: 9200,
          secretRefId: null,
          config: { host, port: 9200 },
          cascadeReason: "tenant_fallback"
        }
      }
    }
  };
}

/** Fake hybrid (text + vector) dataset for opensearch_hybrid_retriever tests. */
export function fakeHybridDataset(opts: { host?: string } = {}): ResolvedDataset {
  const host = opts.host ?? "memory";
  const conn = {
    name: "test-opensearch",
    type: "opensearch",
    host,
    port: 9200,
    secretRefId: null,
    config: { host, port: 9200 },
    cascadeReason: "tenant_fallback" as const
  };
  return {
    id: "ds-test-hybrid",
    slug: "test-hybrid",
    scope: "global",
    modalities: ["text", "vector"],
    embeddingProfile: {},
    chunkSchema: {},
    version: { id: "v1", versionLabel: "v1", status: "ready" },
    backendCollections: {},
    backends: {
      text: {
        provider: "opensearch",
        connectionName: "test-opensearch",
        connection: conn
      },
      vector: {
        provider: "opensearch",
        connectionName: "test-opensearch",
        connection: conn
      }
    }
  };
}

/** Fake graph-backend dataset for dgraph_* plugin tests. */
export function fakeGraphDataset(opts: { host?: string } = {}): ResolvedDataset {
  const host = opts.host ?? "memory";
  return {
    id: "ds-test-graph",
    slug: "test-graph",
    scope: "global",
    modalities: ["graph"],
    embeddingProfile: {},
    chunkSchema: {},
    version: { id: "v1", versionLabel: "v1", status: "ready" },
    backendCollections: {},
    backends: {
      graph: {
        provider: "dgraph",
        connectionName: "test-dgraph",
        connection: {
          name: "test-dgraph",
          type: "dgraph",
          host,
          port: 8080,
          secretRefId: null,
          config: { host, port: 8080 },
          cascadeReason: "tenant_fallback"
        }
      }
    }
  };
}
