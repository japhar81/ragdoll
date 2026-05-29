/**
 * Tests for the connection-aware backend URL helper (PR3).
 *
 * `pickBackendUrl` is what every storage plugin reads to figure out
 * which backing-store host to talk to. The precedence chain the
 * tests pin down:
 *
 *   1. Dataset's resolved `connection.host` (+ optional port) wins.
 *   2. Legacy `config[cfgKey]` next — call sites log a deprecation.
 *   3. `process.env[envFallback]` last — for installs that pin
 *      a single cluster via helm env injection.
 *   4. undefined when nothing matches.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pickBackendUrl } from "../src/dataset-binding.ts";
import type { PluginExecutionInput } from "../../../packages/plugin-sdk/src/index.ts";

function inputWith(opts: {
  config?: Record<string, unknown>;
  datasetBackend?: {
    provider?: string;
    connection?: {
      name: string;
      type: string;
      host?: string;
      port?: number;
      secretRefId?: string | null;
      config: Record<string, unknown>;
      cascadeReason: "env_specific" | "tenant_fallback";
    };
  };
}): PluginExecutionInput {
  return {
    context: {
      requestId: "r",
      executionId: "e",
      tenantId: "t",
      pipelineId: "p",
      pipelineVersionId: "v",
      environment: "test",
      resolvedConfig: {
        pipelineId: "p",
        tenantId: "t",
        environment: "test",
        values: {},
        violations: []
      } as any
    },
    node: { id: "n", plugin: { category: "vector_store", id: "x", version: "1.0.0" } },
    inputs: {},
    config: opts.config ?? {},
    secrets: {},
    dataset: opts.datasetBackend
      ? ({
          id: "d",
          slug: "ds",
          scope: "global",
          modalities: ["vector"],
          embeddingProfile: {},
          chunkSchema: {},
          version: { id: "vv", versionLabel: "v1", status: "ready" },
          backendCollections: {},
          backends: { vector: opts.datasetBackend as Record<string, unknown> }
        } as any)
      : undefined
  };
}

test("pickBackendUrl: dataset connection wins, host+port stitched with scheme", () => {
  const r = pickBackendUrl(
    inputWith({
      config: { url: "should-not-be-used" },
      datasetBackend: {
        provider: "qdrant",
        connection: {
          name: "qdrant-main",
          type: "qdrant",
          host: "qdrant.acme.example",
          port: 6333,
          secretRefId: null,
          config: {},
          cascadeReason: "tenant_fallback"
        }
      }
    }),
    "vector",
    { cfgKey: "url", defaultPort: 6333 }
  );
  assert.deepEqual(r, {
    url: "http://qdrant.acme.example:6333",
    source: "dataset_connection",
    connectionName: "qdrant-main",
    cascadeReason: "tenant_fallback"
  });
});

test("pickBackendUrl: defaultPort used when connection lacks port", () => {
  const r = pickBackendUrl(
    inputWith({
      datasetBackend: {
        provider: "opensearch",
        connection: {
          name: "os",
          type: "opensearch",
          host: "os.acme.example",
          secretRefId: null,
          config: {},
          cascadeReason: "env_specific"
        }
      }
    }),
    "vector",
    { cfgKey: "endpoint", defaultPort: 9200 }
  );
  assert.equal(r?.url, "http://os.acme.example:9200");
  assert.equal(r?.cascadeReason, "env_specific");
});

test("pickBackendUrl: host without port and without defaultPort omits :port", () => {
  const r = pickBackendUrl(
    inputWith({
      datasetBackend: {
        connection: {
          name: "x",
          type: "qdrant",
          host: "x.example",
          secretRefId: null,
          config: {},
          cascadeReason: "tenant_fallback"
        }
      }
    }),
    "vector",
    { cfgKey: "url" }
  );
  assert.equal(r?.url, "http://x.example");
});

test("pickBackendUrl: legacy config[cfgKey] fallback when no connection", () => {
  const r = pickBackendUrl(
    inputWith({ config: { url: "http://legacy-config.example:6333" } }),
    "vector",
    { cfgKey: "url" }
  );
  assert.equal(r?.url, "http://legacy-config.example:6333");
  assert.equal(r?.source, "config");
});

test("pickBackendUrl: env fallback last when nothing else set", () => {
  const prev = process.env.QDRANT_URL;
  process.env.QDRANT_URL = "http://env-qdrant.example:6333";
  try {
    const r = pickBackendUrl(inputWith({}), "vector", {
      cfgKey: "url",
      envFallback: "QDRANT_URL"
    });
    assert.equal(r?.url, "http://env-qdrant.example:6333");
    assert.equal(r?.source, "env");
  } finally {
    if (prev === undefined) delete process.env.QDRANT_URL;
    else process.env.QDRANT_URL = prev;
  }
});

test("pickBackendUrl: undefined when no path resolves", () => {
  const prev = process.env.QDRANT_URL;
  delete process.env.QDRANT_URL;
  try {
    const r = pickBackendUrl(inputWith({}), "vector", {
      cfgKey: "url",
      envFallback: "QDRANT_URL"
    });
    assert.equal(r, undefined);
  } finally {
    if (prev !== undefined) process.env.QDRANT_URL = prev;
  }
});

test("pickBackendUrl: scheme override (https) honoured", () => {
  const r = pickBackendUrl(
    inputWith({
      datasetBackend: {
        connection: {
          name: "x",
          type: "opensearch",
          host: "os.acme.example",
          port: 9200,
          secretRefId: null,
          config: {},
          cascadeReason: "tenant_fallback"
        }
      }
    }),
    "vector",
    { cfgKey: "endpoint", scheme: "https://" }
  );
  assert.equal(r?.url, "https://os.acme.example:9200");
});

test("pickBackendUrl: dataset connection wins over BOTH config and env", () => {
  const prev = process.env.QDRANT_URL;
  process.env.QDRANT_URL = "http://env.example";
  try {
    const r = pickBackendUrl(
      inputWith({
        config: { url: "http://config.example" },
        datasetBackend: {
          connection: {
            name: "x",
            type: "qdrant",
            host: "winner.example",
            port: 6333,
            secretRefId: null,
            config: {},
            cascadeReason: "env_specific"
          }
        }
      }),
      "vector",
      { cfgKey: "url", envFallback: "QDRANT_URL" }
    );
    assert.equal(r?.url, "http://winner.example:6333");
    assert.equal(r?.source, "dataset_connection");
  } finally {
    if (prev === undefined) delete process.env.QDRANT_URL;
    else process.env.QDRANT_URL = prev;
  }
});
