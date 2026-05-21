/**
 * Pipeline / configs / manifest YAML round-trips. The encrypted secret
 * bundle is exercised by the crypto suite; this file is the pure
 * yaml-to-shape mapping.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CURRENT_MANIFEST_FORMAT,
  configValuesToYaml,
  manifestToYaml,
  pipelineToYaml,
  yamlToConfigValues,
  yamlToManifest,
  yamlToPipeline
} from "../src/serializers.ts";

test("pipelineToYaml/yamlToPipeline round-trip a minimal spec", () => {
  const file = {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline" as const,
    metadata: { slug: "intake", name: "Intake", version: "1.2.3" },
    spec: {
      nodes: [{ id: "in", type: "input" }],
      edges: []
    }
  };
  const text = pipelineToYaml(file);
  assert.match(text, /slug: intake/);
  const back = yamlToPipeline(text);
  assert.equal(back.metadata.slug, "intake");
  assert.equal(back.metadata.version, "1.2.3");
  assert.deepEqual(back.spec, file.spec);
});

test("yamlToPipeline rejects files missing required metadata", () => {
  assert.throws(() => yamlToPipeline("kind: Pipeline\n"), /metadata missing/);
  assert.throws(
    () => yamlToPipeline("kind: NotPipeline\nmetadata: {slug: x, name: y}\nspec: {}"),
    /kind must be/
  );
  assert.throws(
    () => yamlToPipeline("kind: Pipeline\nmetadata: {name: y}\nspec: {}"),
    /slug missing/
  );
});

test("configValuesToYaml sorts entries deterministically", () => {
  const a = configValuesToYaml([
    { key: "zeta", value: 1, scope: "tenant" },
    { key: "alpha", value: 2, scope: "tenant" },
    { key: "alpha", value: 3, scope: "tenant_pipeline", scopeId: "p1" }
  ]);
  const lines = a.split("\n").filter((l) => l.trim().startsWith("- key:"));
  assert.equal(lines[0].trim(), "- key: alpha");
  assert.equal(lines[1].trim(), "- key: alpha");
  assert.equal(lines[2].trim(), "- key: zeta");
});

test("yamlToConfigValues round-trips through the sorter", () => {
  const yaml = configValuesToYaml([
    { key: "retrieval.top_k", value: 5, scope: "tenant", locked: false }
  ]);
  const back = yamlToConfigValues(yaml);
  assert.equal(back.length, 1);
  assert.equal(back[0].key, "retrieval.top_k");
  assert.equal(back[0].value, 5);
});

test("manifest round-trips with the current format version", () => {
  const text = manifestToYaml({
    apiVersion: "rag-platform/v1",
    kind: "Manifest",
    tenant: { slug: "acme", name: "Acme" },
    environment: { slug: "dev" },
    format: CURRENT_MANIFEST_FORMAT
  });
  const back = yamlToManifest(text);
  assert.equal(back.tenant.slug, "acme");
  assert.equal(back.environment.slug, "dev");
  assert.equal(back.format, CURRENT_MANIFEST_FORMAT);
});

test("yamlToManifest rejects bad shapes", () => {
  assert.throws(() => yamlToManifest("kind: NotManifest"), /expected kind=Manifest/);
  assert.throws(
    () => yamlToManifest("kind: Manifest\ntenant:\n  name: x"),
    /tenant.slug \+ environment.slug required/
  );
});
