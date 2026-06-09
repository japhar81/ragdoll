/**
 * Tests for the connection-aware binding URL helper (ADR-0023).
 *
 * `pickBindingUrl` (legacy alias `pickBackendUrl`) is what every
 * storage plugin reads to figure out which backing-store host to talk
 * to. The precedence chain the tests pin down:
 *
 *   1. Dataset's resolved binding `connectionHost` (+ optional port) wins.
 *   2. Legacy `config[cfgKey]` next.
 *   3. `process.env[envFallback]` last — for installs that pin
 *      a single cluster via helm env injection.
 *   4. undefined when nothing matches.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pickBindingUrl } from "../src/dataset-binding.ts";
import type { PluginExecutionInput } from "../../../packages/plugin-sdk/src/index.ts";

function inputWith(opts: {
  config?: Record<string, unknown>;
  binding?: {
    connectionSlug?: string;
    connectionKind?: string;
    connectionHost?: string;
    connectionPort?: number;
    cascadeReason?: "global" | "tenant" | "environment";
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
    dataset: opts.binding
      ? ({
          id: "d",
          slug: "ds",
          scope: "global",
          embeddingProfile: {},
          chunkSchema: {},
          version: { id: "vv", versionLabel: "v1", status: "ready" },
          bindings: { vectors: opts.binding }
        } as any)
      : undefined
  };
}

test("pickBindingUrl: dataset binding wins, host+port stitched with scheme", () => {
  const r = pickBindingUrl(
    inputWith({
      config: { url: "should-not-be-used" },
      binding: {
        connectionSlug: "qdrant-main",
        connectionKind: "qdrant",
        connectionHost: "qdrant.acme.example",
        connectionPort: 6333,
        cascadeReason: "tenant"
      }
    }),
    "vectors",
    { cfgKey: "url", defaultPort: 6333 }
  );
  assert.deepEqual(r, {
    url: "http://qdrant.acme.example:6333",
    source: "binding",
    connectionSlug: "qdrant-main",
    connectionKind: "qdrant",
    cascadeReason: "tenant"
  });
});

test("pickBindingUrl: defaultPort used when binding lacks port", () => {
  const r = pickBindingUrl(
    inputWith({
      binding: {
        connectionSlug: "os",
        connectionKind: "opensearch",
        connectionHost: "os.acme.example",
        cascadeReason: "environment"
      }
    }),
    "vectors",
    { cfgKey: "endpoint", defaultPort: 9200 }
  );
  assert.equal(r?.url, "http://os.acme.example:9200");
  assert.equal(r?.cascadeReason, "environment");
});

test("pickBindingUrl: host without port and without defaultPort omits :port", () => {
  const r = pickBindingUrl(
    inputWith({
      binding: {
        connectionSlug: "x",
        connectionKind: "qdrant",
        connectionHost: "x.example",
        cascadeReason: "tenant"
      }
    }),
    "vectors",
    { cfgKey: "url" }
  );
  assert.equal(r?.url, "http://x.example");
});

test("pickBindingUrl: legacy config[cfgKey] fallback when no binding", () => {
  const r = pickBindingUrl(
    inputWith({ config: { url: "http://legacy-config.example:6333" } }),
    "vectors",
    { cfgKey: "url" }
  );
  assert.equal(r?.url, "http://legacy-config.example:6333");
  assert.equal(r?.source, "config");
});

test("pickBindingUrl: env fallback last when nothing else set", () => {
  const prev = process.env.QDRANT_URL;
  process.env.QDRANT_URL = "http://env-qdrant.example:6333";
  try {
    const r = pickBindingUrl(inputWith({}), "vectors", {
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

test("pickBindingUrl: undefined when no path resolves", () => {
  const prev = process.env.QDRANT_URL;
  delete process.env.QDRANT_URL;
  try {
    const r = pickBindingUrl(inputWith({}), "vectors", {
      cfgKey: "url",
      envFallback: "QDRANT_URL"
    });
    assert.equal(r, undefined);
  } finally {
    if (prev !== undefined) process.env.QDRANT_URL = prev;
  }
});

test("pickBindingUrl: scheme override (https) honoured", () => {
  const r = pickBindingUrl(
    inputWith({
      binding: {
        connectionSlug: "x",
        connectionKind: "opensearch",
        connectionHost: "os.acme.example",
        connectionPort: 9200,
        cascadeReason: "tenant"
      }
    }),
    "vectors",
    { cfgKey: "endpoint", scheme: "https://" }
  );
  assert.equal(r?.url, "https://os.acme.example:9200");
});

test("pickBindingUrl: dataset binding wins over BOTH config and env", () => {
  const prev = process.env.QDRANT_URL;
  process.env.QDRANT_URL = "http://env.example";
  try {
    const r = pickBindingUrl(
      inputWith({
        config: { url: "http://config.example" },
        binding: {
          connectionSlug: "x",
          connectionKind: "qdrant",
          connectionHost: "winner.example",
          connectionPort: 6333,
          cascadeReason: "environment"
        }
      }),
      "vectors",
      { cfgKey: "url", envFallback: "QDRANT_URL" }
    );
    assert.equal(r?.url, "http://winner.example:6333");
    assert.equal(r?.source, "binding");
  } finally {
    if (prev === undefined) delete process.env.QDRANT_URL;
    else process.env.QDRANT_URL = prev;
  }
});
