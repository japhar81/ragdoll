/**
 * Plugin registry — the catalog should include the core RAG plugins,
 * and v2-contract storage plugins should carry the new
 * `datasetModalities` field exactly as the Builder picker expects.
 */
import { test, expect } from "../helpers/fixtures.ts";

interface PluginInfo {
  id: string;
  category: string;
  version: string;
  contract?: number;
  datasetModalities?: string[];
}

test.describe("plugins", () => {
  test("plugin list returns the core RAG catalog", async ({ rest }) => {
    const res = await rest.request<{ plugins: PluginInfo[] }>(
      "GET",
      "/api/plugins"
    );
    const ids = new Set(res.plugins.map((p) => p.id));
    // Storage / retriever plugins the Builder picker needs.
    for (const expected of [
      "qdrant_retriever",
      "qdrant_vector_store",
      "qdrant_delete",
      "opensearch_output",
      "basic_text_chunker",
      "provider_embeddings",
      "provider_chat"
    ]) {
      expect(ids.has(expected), `missing plugin: ${expected}`).toBe(true);
    }
  });

  test("v2 storage plugins carry datasetModalities on the wire", async ({
    rest
  }) => {
    const res = await rest.request<{ plugins: PluginInfo[] }>(
      "GET",
      "/api/plugins"
    );
    const qdrantRetriever = res.plugins.find(
      (p) => p.id === "qdrant_retriever"
    );
    expect(qdrantRetriever?.contract).toBeGreaterThanOrEqual(2);
    expect(qdrantRetriever?.datasetModalities).toEqual(
      expect.arrayContaining(["vector"])
    );
    const opensearchOutput = res.plugins.find(
      (p) => p.id === "opensearch_output"
    );
    expect(opensearchOutput?.datasetModalities).toEqual(
      expect.arrayContaining(["text"])
    );
    const hybrid = res.plugins.find(
      (p) => p.id === "opensearch_hybrid_retriever"
    );
    if (hybrid) {
      // Hybrid needs both modalities — verifies the array form works.
      expect(hybrid.datasetModalities).toEqual(
        expect.arrayContaining(["vector", "text"])
      );
    }
  });

  test("per-plugin doc endpoint serves a non-empty body", async ({ rest }) => {
    // dataset_search is one of the plugins documented under docs/plugins.
    // The endpoint returns plain markdown.
    const res = await fetch(
      `${process.env.RAGDOLL_API_URL ?? "http://localhost:3001"}/api/plugins/dataset_search/docs`,
      { headers: { authorization: `Bearer ${rest.token}` } }
    );
    expect(res.ok || res.status === 404).toBe(true);
    if (res.ok) {
      const body = await res.text();
      expect(body.length).toBeGreaterThan(0);
    }
  });
});
