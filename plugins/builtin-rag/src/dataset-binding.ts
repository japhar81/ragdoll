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
export type StorageModality = "vector" | "keyword" | "graph" | "text";

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

/**
 * PR3 helper: pick the BASE URL for a storage backend given the
 * execution input. Mirrors `pickBackendName` but for hostnames + ports.
 *
 * Resolution order:
 *   1. `input.dataset.backends.<modality>.connection.{host, port}`
 *      — set by the dataset resolver when the backend block referenced
 *      a connection by name and that connection was found.
 *   2. Legacy: `input.config[cfgKey]` (e.g. `config.url` for qdrant,
 *      `config.endpoint` for opensearch) — surfaced via the `source`
 *      field so callers can log a deprecation hint.
 *   3. `process.env[envFallback]` — last-resort env var (e.g.
 *      QDRANT_URL) so installs that pin a single backend cluster don't
 *      have to define connections at all.
 *
 * Returns undefined when nothing matches; the caller decides whether
 * to throw or default further (e.g. to localhost).
 */
export interface BackendUrlResolution {
  url: string;
  /** Where the URL came from — for diagnostic logging. */
  source: "dataset_connection" | "config" | "env";
  /** When source === "dataset_connection", the connection name +
   *  cascade reason so the call site can include them in logs. */
  connectionName?: string;
  cascadeReason?: "env_specific" | "tenant_fallback";
}

/**
 * Strict variant for v2-plus plugins that declare
 * `requires: [{modality, provider?}]`. Returns the dataset's resolved
 * connection URL or THROWS with a clear "you need to bind a
 * connection" error pointing at the offending dataset slug.
 *
 * Use this in any plugin that depends on a host being present
 * (i.e. all storage-touching plugins). The error message is the
 * preflight signal an operator sees in the execution-node row when
 * the bind is missing — keep it actionable.
 */
export function requireBackendConnection(
  input: PluginExecutionInput,
  modality: StorageModality,
  args: {
    pluginId: string;
    /** Used in the URL constructor when the connection lacks a port. */
    defaultPort?: number;
    scheme?: string;
  }
): { url: string; connectionName: string; cascadeReason: string } {
  const conn = input.dataset?.backends?.[modality]?.connection;
  if (!conn?.host) {
    const slug = input.dataset?.slug ?? "(no dataset bound)";
    throw new Error(
      `${args.pluginId} requires a ${modality} connection on dataset "${slug}". ` +
        `Wire it on the Connections screen (one per (tenant, env)) and reference it from ` +
        `the dataset's backends.${modality}.connectionName.`
    );
  }
  const port = typeof conn.port === "number" ? conn.port : args.defaultPort;
  const scheme = args.scheme ?? "http://";
  return {
    url: port ? `${scheme}${conn.host}:${port}` : `${scheme}${conn.host}`,
    connectionName: conn.name,
    cascadeReason: conn.cascadeReason
  };
}

export function pickBackendUrl(
  input: PluginExecutionInput,
  modality: StorageModality,
  args: {
    /** Legacy config key on the node, e.g. "url" / "endpoint". */
    cfgKey: string;
    /** Env var fallback, e.g. "QDRANT_URL". */
    envFallback?: string;
    /** When the resolved connection lacks an explicit port, append
     *  this default before constructing the URL. */
    defaultPort?: number;
    /** Scheme to use when constructing from host+port. Defaults to
     *  "http://" since cluster-internal traffic is the common path. */
    scheme?: string;
  }
): BackendUrlResolution | undefined {
  const conn = input.dataset?.backends?.[modality]?.connection;
  if (conn && typeof conn.host === "string") {
    const port = typeof conn.port === "number" ? conn.port : args.defaultPort;
    const scheme = args.scheme ?? "http://";
    const url = port ? `${scheme}${conn.host}:${port}` : `${scheme}${conn.host}`;
    return {
      url,
      source: "dataset_connection",
      connectionName: conn.name,
      cascadeReason: conn.cascadeReason
    };
  }
  const cfg = input.config[args.cfgKey];
  if (typeof cfg === "string" && cfg) {
    return { url: cfg, source: "config" };
  }
  if (args.envFallback) {
    const env = process.env[args.envFallback];
    if (env) return { url: env, source: "env" };
  }
  return undefined;
}
