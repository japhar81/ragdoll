import test from "node:test";
import assert from "node:assert/strict";
import { ConfigResolver } from "../src/index.ts";
import type { ConfigDefinition, ConfigValue } from "../../core/src/index.ts";

const definitions: ConfigDefinition[] = [
  {
    key: "llm.provider",
    type: "string",
    defaultValue: "openai",
    allowedScopes: ["global", "pipeline", "tenant", "tenant_pipeline", "runtime"],
    tenantOverridable: true,
    runtimeOverridable: true,
    allowedValues: ["openai", "anthropic", "ollama"]
  },
  {
    key: "llm.api_key",
    type: "secret_ref",
    allowedScopes: ["tenant", "tenant_pipeline"],
    tenantOverridable: true,
    runtimeOverridable: false,
    secret: true
  },
  {
    key: "chunking.chunk_size",
    type: "integer",
    defaultValue: 1000,
    allowedScopes: ["global", "pipeline"],
    tenantOverridable: false,
    runtimeOverridable: false
  },
  {
    key: "retrieval.top_k",
    type: "integer",
    defaultValue: 5,
    allowedScopes: ["global", "pipeline", "tenant_pipeline", "runtime"],
    tenantOverridable: true,
    runtimeOverridable: true
  },
  {
    key: "llm.base_url",
    type: "string",
    allowedScopes: ["tenant", "tenant_pipeline"],
    tenantOverridable: true,
    runtimeOverridable: false
  }
];

function resolve(values: ConfigValue[], runtimeOverrides?: Record<string, unknown>) {
  return new ConfigResolver(definitions).resolve({
    pipelineId: "pipe-rag",
    pipelineVersionId: "version-1",
    tenantId: "tenant-a",
    environment: "prod",
    values,
    runtimeOverrides
  });
}

test("global default rolls down to pipeline and tenant", () => {
  const result = resolve([]);
  assert.equal(result.values["llm.provider"].value, "openai");
  assert.equal(result.values["llm.provider"].defaulted, true);
  assert.equal(result.values["llm.provider"].sourceScope, "global");
});

test("pipeline override beats global", () => {
  const result = resolve([{ key: "llm.provider", value: "anthropic", scope: "pipeline", scopeId: "pipe-rag" }]);
  assert.equal(result.values["llm.provider"].value, "anthropic");
  assert.equal(result.values["llm.provider"].sourceScope, "pipeline");
});

test("tenant-pipeline override beats pipeline when allowed", () => {
  const result = resolve([
    { key: "retrieval.top_k", value: 4, scope: "pipeline", scopeId: "pipe-rag" },
    { key: "retrieval.top_k", value: 8, scope: "tenant_pipeline", scopeId: "tenant-a:pipe-rag" }
  ]);
  assert.equal(result.values["retrieval.top_k"].value, 8);
  assert.equal(result.values["retrieval.top_k"].sourceScope, "tenant_pipeline");
});

test("tenant override is rejected when key is locked", () => {
  const result = resolve([
    { key: "chunking.chunk_size", value: 1200, scope: "pipeline", scopeId: "pipe-rag", locked: true },
    { key: "chunking.chunk_size", value: 512, scope: "tenant_pipeline", scopeId: "tenant-a:pipe-rag" }
  ]);
  assert.equal(result.values["chunking.chunk_size"].value, 1200);
  assert.match(result.violations.map((violation) => violation.reason).join(" "), /not allowed|locked/);
});

test("runtime override beats tenant only when runtime override allowed", () => {
  const result = resolve([
    { key: "retrieval.top_k", value: 8, scope: "tenant_pipeline", scopeId: "tenant-a:pipe-rag" }
  ], { "retrieval.top_k": 12 });
  assert.equal(result.values["retrieval.top_k"].value, 12);
  assert.equal(result.values["retrieval.top_k"].sourceScope, "runtime");
});

test("secret values are redacted in resolved config API", () => {
  const result = resolve([
    { key: "llm.api_key", value: { scope: "tenant", tenantId: "tenant-a", key: "openai.api_key" }, scope: "tenant", scopeId: "tenant-a", secret: true }
  ]);
  assert.equal(result.values["llm.api_key"].redacted, true);
  assert.equal(result.values["llm.api_key"].value, "REDACTED");
});

test("Ollama provider can be configured per tenant with different base URLs", () => {
  const tenantA = resolve([
    { key: "llm.provider", value: "ollama", scope: "tenant", scopeId: "tenant-a" },
    { key: "llm.base_url", value: "http://ollama-a:11434", scope: "tenant", scopeId: "tenant-a" }
  ]);
  const tenantB = new ConfigResolver(definitions).resolve({
    pipelineId: "pipe-rag",
    tenantId: "tenant-b",
    environment: "prod",
    values: [
      { key: "llm.provider", value: "ollama", scope: "tenant", scopeId: "tenant-b" },
      { key: "llm.base_url", value: "http://ollama-b:11434", scope: "tenant", scopeId: "tenant-b" }
    ]
  });
  assert.equal(tenantA.values["llm.base_url"].value, "http://ollama-a:11434");
  assert.equal(tenantB.values["llm.base_url"].value, "http://ollama-b:11434");
});

test("OpenAI and Anthropic providers can be selected per tenant", () => {
  const tenantA = resolve([{ key: "llm.provider", value: "openai", scope: "tenant", scopeId: "tenant-a" }]);
  const tenantB = new ConfigResolver(definitions).resolve({
    pipelineId: "pipe-rag",
    tenantId: "tenant-b",
    environment: "prod",
    values: [{ key: "llm.provider", value: "anthropic", scope: "tenant", scopeId: "tenant-b" }]
  });
  assert.equal(tenantA.values["llm.provider"].value, "openai");
  assert.equal(tenantB.values["llm.provider"].value, "anthropic");
});
