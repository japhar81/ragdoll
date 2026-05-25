/**
 * Phase 7 helper: pick the backend collection / index name for a
 * v2-contract storage plugin given the execution input.
 *
 * The runtime no longer splices `config.collection` for `contract: 2`
 * plugins (the shim is v1-only), so each v2 plugin reads the name out
 * of `input.dataset.backendCollections` first and falls back to the
 * legacy `config.collection` / `config.index` so a pipeline that's NOT
 * been migrated to a dataset reference keeps working unchanged.
 *
 * Falls through to `undefined` when neither source provides a name —
 * the plugin then decides whether to throw or default ("default", the
 * resolved-config value, etc.) to preserve the exact pre-Phase-5
 * behaviour.
 */
import type { PluginExecutionInput } from "../../../packages/plugin-sdk/src/index.ts";

/** Modality keys used in `dataset.backendCollections`. */
export type StorageModality = "vector" | "keyword";

/**
 * Returns the backend collection name for the given modality.
 *
 * @param input  the full plugin execution input — we read both
 *               `dataset.backendCollections` and `config[cfgKey]`.
 * @param modality which side of the dataset to fetch.
 * @param cfgKey the legacy config key. Defaults to "collection" for
 *               vector and "index" for keyword (the keys every existing
 *               plugin uses today).
 */
export function pickBackendName(
  input: PluginExecutionInput,
  modality: StorageModality,
  cfgKey?: string
): string | undefined {
  const fromDataset = input.dataset?.backendCollections?.[modality];
  if (fromDataset) return fromDataset;
  const key = cfgKey ?? (modality === "vector" ? "collection" : "index");
  const fromConfig = input.config[key];
  return typeof fromConfig === "string" ? fromConfig : undefined;
}
