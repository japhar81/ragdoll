import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseYaml,
  stringifyYaml,
  loadPipelineSpec,
  loadPipelineSpecFromYaml,
  specChecksum,
  publishVersion,
  archiveVersion,
  selectDeployedVersion,
  exportSpec,
  importSpec,
  ImmutableVersionError,
  type PipelineVersionRecord,
  type PipelineDeployment
} from "../src/index.ts";
import type { PipelineSpec } from "../../core/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const pipelinesDir = join(repoRoot, "examples", "pipelines");
const configsDir = join(repoRoot, "examples", "configs");

function readExample(dir: string, name: string): string {
  return readFileSync(join(dir, name), "utf8");
}

test("parses every example pipeline YAML without throwing", () => {
  for (const file of readdirSync(pipelinesDir).filter((f: string) => f.endsWith(".yaml"))) {
    const text = readExample(pipelinesDir, file);
    assert.doesNotThrow(() => parseYaml(text), `parse failed for ${file}`);
  }
});

test("parses every example config YAML without throwing", () => {
  for (const file of readdirSync(configsDir).filter((f: string) => f.endsWith(".yaml"))) {
    const text = readExample(configsDir, file);
    assert.doesNotThrow(() => parseYaml(text), `parse failed for ${file}`);
  }
});

test("support-rag.yaml parses to expected structure", () => {
  const spec = loadPipelineSpecFromYaml(readExample(pipelinesDir, "support-rag.yaml"));
  assert.equal(spec.apiVersion, "rag-platform/v1");
  assert.equal(spec.kind, "Pipeline");
  assert.equal(spec.metadata.name, "support-rag");
  assert.equal(spec.metadata.labels?.domain, "support");
  assert.equal(spec.spec.nodes.length, 6);
  assert.equal(spec.spec.edges.length, 5);

  const params = spec.spec.parameters ?? [];
  assert.equal(params.length, 2);
  assert.equal(params[0].key, "retrieval.top_k");
  assert.equal(params[0].type, "integer");
  assert.equal(params[0].defaultValue, 5);
  assert.deepEqual(params[0].allowedScopes, ["global", "pipeline", "tenant_pipeline", "runtime"]);
  assert.equal(params[0].tenantOverridable, true);

  const llm = spec.spec.nodes.find((n) => n.id === "llm");
  assert.equal(llm?.plugin?.id, "provider_chat");
  assert.equal(llm?.plugin?.version, "1.0.0");
  assert.equal(llm?.config?.model, "${config.llm.model}");
  assert.equal((llm?.secrets?.apiKey as { scope?: string })?.scope, "tenant");

  const guardrail = spec.spec.nodes.find((n) => n.id === "guardrail");
  assert.deepEqual(guardrail?.config?.blockedKeywords, ["ignore previous instructions"]);
});

test("support-ingestion.yaml has 6 nodes and integer overlap scalar", () => {
  const spec = loadPipelineSpecFromYaml(readExample(pipelinesDir, "support-ingestion.yaml"));
  assert.equal(spec.metadata.name, "support-ingestion");
  assert.equal(spec.spec.nodes.length, 6);
  assert.equal(spec.metadata.labels?.mode, "ingestion");
  const chunk = spec.spec.nodes.find((n) => n.id === "chunk");
  assert.equal(chunk?.config?.overlap, 100);
  assert.equal(typeof chunk?.config?.overlap, "number");
});

test("query-only.yaml has 5 nodes", () => {
  const spec = loadPipelineSpecFromYaml(readExample(pipelinesDir, "query-only.yaml"));
  assert.equal(spec.metadata.name, "query-only");
  assert.equal(spec.spec.nodes.length, 5);
  assert.equal(spec.spec.edges.length, 4);
});

test("config YAML scalars/sequences parse correctly", () => {
  const global = parseYaml(readExample(configsDir, "global-config.yaml")) as {
    scope: string;
    values: Record<string, unknown>;
  };
  assert.equal(global.scope, "global");
  assert.equal(global.values["llm.provider"], "openai");
  assert.equal(global.values["llm.temperature"], 0.2);
  assert.equal(global.values["retrieval.top_k"], 5);

  const pipelineCfg = parseYaml(readExample(configsDir, "pipeline-config.yaml")) as {
    pipeline_id: string;
    values: Record<string, unknown>;
  };
  assert.equal(pipelineCfg.pipeline_id, "support-rag");
  assert.equal(pipelineCfg.values["retrieval.top_k"], 8);
  assert.deepEqual(pipelineCfg.values["chunking.chunk_size"], { value: 1000, locked: true });

  const secrets = parseYaml(readExample(configsDir, "example-secret-refs.yaml")) as {
    secrets: Array<Record<string, unknown>>;
  };
  assert.equal(secrets.secrets.length, 3);
  assert.equal(secrets.secrets[0].tenant_id, "tenant-a");
  assert.equal(secrets.secrets[0].key, "openai.api_key");

  const tenant = parseYaml(readExample(configsDir, "tenant-overrides.yaml")) as {
    tenant_pipeline_overrides: Array<Record<string, unknown>>;
  };
  assert.equal(tenant.tenant_pipeline_overrides.length, 3);
  assert.equal(tenant.tenant_pipeline_overrides[2].tenant_id, "tenant-local");
  assert.equal(
    (tenant.tenant_pipeline_overrides[2].values as Record<string, unknown>)["llm.base_url"],
    "http://ollama:11434"
  );
});

test("flow collections parse", () => {
  assert.deepEqual(parseYaml("a: [1, 2, 3]"), { a: [1, 2, 3] });
  assert.deepEqual(parseYaml("a: {x: 1, y: two}"), { a: { x: 1, y: "two" } });
  assert.deepEqual(parseYaml("list: [a, b, c]"), { list: ["a", "b", "c"] });
  assert.deepEqual(parseYaml("nested: [[1, 2], {k: v}]"), { nested: [[1, 2], { k: "v" }] });
});

test("scalar coercion and comments", () => {
  const doc = parseYaml(
    [
      "# leading comment",
      "int: 42",
      "float: 3.14",
      "neg: -7",
      "bool_t: true",
      "bool_f: false",
      "nil: ~",
      "nil2: null",
      "empty:",
      "quoted: \"1.0.0\"  # trailing comment",
      "single: 'it''s ok'",
      "plain: hello world  # inline",
      "url: http://ollama:11434"
    ].join("\n")
  ) as Record<string, unknown>;
  assert.equal(doc.int, 42);
  assert.equal(doc.float, 3.14);
  assert.equal(doc.neg, -7);
  assert.equal(doc.bool_t, true);
  assert.equal(doc.bool_f, false);
  assert.equal(doc.nil, null);
  assert.equal(doc.nil2, null);
  assert.equal(doc.empty, null);
  assert.equal(doc.quoted, "1.0.0");
  assert.equal(doc.single, "it's ok");
  assert.equal(doc.plain, "hello world");
  assert.equal(doc.url, "http://ollama:11434");
});

test("checksum is identical regardless of object key order", () => {
  const a: PipelineSpec = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "p", labels: { x: "1", y: "2" } },
    spec: { nodes: [{ id: "input", type: "input" }], edges: [] }
  };
  const b: PipelineSpec = {
    kind: "Pipeline",
    spec: { edges: [], nodes: [{ type: "input", id: "input" }] },
    metadata: { labels: { y: "2", x: "1" }, name: "p" },
    apiVersion: "rag-platform/v1"
  } as PipelineSpec;
  assert.equal(specChecksum(a), specChecksum(b));

  const c = JSON.parse(JSON.stringify(a)) as PipelineSpec;
  c.metadata.name = "different";
  assert.notEqual(specChecksum(a), specChecksum(c));
});

test("publishVersion: immutability rejection and idempotency", () => {
  const spec = loadPipelineSpecFromYaml(readExample(pipelinesDir, "query-only.yaml"));
  const fixedNow = () => "2026-05-17T00:00:00.000Z";

  const v1 = publishVersion([], spec, "1.0.0", { now: fixedNow });
  assert.equal(v1.status, "published");
  assert.equal(v1.version, "1.0.0");
  assert.equal(v1.pipelineId, "query-only");
  assert.equal(v1.publishedAt, "2026-05-17T00:00:00.000Z");

  // Republishing identical content is idempotent (returns the same record).
  const again = publishVersion([v1], spec, "1.0.0", { now: () => "2027-01-01T00:00:00.000Z" });
  assert.equal(again, v1);

  // Republishing different content under the same published version is rejected.
  const mutated = JSON.parse(JSON.stringify(spec)) as PipelineSpec;
  mutated.spec.nodes.push({ id: "extra", type: "output" });
  assert.throws(() => publishVersion([v1], mutated, "1.0.0"), ImmutableVersionError);

  // A new version number is allowed.
  const v2 = publishVersion([v1], mutated, "1.1.0", { now: fixedNow });
  assert.equal(v2.version, "1.1.0");
  assert.notEqual(v2.checksum, v1.checksum);
});

test("archiveVersion is idempotent", () => {
  const spec = loadPipelineSpecFromYaml(readExample(pipelinesDir, "query-only.yaml"));
  const v1 = publishVersion([], spec, "1.0.0", { now: () => "2026-05-17T00:00:00.000Z" });
  const archived = archiveVersion(v1);
  assert.equal(archived.status, "archived");
  assert.equal(archiveVersion(archived), archived);
  // Original record untouched.
  assert.equal(v1.status, "published");
});

test("selectDeployedVersion: tenant beats env-wide", () => {
  const deployments: PipelineDeployment[] = [
    { pipelineId: "support-rag", environment: "prod", version: "1.0.0" },
    { pipelineId: "support-rag", environment: "prod", version: "2.0.0", tenantId: "tenant-b" },
    { pipelineId: "support-rag", environment: "staging", version: "3.0.0" }
  ];

  assert.equal(
    selectDeployedVersion(deployments, { environment: "prod" })?.version,
    "1.0.0"
  );
  assert.equal(
    selectDeployedVersion(deployments, { environment: "prod", tenantId: "tenant-b" })?.version,
    "2.0.0"
  );
  // Tenant with no specific deployment falls back to env-wide.
  assert.equal(
    selectDeployedVersion(deployments, { environment: "prod", tenantId: "tenant-z" })?.version,
    "1.0.0"
  );
  assert.equal(
    selectDeployedVersion(deployments, { environment: "staging" })?.version,
    "3.0.0"
  );
  assert.equal(
    selectDeployedVersion(deployments, { environment: "dev" }),
    undefined
  );
});

test("export -> import round trip (JSON and YAML)", () => {
  for (const file of ["support-rag.yaml", "support-ingestion.yaml", "query-only.yaml"]) {
    const spec = loadPipelineSpecFromYaml(readExample(pipelinesDir, file));

    const json = exportSpec(spec, "json");
    const fromJson = importSpec(json);
    assert.equal(specChecksum(fromJson), specChecksum(spec), `JSON round trip failed for ${file}`);

    const yaml = exportSpec(spec, "yaml");
    const fromYaml = importSpec(yaml);
    assert.equal(specChecksum(fromYaml), specChecksum(spec), `YAML round trip failed for ${file}`);

    // loadPipelineSpec autodetects both formats.
    assert.equal(specChecksum(loadPipelineSpec(json)), specChecksum(spec));
    assert.equal(specChecksum(loadPipelineSpec(yaml)), specChecksum(spec));
  }
});

test("stringifyYaml round-trips arbitrary nested structures", () => {
  const value = {
    a: 1,
    b: "two",
    c: [1, "x", { d: true, e: null }],
    f: { g: { h: [{ i: "j" }] } },
    "dotted.key": "v",
    quoted: "1.0.0",
    spaced: "hello world"
  };
  assert.deepEqual(parseYaml(stringifyYaml(value)), value);
});
