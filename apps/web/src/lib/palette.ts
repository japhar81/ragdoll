/**
 * Pure, DOM-free Node-Palette helpers: per-plugin node construction, schema
 * default extraction, deterministic plugin grouping, the drag descriptor
 * codec, and the palette quick-filter.
 *
 * Nothing here imports React / reactflow / the DOM so it is unit-testable with
 * `node --test` and zero install. The PipelineBuilder palette consumes these.
 */
import type { PluginInfo, JsonSchemaLike } from "./api.ts";
import type { PipelineNode, PluginCategory } from "./types.ts";

/**
 * Seed a freshly-dropped node's `config` from its plugin's JSON schema: every
 * TOP-LEVEL object property that declares a `default` contributes
 * `{ key: default }`. Properties without a default are skipped (the inspector
 * form fills them). Tolerant: a missing / non-object / property-less schema
 * yields `{}`, and this never throws.
 */
export function defaultConfigFromSchema(
  schema?: JsonSchemaLike
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = schema?.properties;
  if (!props || typeof props !== "object") return out;
  for (const [key, propSchema] of Object.entries(props)) {
    if (
      propSchema &&
      typeof propSchema === "object" &&
      "default" in propSchema &&
      propSchema.default !== undefined
    ) {
      out[key] = propSchema.default;
    }
  }
  return out;
}

/**
 * Build a new PipelineNode for a specific palette plugin. Carries the exact
 * plugin ref the user dragged and pre-fills `config` from the plugin's schema
 * defaults so the inspector form opens populated (no JSON incantations).
 */
export function newNodeFromPlugin(
  p: {
    category: PluginCategory | string;
    id: string;
    version: string;
    configSchema?: JsonSchemaLike;
  },
  id: string
): PipelineNode {
  return {
    id,
    plugin: {
      category: p.category as PluginCategory,
      id: p.id,
      version: p.version
    },
    config: defaultConfigFromSchema(p.configSchema)
  };
}

/**
 * Coarse "which backend does this storage plugin talk to" classifier,
 * used by the Builder to pre-fill `node.dataset` when an operator drags
 * in a new storage node and there's already a sibling node wired to a
 * dataset of the same family. v1-style plugins (`vector_upsert`) share
 * the qdrant family because that's what `createVectorStore` defaults to
 * when no explicit backend is wired; v2 dataset_* primitives don't have
 * a fixed family so they're left as `undefined` and the user picks.
 */
export function backendFamily(pluginId: string | undefined): string | undefined {
  if (!pluginId) return undefined;
  if (pluginId.startsWith("qdrant_")) return "qdrant";
  if (pluginId.startsWith("opensearch_")) return "opensearch";
  if (pluginId === "vector_upsert") return "qdrant";
  return undefined;
}

/**
 * If the current pipeline already has a node in the same backend
 * family with a dataset set, copy that dataset onto the new node so
 * the operator doesn't re-pick it. Most pipelines stay wired to a
 * single corpus across all their storage nodes — this just makes the
 * common case zero-click.
 *
 * Returns the dataset to attach (or `undefined` to leave it blank).
 */
export function defaultDatasetForNewNode(
  newPluginId: string | undefined,
  existingNodes: Iterable<PipelineNode>
): PipelineNode["dataset"] | undefined {
  const family = backendFamily(newPluginId);
  if (!family) return undefined;
  for (const sibling of existingNodes) {
    if (!sibling.dataset) continue;
    if (backendFamily(sibling.plugin?.id) === family) {
      // Spread so a later edit on the new node doesn't mutate the sibling.
      return { ...sibling.dataset };
    }
  }
  return undefined;
}

/**
 * Fixed display order for palette groups. A plugin's group is
 * `ui.paletteGroup || <derived from category>`; anything not matched here
 * falls into the trailing "Other" bucket so the layout is deterministic
 * regardless of registry order.
 */
export const PALETTE_GROUP_ORDER = [
  "Sources",
  "Ingestion",
  "Parsing",
  "Embeddings",
  "Storage",
  "Retrieval",
  "Prompting",
  "Models",
  "Transform",
  "Routing",
  "Control",
  "Guardrails",
  "Evaluation",
  "Memory",
  "Tools",
  "Other"
] as const;

const OTHER_GROUP = "Other";

/**
 * The palette group each plugin category maps to. Category is the single
 * source of truth for plugin organization — the builtin plugins set no
 * `ui.paletteGroup`, so this map drives the whole palette. (`ui.paletteGroup`
 * remains an opt-in override for external plugins; see `groupForPlugin`.)
 * Every one of the 19 core categories is mapped, so no builtin ever falls
 * into the trailing "Other" bucket.
 */
const CATEGORY_GROUP: Record<string, string> = {
  datasource: "Sources",
  loader: "Ingestion",
  parser: "Parsing",
  chunker: "Ingestion",
  embedder: "Embeddings",
  vector_store: "Storage",
  retriever: "Retrieval",
  reranker: "Retrieval",
  llm: "Models",
  prompt_template: "Prompting",
  tool: "Tools",
  guardrail: "Guardrails",
  evaluator: "Evaluation",
  output_parser: "Parsing",
  transformer: "Transform",
  router: "Routing",
  control: "Control",
  memory: "Memory",
  sink: "Storage"
};

/** The palette group a single plugin belongs to (paletteGroup wins). */
export function groupForPlugin(p: PluginInfo): string {
  const explicit = p.ui?.paletteGroup;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim();
  }
  return CATEGORY_GROUP[p.category] ?? OTHER_GROUP;
}

export interface PaletteGroup {
  group: string;
  items: PluginInfo[];
}

/**
 * Group plugins by `ui.paletteGroup || category` into a stable, deterministic
 * list: groups appear in PALETTE_GROUP_ORDER (any unknown group bucketed into
 * "Other", which always sorts last), then any leftover named groups appear
 * alphabetically before "Other". Items inside a group are sorted by name
 * (case-insensitive), then id, so render order never depends on registry
 * iteration order. Empty input -> [].
 */
export function groupPalette(plugins: PluginInfo[]): PaletteGroup[] {
  const buckets = new Map<string, PluginInfo[]>();
  for (const p of plugins ?? []) {
    const known = PALETTE_GROUP_ORDER as readonly string[];
    const raw = groupForPlugin(p);
    const group = known.includes(raw) ? raw : OTHER_GROUP;
    const list = buckets.get(group) ?? [];
    list.push(p);
    buckets.set(group, list);
  }

  const cmp = (a: PluginInfo, b: PluginInfo): number => {
    const an = (a.name ?? a.id ?? "").toLowerCase();
    const bn = (b.name ?? b.id ?? "").toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    return (a.id ?? "").localeCompare(b.id ?? "");
  };

  const orderIndex = (g: string): number => {
    const i = (PALETTE_GROUP_ORDER as readonly string[]).indexOf(g);
    return i === -1 ? PALETTE_GROUP_ORDER.length : i;
  };

  return [...buckets.keys()]
    .sort((a, b) => {
      const ia = orderIndex(a);
      const ib = orderIndex(b);
      if (ia !== ib) return ia - ib;
      return a.localeCompare(b);
    })
    .map((group) => ({
      group,
      items: [...(buckets.get(group) ?? [])].sort(cmp)
    }));
}

/**
 * The structured drag payload carried in the DND_MIME slot. Either an io
 * sentinel (Input/Output) or a concrete plugin ref so the drop target builds
 * exactly the node the user picked.
 */
export type PaletteDragItem =
  | { kind: "io"; io: "input" | "output" }
  | { kind: "plugin"; category: string; id: string; version: string };

/** Serialize a palette drag item to the dataTransfer string (JSON). */
export function encodePaletteDrag(item: PaletteDragItem): string {
  return JSON.stringify(item);
}

/**
 * Parse a drag payload back into a PaletteDragItem. Tolerant: non-JSON,
 * wrong-shaped, or unknown-kind values yield `undefined` so a stray drop can
 * never crash the builder (and a legacy bare-category string is rejected
 * rather than mis-handled).
 */
export function decodePaletteDrag(str: string): PaletteDragItem | undefined {
  if (typeof str !== "string" || str.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(str);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  if (obj.kind === "io") {
    if (obj.io === "input" || obj.io === "output") {
      return { kind: "io", io: obj.io };
    }
    return undefined;
  }
  if (obj.kind === "plugin") {
    const { category, id, version } = obj;
    if (
      typeof category === "string" &&
      typeof id === "string" &&
      typeof version === "string" &&
      category.length > 0 &&
      id.length > 0 &&
      version.length > 0
    ) {
      return { kind: "plugin", category, id, version };
    }
    return undefined;
  }
  return undefined;
}

/**
 * Quick-filter for the palette search box: keeps a plugin when the trimmed,
 * lower-cased query is a subsequence-free substring of its name, category, id,
 * or `id@version`. Empty / whitespace query keeps everything. Pure and
 * case-insensitive.
 */
export function pluginMatchesFilter(p: PluginInfo, query: string): boolean {
  const q = (query ?? "").trim().toLowerCase();
  if (q === "") return true;
  const haystack = [
    p.name ?? "",
    p.category ?? "",
    p.id ?? "",
    `${p.id ?? ""}@${p.version ?? ""}`,
    p.ui?.paletteGroup ?? ""
  ]
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((term) => haystack.includes(term));
}

/** Filter then group: returns only groups that still have at least one item. */
export function filterAndGroupPalette(
  plugins: PluginInfo[],
  query: string
): PaletteGroup[] {
  const kept = (plugins ?? []).filter((p) => pluginMatchesFilter(p, query));
  return groupPalette(kept);
}
