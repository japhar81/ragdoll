/**
 * Shared test helpers for plugin unit tests.
 *
 * Every storage plugin declares either legacy `requires: [{modality,
 * provider?}]` or ADR-0023 `requires: [{binding, kind|kindOneOf}]` and
 * hard-fails on a missing binding. Plugin unit tests don't want to
 * stand up a real Qdrant / OpenSearch / Dgraph — they use the
 * in-memory store as a stand-in.
 *
 * To keep the plugin's hard-fail path exercised end-to-end (so tests
 * catch a refactor that loses the require* call), we synthesise a
 * fake ResolvedDataset whose binding's connection uses the sentinel
 * `memory` host. The vector / graph store factories recognise that
 * host and route to the in-memory store. Tests therefore go through
 * the SAME code path as production except for the very last step
 * (storage layer choice), which is exactly the slice we want.
 *
 * Binding names follow the ADR-0023 vocabulary: "vectors" / "text" /
 * "graph". The fakes still respond to the legacy modality-keyed
 * accessors (pickBackendName / requireBackendConnection) via the
 * fallback table in dataset-binding.ts.
 */
import type { ResolvedDataset } from "../../../packages/plugin-sdk/src/index.ts";

/** Fake vector-backend dataset for qdrant_* plugin tests. */
export function fakeVectorDataset(
  opts: { provider?: string; host?: string } = {}
): ResolvedDataset {
  const host = opts.host ?? "memory";
  const provider = opts.provider ?? "qdrant";
  return {
    id: "ds-test-vector",
    slug: "test-vector",
    scope: "global",
    embeddingProfile: {},
    chunkSchema: {},
    version: { id: "v1", versionLabel: "v1", status: "ready" },
    bindings: {
      vectors: {
        connectionSlug: `test-${provider}`,
        connectionKind: provider,
        connectionHost: host,
        connectionPort: 6333,
        cascadeReason: "tenant"
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
    embeddingProfile: {},
    chunkSchema: {},
    version: { id: "v1", versionLabel: "v1", status: "ready" },
    bindings: {
      text: {
        connectionSlug: "test-opensearch",
        connectionKind: "opensearch",
        connectionHost: host,
        connectionPort: 9200,
        cascadeReason: "tenant"
      }
    }
  };
}

/** Fake hybrid (text + vectors) dataset for opensearch_hybrid_retriever tests. */
export function fakeHybridDataset(opts: { host?: string } = {}): ResolvedDataset {
  const host = opts.host ?? "memory";
  const conn = {
    connectionSlug: "test-opensearch",
    connectionKind: "opensearch",
    connectionHost: host,
    connectionPort: 9200,
    cascadeReason: "tenant" as const
  };
  return {
    id: "ds-test-hybrid",
    slug: "test-hybrid",
    scope: "global",
    embeddingProfile: {},
    chunkSchema: {},
    version: { id: "v1", versionLabel: "v1", status: "ready" },
    bindings: {
      text: { ...conn },
      vectors: { ...conn }
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
    embeddingProfile: {},
    chunkSchema: {},
    version: { id: "v1", versionLabel: "v1", status: "ready" },
    bindings: {
      graph: {
        connectionSlug: "test-dgraph",
        connectionKind: "dgraph",
        connectionHost: host,
        connectionPort: 8080,
        cascadeReason: "tenant"
      }
    }
  };
}
