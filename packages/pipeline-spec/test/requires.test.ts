/**
 * Tests for the validator's plugin-`requires` enforcement.
 *
 * Two layers ride on the same `requires: [{modality, provider?}]`:
 *   - modality presence (was previously enforced via `datasetModalities`
 *     — `requires` extends that path).
 *   - provider equality (new): bound dataset's
 *     `backends[modality].provider` must match when the plugin pins one.
 *
 * The validator accepts either the legacy modality-only index or the
 * new binding index that ALSO returns providers. Tests cover both
 * shapes so callers can migrate at their own pace.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  validatePipelineSpec,
  type DatasetBindingIndex,
  type DatasetModalityIndex
} from "../src/index.ts";
import type { PipelineSpec } from "../../core/src/index.ts";
import { PluginRegistry } from "../../plugin-sdk/src/index.ts";

function specWith(args: {
  pluginId: string;
  pluginCategory: string;
  datasetSlug: string;
}): PipelineSpec {
  return {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "test" },
    spec: {
      nodes: [
        {
          id: "store",
          plugin: { category: args.pluginCategory as any, id: args.pluginId, version: "1.0.0" },
          dataset: { slug: args.datasetSlug, alias: "stable" }
        }
      ],
      edges: []
    }
  };
}

function registryWith(manifest: {
  id: string;
  category: string;
  requires?: Array<{ modality: string; provider?: string }>;
  datasetModalities?: string[];
}): PluginRegistry {
  const r = new PluginRegistry();
  r.register({
    mode: "in_process",
    manifest: {
      id: manifest.id,
      name: manifest.id,
      version: "1.0.0",
      category: manifest.category as any,
      description: "test",
      contract: 2,
      requires: manifest.requires,
      datasetModalities: manifest.datasetModalities
    },
    implementation: { manifest: {} as any, async execute() { return { outputs: {} }; } }
  });
  return r;
}

test("requires: modality match + provider match → no errors", () => {
  const reg = registryWith({
    id: "qdrant_writer",
    category: "vector_store",
    requires: [{ modality: "vector", provider: "qdrant" }]
  });
  const idx: DatasetBindingIndex = (slug) =>
    slug === "docs"
      ? { modalities: ["vector"], providers: { vector: "qdrant" } }
      : undefined;
  const r = validatePipelineSpec(
    specWith({ pluginId: "qdrant_writer", pluginCategory: "vector_store", datasetSlug: "docs" }),
    reg,
    idx
  );
  assert.equal(
    r.errors.find((e) => e.code === "dataset_provider_mismatch"),
    undefined,
    "no provider mismatch when providers match"
  );
});

test("requires: provider MISMATCH → dataset_provider_mismatch error", () => {
  const reg = registryWith({
    id: "qdrant_writer",
    category: "vector_store",
    requires: [{ modality: "vector", provider: "qdrant" }]
  });
  // Dataset has the modality but provider is opensearch — should error.
  const idx: DatasetBindingIndex = (slug) =>
    slug === "docs"
      ? { modalities: ["vector"], providers: { vector: "opensearch" } }
      : undefined;
  const r = validatePipelineSpec(
    specWith({ pluginId: "qdrant_writer", pluginCategory: "vector_store", datasetSlug: "docs" }),
    reg,
    idx
  );
  const issue = r.errors.find((e) => e.code === "dataset_provider_mismatch");
  assert.ok(issue, "must surface provider mismatch");
  assert.match(issue!.message, /requires the vector backend to be provider "qdrant"/);
  assert.match(issue!.message, /set to "opensearch"/);
  assert.equal(issue!.nodeId, "store");
});

test("requires: modality missing → dataset_modality_mismatch", () => {
  const reg = registryWith({
    id: "graph_writer",
    category: "sink",
    requires: [{ modality: "graph" }]
  });
  const idx: DatasetBindingIndex = (slug) =>
    slug === "docs"
      ? { modalities: ["vector"], providers: { vector: "qdrant" } }
      : undefined;
  const r = validatePipelineSpec(
    specWith({ pluginId: "graph_writer", pluginCategory: "sink", datasetSlug: "docs" }),
    reg,
    idx
  );
  const issue = r.errors.find((e) => e.code === "dataset_modality_mismatch");
  assert.ok(issue);
  assert.match(issue!.message, /needs the graph backend/);
});

test("requires: provider omitted = any provider matches", () => {
  // `provider?` is optional — a plugin that doesn't pin its provider
  // (e.g. an LLM-side retriever that supports multiple vector backends)
  // gets a green light against any matching modality.
  const reg = registryWith({
    id: "any_vector_reader",
    category: "retriever",
    requires: [{ modality: "vector" }]
  });
  const idx: DatasetBindingIndex = (slug) =>
    slug === "docs"
      ? { modalities: ["vector"], providers: { vector: "opensearch" } }
      : undefined;
  const r = validatePipelineSpec(
    specWith({ pluginId: "any_vector_reader", pluginCategory: "retriever", datasetSlug: "docs" }),
    reg,
    idx
  );
  assert.equal(
    r.errors.find((e) => e.code === "dataset_provider_mismatch"),
    undefined
  );
});

test("legacy DatasetModalityIndex (string[]) still works for plugins without requires", () => {
  const reg = registryWith({
    id: "legacy_writer",
    category: "vector_store",
    datasetModalities: ["vector"]
  });
  const idx: DatasetModalityIndex = (slug) =>
    slug === "docs" ? ["vector"] : undefined;
  const r = validatePipelineSpec(
    specWith({ pluginId: "legacy_writer", pluginCategory: "vector_store", datasetSlug: "docs" }),
    reg,
    idx
  );
  assert.equal(r.errors.length, 0, "legacy modality-only path stays green");
});

test("legacy index + new requires(provider) — provider check is skipped (no info)", () => {
  // When the caller passes the old string[] index, the validator has no
  // provider info; the modality check still runs, the provider check
  // silently skips. The worker re-validates at execute time with full
  // dataset rows, so a real mismatch still fails before any node runs.
  const reg = registryWith({
    id: "qdrant_writer",
    category: "vector_store",
    requires: [{ modality: "vector", provider: "qdrant" }]
  });
  const idx: DatasetModalityIndex = (slug) =>
    slug === "docs" ? ["vector"] : undefined;
  const r = validatePipelineSpec(
    specWith({ pluginId: "qdrant_writer", pluginCategory: "vector_store", datasetSlug: "docs" }),
    reg,
    idx
  );
  assert.equal(
    r.errors.find((e) => e.code === "dataset_provider_mismatch"),
    undefined
  );
});

test("requires: multi-modal hybrid — both slots checked", () => {
  // opensearch_hybrid_retriever-style: needs BOTH vector and text on
  // the same dataset, BOTH provided by opensearch.
  const reg = registryWith({
    id: "os_hybrid",
    category: "retriever",
    requires: [
      { modality: "vector", provider: "opensearch" },
      { modality: "text", provider: "opensearch" }
    ]
  });
  // Dataset has only vector — text is missing → modality_mismatch.
  const idxMissingText: DatasetBindingIndex = (slug) =>
    slug === "docs"
      ? { modalities: ["vector"], providers: { vector: "opensearch" } }
      : undefined;
  const r1 = validatePipelineSpec(
    specWith({ pluginId: "os_hybrid", pluginCategory: "retriever", datasetSlug: "docs" }),
    reg,
    idxMissingText
  );
  assert.ok(r1.errors.find((e) => e.code === "dataset_modality_mismatch"));
  // Dataset has both modalities, but vector is qdrant — provider mismatch.
  const idxWrongProvider: DatasetBindingIndex = (slug) =>
    slug === "docs"
      ? {
          modalities: ["vector", "text"],
          providers: { vector: "qdrant", text: "opensearch" }
        }
      : undefined;
  const r2 = validatePipelineSpec(
    specWith({ pluginId: "os_hybrid", pluginCategory: "retriever", datasetSlug: "docs" }),
    reg,
    idxWrongProvider
  );
  const provIssues = r2.errors.filter((e) => e.code === "dataset_provider_mismatch");
  assert.equal(provIssues.length, 1, "only the wrong-provider modality flags");
  assert.match(provIssues[0].message, /vector backend.*qdrant/);
});
