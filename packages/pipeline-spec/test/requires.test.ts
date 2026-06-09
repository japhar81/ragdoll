/**
 * Tests for the validator's plugin-`requires` enforcement.
 *
 * ADR-0023: plugins declare `requires: [{binding, kind|kindOneOf}]`.
 * The validator's `datasetIndex` callback returns each dataset's
 * binding map: `{bindings: {<name>: {connectionKind?}}}`. Errors:
 *   - `dataset_binding_missing` when a required binding isn't declared.
 *   - `dataset_binding_kind_mismatch` when the connectionKind doesn't
 *     satisfy `kind` / `kindOneOf`.
 *
 * Legacy `{modality, provider}` plugin manifests + `datasetModalities`
 * keep working — they translate 1:1 to {binding, kind}.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  validatePipelineSpec,
  type DatasetBindingIndex
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
  requires?: Array<{
    binding?: string;
    kind?: string;
    kindOneOf?: string[];
    modality?: string;
    provider?: string;
  }>;
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
      requires: manifest.requires as any,
      datasetModalities: manifest.datasetModalities as any
    },
    implementation: { manifest: {} as any, async execute() { return { outputs: {} }; } }
  });
  return r;
}

// ADR-0023: validator is binding-keyed. Legacy `{modality, provider}`
// requires translate 1:1 to `{binding, kind}`. Codes are now
// `dataset_binding_missing` and `dataset_binding_kind_mismatch`.

test("requires: binding present + kind matches → no errors", () => {
  const reg = registryWith({
    id: "qdrant_writer",
    category: "vector_store",
    requires: [{ binding: "vectors", kind: "qdrant" }]
  });
  const idx: DatasetBindingIndex = (slug) =>
    slug === "docs"
      ? { bindings: { vectors: { connectionKind: "qdrant" } } }
      : undefined;
  const r = validatePipelineSpec(
    specWith({ pluginId: "qdrant_writer", pluginCategory: "vector_store", datasetSlug: "docs" }),
    reg,
    idx
  );
  assert.equal(
    r.errors.find((e) => e.code === "dataset_binding_kind_mismatch"),
    undefined,
    "no kind mismatch when kinds match"
  );
});

test("requires: kind MISMATCH → dataset_binding_kind_mismatch error", () => {
  const reg = registryWith({
    id: "qdrant_writer",
    category: "vector_store",
    requires: [{ binding: "vectors", kind: "qdrant" }]
  });
  const idx: DatasetBindingIndex = (slug) =>
    slug === "docs"
      ? { bindings: { vectors: { connectionKind: "opensearch" } } }
      : undefined;
  const r = validatePipelineSpec(
    specWith({ pluginId: "qdrant_writer", pluginCategory: "vector_store", datasetSlug: "docs" }),
    reg,
    idx
  );
  const issue = r.errors.find((e) => e.code === "dataset_binding_kind_mismatch");
  assert.ok(issue, "must surface kind mismatch");
  assert.match(issue!.message, /requires binding "vectors" backed by qdrant/);
  assert.match(issue!.message, /"opensearch" connection/);
  assert.equal(issue!.nodeId, "store");
});

test("requires: binding missing → dataset_binding_missing", () => {
  const reg = registryWith({
    id: "graph_writer",
    category: "sink",
    requires: [{ binding: "graph" }]
  });
  const idx: DatasetBindingIndex = (slug) =>
    slug === "docs"
      ? { bindings: { vectors: { connectionKind: "qdrant" } } }
      : undefined;
  const r = validatePipelineSpec(
    specWith({ pluginId: "graph_writer", pluginCategory: "sink", datasetSlug: "docs" }),
    reg,
    idx
  );
  const issue = r.errors.find((e) => e.code === "dataset_binding_missing");
  assert.ok(issue);
  assert.match(issue!.message, /needs the "graph" binding/);
});

test("requires: kind omitted = any kind matches", () => {
  const reg = registryWith({
    id: "any_vector_reader",
    category: "retriever",
    requires: [{ binding: "vectors" }]
  });
  const idx: DatasetBindingIndex = (slug) =>
    slug === "docs"
      ? { bindings: { vectors: { connectionKind: "opensearch" } } }
      : undefined;
  const r = validatePipelineSpec(
    specWith({ pluginId: "any_vector_reader", pluginCategory: "retriever", datasetSlug: "docs" }),
    reg,
    idx
  );
  assert.equal(
    r.errors.find((e) => e.code === "dataset_binding_kind_mismatch"),
    undefined
  );
});

test("legacy datasetModalities path: maps to bindings with same name", () => {
  const reg = registryWith({
    id: "legacy_writer",
    category: "vector_store",
    datasetModalities: ["vectors"]
  });
  const idx: DatasetBindingIndex = (slug) =>
    slug === "docs"
      ? { bindings: { vectors: { connectionKind: "qdrant" } } }
      : undefined;
  const r = validatePipelineSpec(
    specWith({ pluginId: "legacy_writer", pluginCategory: "vector_store", datasetSlug: "docs" }),
    reg,
    idx
  );
  assert.equal(r.errors.length, 0, "legacy modality-only path stays green");
});

test("connectionKind unknown → kind check skipped (degrades gracefully)", () => {
  // When the Builder hasn't loaded the connection catalog yet, the
  // index returns bindings without a connectionKind. The validator's
  // kind check silently skips; the worker re-validates at execute.
  const reg = registryWith({
    id: "qdrant_writer",
    category: "vector_store",
    requires: [{ binding: "vectors", kind: "qdrant" }]
  });
  const idx: DatasetBindingIndex = (slug) =>
    slug === "docs" ? { bindings: { vectors: {} } } : undefined;
  const r = validatePipelineSpec(
    specWith({ pluginId: "qdrant_writer", pluginCategory: "vector_store", datasetSlug: "docs" }),
    reg,
    idx
  );
  assert.equal(
    r.errors.find((e) => e.code === "dataset_binding_kind_mismatch"),
    undefined
  );
});

test("requires: multi-binding hybrid — both slots checked", () => {
  const reg = registryWith({
    id: "os_hybrid",
    category: "retriever",
    requires: [
      { binding: "vectors", kind: "opensearch" },
      { binding: "text", kind: "opensearch" }
    ]
  });
  // Dataset has only vectors — text is missing → binding_missing.
  const idxMissingText: DatasetBindingIndex = (slug) =>
    slug === "docs"
      ? { bindings: { vectors: { connectionKind: "opensearch" } } }
      : undefined;
  const r1 = validatePipelineSpec(
    specWith({ pluginId: "os_hybrid", pluginCategory: "retriever", datasetSlug: "docs" }),
    reg,
    idxMissingText
  );
  assert.ok(r1.errors.find((e) => e.code === "dataset_binding_missing"));
  // Dataset has both bindings, but vectors is qdrant — kind mismatch.
  const idxWrongKind: DatasetBindingIndex = (slug) =>
    slug === "docs"
      ? {
          bindings: {
            vectors: { connectionKind: "qdrant" },
            text: { connectionKind: "opensearch" }
          }
        }
      : undefined;
  const r2 = validatePipelineSpec(
    specWith({ pluginId: "os_hybrid", pluginCategory: "retriever", datasetSlug: "docs" }),
    reg,
    idxWrongKind
  );
  const kindIssues = r2.errors.filter((e) => e.code === "dataset_binding_kind_mismatch");
  assert.equal(kindIssues.length, 1, "only the wrong-kind binding flags");
  assert.match(kindIssues[0].message, /binding "vectors".*qdrant.*connection/);
});
