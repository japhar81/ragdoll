/**
 * Tiny shared helpers used by every Builder view tab (Tree, Stages, Cards,
 * Outline). Keeps the per-node icon / label lookups in one place so the
 * four views read the same and don't duplicate fragile inline maps.
 *
 * Pure / DOM-free, unit-testable.
 */
import type { Node } from "reactflow";
import type { PluginInfo } from "./api.ts";

interface NodeLike {
  type?: string;
  plugin?: { category?: string; id?: string; version?: string };
  ui?: { label?: string };
}

/** Plugin / type label for a React Flow node — the secondary text under
 *  the friendly display name (e.g. "filesystem_source"). IO nodes get
 *  "input" / "output"; an unconfigured plugin shows "(unconfigured)". */
export function nodeLabel(flow: Node | undefined): string {
  const pn = (flow?.data as { node?: NodeLike } | undefined)?.node;
  if (!pn) return "";
  if (pn.type === "input") return "input";
  if (pn.type === "output") return "output";
  return pn.plugin?.id ?? "(unconfigured)";
}

/** Friendly display name — the user-set alias from `ui.label`, or the
 *  strict node id when no alias is set. The Tree View shows this as the
 *  primary text on a row so a long pipeline reads "Docs Source" instead
 *  of hunting for "fs_docs". */
export function nodeDisplay(flow: Node | undefined): string {
  const pn = (flow?.data as { node?: NodeLike } | undefined)?.node;
  if (!pn) return flow?.id ?? "";
  const label = pn.ui?.label;
  if (typeof label === "string" && label.trim().length > 0) {
    return label.trim();
  }
  return flow?.id ?? "";
}

/** Single-character mnemonic icon per plugin category. Purely cosmetic;
 *  falls back to a bullet for unknown categories. */
export function nodeIcon(flow: Node | undefined): string {
  const pn = (flow?.data as { node?: NodeLike } | undefined)?.node;
  if (!pn) return "•";
  if (pn.type === "input") return "▶";
  if (pn.type === "output") return "■";
  const cat = pn.plugin?.category ?? "";
  const map: Record<string, string> = {
    datasource: "📥",
    transformer: "🔀",
    chunker: "📃",
    embedder: "🧬",
    vector_store: "🗄",
    retriever: "🔍",
    prompt_template: "📝",
    llm: "🤖",
    reranker: "🎯",
    sink: "📤",
    output_parser: "🧩",
    parser: "🧩",
    loader: "📄",
    tool: "🛠",
    router: "🔁",
    control: "🔁",
    memory: "🧠",
    guardrail: "🛡",
    evaluator: "✅"
  };
  return map[cat] ?? "•";
}

/** Lookup the static input/output port lists declared on a node's plugin
 *  manifest. I/O nodes have a synthetic single port each; plugin nodes
 *  return whatever the manifest says (possibly empty for dynamic ports). */
export function portsFor(
  flowNode: Node | undefined,
  manifestMap: Map<string, PluginInfo>
): { inputs: string[]; outputs: string[] } {
  const pn = (flowNode?.data as { node?: NodeLike } | undefined)?.node;
  if (!pn) return { inputs: [], outputs: [] };
  if (pn.type === "input") return { inputs: [], outputs: ["output"] };
  if (pn.type === "output") return { inputs: ["input"], outputs: [] };
  const ref = pn.plugin;
  if (!ref?.category || !ref.id || !ref.version) {
    return { inputs: [], outputs: [] };
  }
  const m = manifestMap.get(`${ref.category}:${ref.id}:${ref.version}`);
  return {
    inputs: (m?.inputPorts ?? []).map((p) => p.name),
    outputs: (m?.outputPorts ?? []).map((p) => p.name)
  };
}
