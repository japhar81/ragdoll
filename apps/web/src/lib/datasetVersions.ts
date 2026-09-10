/**
 * Pure helpers for the Datasets screen's version-cutting affordance.
 *
 * Kept DOM-free / React-free so the web test runner (node:test, no jsdom) can
 * exercise them directly — the component that uses them (`DatasetsScreen`)
 * imports React and can't be loaded under the runner.
 */
import type { DatasetView } from "./api.ts";

/**
 * Backend collection base-names to snapshot when cutting a version: each
 * binding name → its explicit collection override, else the dataset slug.
 * Passing these gives per-dataset index naming (`<slug>_tenant_<env>` after
 * namespace expansion) instead of the runtime falling back to a shared
 * `default` index for a version cut with empty backendCollections.
 */
export function initialBackendCollections(
  dataset: DatasetView
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, b] of Object.entries(dataset.bindings ?? {})) {
    const explicit = typeof b?.collection === "string" ? b.collection.trim() : "";
    out[name] = explicit || dataset.slug;
  }
  return out;
}
