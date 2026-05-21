/**
 * Pure, DOM-free builder helpers: palette drag payload, node theming,
 * connection validation and the inspector-width clamp. Kept import-free of
 * React/reactflow so it is unit-testable with `node --test`, zero install.
 */
import type { PipelineNode, PluginCategory } from "./types.ts";

/** dataTransfer MIME used when dragging a palette entry onto the canvas. */
export const DND_MIME = "application/ragdoll-node";

export type NodeKind = "input" | "output" | "plugin";
export type StyleKey = PluginCategory | "input" | "output";

export function nodeKind(node: Pick<PipelineNode, "type">): NodeKind {
  if (node.type === "input") return "input";
  if (node.type === "output") return "output";
  return "plugin";
}

export interface NodeTheme {
  color: string;
  icon: string;
}

const THEME: Record<StyleKey, NodeTheme> = {
  input: { color: "#16a34a", icon: "\u{1F4E5}" },
  output: { color: "#dc2626", icon: "\u{1F4E4}" },
  datasource: { color: "#0ea5e9", icon: "\u{1F50C}" },
  loader: { color: "#0ea5e9", icon: "\u{1F4C2}" },
  parser: { color: "#0891b2", icon: "\u{1F527}" },
  chunker: { color: "#f59e0b", icon: "✂️" },
  embedder: { color: "#7c3aed", icon: "\u{1F9EC}" },
  vector_store: { color: "#2563eb", icon: "\u{1F5C3}️" },
  retriever: { color: "#2563eb", icon: "\u{1F50E}" },
  reranker: { color: "#4f46e5", icon: "\u{1F4CA}" },
  llm: { color: "#9333ea", icon: "\u{1F9E0}" },
  prompt_template: { color: "#6366f1", icon: "\u{1F4DD}" },
  tool: { color: "#0d9488", icon: "\u{1F6E0}️" },
  guardrail: { color: "#e11d48", icon: "\u{1F6E1}️" },
  evaluator: { color: "#0d9488", icon: "✅" },
  output_parser: { color: "#64748b", icon: "\u{1F9E9}" },
  transformer: { color: "#64748b", icon: "\u{1F501}" },
  router: { color: "#ea580c", icon: "\u{1F500}" },
  memory: { color: "#a16207", icon: "\u{1F4BE}" },
  sink: { color: "#475569", icon: "\u{1FAA3}" }
};

const FALLBACK: NodeTheme = { color: "#64748b", icon: "\u{1F4E6}" };

export function styleKeyFor(node: PipelineNode): StyleKey {
  const kind = nodeKind(node);
  if (kind !== "plugin") return kind;
  return (node.plugin?.category as StyleKey) ?? "transformer";
}

export function nodeTheme(key: StyleKey): NodeTheme {
  return THEME[key] ?? FALLBACK;
}

/**
 * Whether a proposed connection is allowed. Rejects: missing endpoints,
 * self-loops, duplicates, wiring into an `input`, wiring out of an `output`,
 * and any edge that would create a cycle.
 */
export function validateConnection(
  conn: { source?: string | null; target?: string | null },
  kinds: Map<string, NodeKind>,
  edges: Array<{ source: string; target: string }>
): boolean {
  const { source, target } = conn;
  if (!source || !target) return false;
  if (source === target) return false;
  if (!kinds.has(source) || !kinds.has(target)) return false;
  if (edges.some((e) => e.source === source && e.target === target)) return false;
  if (kinds.get(target) === "input") return false;
  if (kinds.get(source) === "output") return false;

  // Reject if `target` can already reach `source` (adding source->target
  // would close a cycle).
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.source) ?? [];
    list.push(e.target);
    adj.set(e.source, list);
  }
  const seen = new Set<string>();
  const stack = [target];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === source) return false;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of adj.get(cur) ?? []) stack.push(next);
  }
  return true;
}

/** Clamp the draggable inspector width to a sane range for the viewport. */
export function clampInspectorWidth(px: number, viewportWidth: number): number {
  const min = 280;
  const max = Math.max(min, Math.min(760, viewportWidth - 420));
  return Math.round(Math.min(max, Math.max(min, px)));
}

/**
 * Clamp the draggable palette width to a sane range. The palette holds
 * compact plugin chips so it can be narrower than the inspector; the
 * ceiling stays below half a typical viewport so the canvas always has
 * room. `viewportWidth` is the host window's `innerWidth`, used only to
 * cap on very small displays.
 */
export function clampPaletteWidth(px: number, viewportWidth: number): number {
  const min = 160;
  const max = Math.max(min, Math.min(480, viewportWidth - 480));
  return Math.round(Math.min(max, Math.max(min, px)));
}
