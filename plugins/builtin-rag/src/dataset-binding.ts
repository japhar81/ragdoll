/**
 * ADR-0023 helpers — pick collection / connection out of a resolved
 * dataset's bindings map. Replaces the legacy `backends.<modality>`
 * accessors used pre-ADR-0023.
 *
 * Two helpers, both binding-name keyed:
 *   - pickBindingCollection: returns the effective collection /
 *     index / table name a plugin should read or write. Honours an
 *     explicit `config[cfgKey]` first, then the resolved binding's
 *     `collection`, then the legacy `config.collection` /
 *     `config.index` for v1 plugins that haven't migrated.
 *   - requireBindingConnection: strict variant for plugins that
 *     declare `requires: [{binding, kind}]`. Returns the resolved
 *     {url, slug, kind, cascade} or THROWS with an actionable error
 *     pointing the operator at the Datasets screen.
 *
 * Binding NAMES are free text — picked by the plugin author. The
 * common vocabulary today: "vectors" (vector retrievers / writers),
 * "text" (BM25 / lexical), "graph" (Dgraph / Neo4j), "rows"
 * (Postgres / ClickHouse tool-shaped reads).
 */
import type { PluginExecutionInput } from "../../../packages/plugin-sdk/src/index.ts";

/**
 * Resolve the effective collection / index / table name for the given
 * binding.
 *
 * @param input    full plugin execution input — reads `dataset.bindings`.
 * @param binding  the binding name the plugin uses (e.g. "vectors").
 * @param cfgKey   optional legacy config fallback key (e.g. "collection",
 *                 "index", "table"). When omitted the helper picks
 *                 "collection" for "vectors" and "index" for "text".
 */
export function pickBindingCollection(
  input: PluginExecutionInput,
  binding: string,
  cfgKey?: string
): string | undefined {
  const fromDataset = input.dataset?.bindings?.[binding]?.collection;
  if (fromDataset) return fromDataset;
  const key = cfgKey ?? (binding === "vectors" || binding === "vector" ? "collection" : "index");
  const fromConfig = input.config[key];
  return typeof fromConfig === "string" ? fromConfig : undefined;
}

/**
 * Strict variant for plugins that declare
 * `requires: [{binding, kind|kindOneOf}]`. Returns the binding's
 * resolved URL or THROWS with a clear "wire a connection" error
 * pointing at the offending dataset slug + binding name.
 *
 * Use this in any plugin that depends on a host being present (every
 * storage-touching plugin). The error message is the preflight signal
 * an operator sees in the execution-node row when the bind is
 * missing — keep it actionable.
 */
export function requireBindingConnection(
  input: PluginExecutionInput,
  binding: string,
  args: {
    pluginId: string;
    /** Default port when the resolved connection lacks one. */
    defaultPort?: number;
    scheme?: string;
  }
): {
  url: string;
  connectionSlug: string;
  connectionKind: string;
  cascadeReason: "global" | "tenant" | "environment";
} {
  const b = input.dataset?.bindings?.[binding];
  if (!b?.connectionHost) {
    const slug = input.dataset?.slug ?? "(no dataset bound)";
    throw new Error(
      `${args.pluginId} requires a "${binding}" binding on dataset "${slug}". ` +
        `Wire a connection on the Datasets screen — add a binding named "${binding}" ` +
        `pointing at a compatible connection (Connections screen lists what's available).`
    );
  }
  const port = typeof b.connectionPort === "number" ? b.connectionPort : args.defaultPort;
  const scheme = args.scheme ?? "http://";
  return {
    url: port ? `${scheme}${b.connectionHost}:${port}` : `${scheme}${b.connectionHost}`,
    connectionSlug: b.connectionSlug ?? "(unknown)",
    connectionKind: b.connectionKind ?? "(unknown)",
    cascadeReason: b.cascadeReason ?? "global"
  };
}

/**
 * Loose variant — same lookup but returns undefined instead of
 * throwing. Useful for plugins that fall back to a config-supplied
 * URL when no binding is wired (legacy path being phased out).
 */
export interface BindingUrlResolution {
  url: string;
  source: "binding" | "config" | "env";
  connectionSlug?: string;
  connectionKind?: string;
  cascadeReason?: "global" | "tenant" | "environment";
}

export function pickBindingUrl(
  input: PluginExecutionInput,
  binding: string,
  args: {
    /** Legacy config key on the node, e.g. "url" / "endpoint". */
    cfgKey: string;
    /** Env var fallback, e.g. "QDRANT_URL". */
    envFallback?: string;
    defaultPort?: number;
    scheme?: string;
  }
): BindingUrlResolution | undefined {
  const b = input.dataset?.bindings?.[binding];
  if (b?.connectionHost) {
    const port = typeof b.connectionPort === "number" ? b.connectionPort : args.defaultPort;
    const scheme = args.scheme ?? "http://";
    return {
      url: port ? `${scheme}${b.connectionHost}:${port}` : `${scheme}${b.connectionHost}`,
      source: "binding",
      connectionSlug: b.connectionSlug,
      connectionKind: b.connectionKind,
      cascadeReason: b.cascadeReason
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

// ===========================================================================
// Legacy aliases — kept for one release so plugins authored against the
// modality vocabulary keep compiling. New plugins should use the
// binding-keyed helpers above. The plugin-binding migration script
// rewrites callers in one pass.
// ===========================================================================

/** @deprecated ADR-0023: use {@link pickBindingCollection} with a binding name. */
export type StorageModality = "vector" | "keyword" | "graph" | "text";

/** @deprecated ADR-0023: use {@link pickBindingCollection}. The modality
 *  argument is mapped to a binding name via:
 *    vector  → "vectors"  (falls back to "vector")
 *    keyword → "text"     (falls back to "keyword")
 *    text    → "text"
 *    graph   → "graph"
 */
export function pickBackendName(
  input: PluginExecutionInput,
  modality: StorageModality,
  cfgKey?: string
): string | undefined {
  const candidates = MODALITY_BINDING_FALLBACKS[modality];
  for (const name of candidates) {
    const v = pickBindingCollection(input, name, cfgKey);
    if (v) return v;
  }
  return undefined;
}

/** @deprecated ADR-0023: use {@link requireBindingConnection}. */
export function requireBackendConnection(
  input: PluginExecutionInput,
  modality: StorageModality,
  args: { pluginId: string; defaultPort?: number; scheme?: string }
): { url: string; connectionName: string; cascadeReason: string } {
  const candidates = MODALITY_BINDING_FALLBACKS[modality];
  for (const name of candidates) {
    const b = input.dataset?.bindings?.[name];
    if (b?.connectionHost) {
      const r = requireBindingConnection(input, name, args);
      return {
        url: r.url,
        connectionName: r.connectionSlug,
        cascadeReason: r.cascadeReason
      };
    }
  }
  // Trigger the strict error on the canonical binding name so the
  // operator sees an actionable hint.
  return requireBindingConnection(input, candidates[0], args) as never;
}

const MODALITY_BINDING_FALLBACKS: Record<StorageModality, string[]> = {
  vector: ["vectors", "vector"],
  keyword: ["text", "keyword"],
  text: ["text", "keyword"],
  graph: ["graph"]
};

/** @deprecated ADR-0023: use {@link pickBindingUrl}. */
export const pickBackendUrl = pickBindingUrl;
/** @deprecated ADR-0023: use {@link BindingUrlResolution}. */
export type BackendUrlResolution = BindingUrlResolution;
