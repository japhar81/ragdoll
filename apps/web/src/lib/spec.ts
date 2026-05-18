/**
 * Pure conversion between the RAGdoll PipelineSpec and a React Flow graph,
 * plus `${config.*}` / `${secret.*}` template extraction.
 *
 * Nothing here imports React or the DOM, so it is unit-testable with
 * `node --test` and zero install.
 */
import type {
  FlowEdge,
  FlowNode,
  PipelineEdge,
  PipelineNode,
  PipelineSpec,
  PluginCategory,
  PluginRef
} from "./types.ts";

export const PLUGIN_CATEGORIES: PluginCategory[] = [
  "datasource",
  "loader",
  "parser",
  "chunker",
  "embedder",
  "vector_store",
  "retriever",
  "reranker",
  "llm",
  "prompt_template",
  "tool",
  "guardrail",
  "evaluator",
  "output_parser",
  "transformer",
  "router",
  "memory",
  "sink"
];

/**
 * The default plugin ref per category so a freshly dropped node validates
 * against the bundled plugin registry and renders a schema-driven form (not a
 * raw-JSON fallback). Every category maps to a plugin id that is really
 * registered by the plugin-loader (builtin-rag + sample-text), at v1.0.0.
 */
const DEFAULT_PLUGIN: Record<PluginCategory, PluginRef> = {
  datasource: { category: "datasource", id: "manual_text_input", version: "1.0.0" },
  loader: { category: "loader", id: "text_document_loader", version: "1.0.0" },
  parser: { category: "parser", id: "text_parser", version: "1.0.0" },
  chunker: { category: "chunker", id: "basic_text_chunker", version: "1.0.0" },
  embedder: { category: "embedder", id: "provider_embeddings", version: "1.0.0" },
  vector_store: { category: "vector_store", id: "qdrant_vector_store", version: "1.0.0" },
  retriever: { category: "retriever", id: "qdrant_retriever", version: "1.0.0" },
  reranker: { category: "reranker", id: "score_reranker", version: "1.0.0" },
  llm: { category: "llm", id: "provider_chat", version: "1.0.0" },
  prompt_template: { category: "prompt_template", id: "basic_rag_prompt", version: "1.0.0" },
  tool: { category: "tool", id: "static_value_tool", version: "1.0.0" },
  guardrail: { category: "guardrail", id: "simple_keyword_guardrail", version: "1.0.0" },
  evaluator: { category: "evaluator", id: "simple_evaluator_stub", version: "1.0.0" },
  output_parser: { category: "output_parser", id: "json_output_parser", version: "1.0.0" },
  transformer: { category: "transformer", id: "sample_uppercase_transformer", version: "1.0.0" },
  router: { category: "router", id: "field_router", version: "1.0.0" },
  memory: { category: "memory", id: "buffer_memory", version: "1.0.0" },
  sink: { category: "sink", id: "vector_upsert", version: "1.0.0" }
};

export function defaultPluginRef(category: PluginCategory): PluginRef {
  return DEFAULT_PLUGIN[category] ?? { category, id: `${category}_default`, version: "1.0.0" };
}

/**
 * Annotation key under which the editor stores the React Flow viewport
 * (pan x/y + zoom). This lives in `spec.metadata.annotations` — a free-form
 * string map the pipeline-spec validator IGNORES, so it round-trips through
 * Save/load without touching the executable DAG or the API/core contract.
 * Node X/Y positions are persisted separately on `node.ui.position`.
 */
export const VIEWPORT_ANNOTATION = "ragdoll.ui/viewport";

/** Serialize a React Flow viewport to the annotation string (JSON). */
export function encodeViewport(vp: { x: number; y: number; zoom: number }): string {
  return JSON.stringify({ x: vp.x, y: vp.y, zoom: vp.zoom });
}

/**
 * Read & parse the stored viewport from `spec.metadata.annotations`. Tolerant:
 * a missing annotation, non-JSON garbage, or a value missing numeric x/y/zoom
 * all yield `undefined` so callers fall back to the default fitView behavior.
 */
export function decodeViewport(
  spec: PipelineSpec
): { x: number; y: number; zoom: number } | undefined {
  const raw = spec.metadata?.annotations?.[VIEWPORT_ANNOTATION];
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const { x, y, zoom } = parsed as Record<string, unknown>;
    if (typeof x !== "number" || typeof y !== "number" || typeof zoom !== "number") {
      return undefined;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) {
      return undefined;
    }
    return { x, y, zoom };
  } catch {
    return undefined;
  }
}

/**
 * Immutably set the viewport annotation on a spec. When `vp` is undefined the
 * spec is returned unchanged (no annotations key is invented). The server
 * tolerates this annotation — it is editor UI state, not part of the DAG.
 */
export function withViewportAnnotation(
  spec: PipelineSpec,
  vp: { x: number; y: number; zoom: number } | undefined
): PipelineSpec {
  if (!vp) return spec;
  return {
    ...spec,
    metadata: {
      ...spec.metadata,
      annotations: {
        ...(spec.metadata.annotations ?? {}),
        [VIEWPORT_ANNOTATION]: encodeViewport(vp)
      }
    }
  };
}

function nodeLabel(node: PipelineNode): string {
  if (node.type === "input") return "Input";
  if (node.type === "output") return "Output";
  if (node.plugin) return `${node.plugin.category}: ${node.plugin.id}`;
  return node.id;
}

/** Map a PipelineNode to a React Flow node type (input/output/default). */
function flowTypeFor(node: PipelineNode): string | undefined {
  if (node.type === "input") return "input";
  if (node.type === "output") return "output";
  return undefined;
}

/**
 * Convert a PipelineSpec into React Flow nodes/edges. Existing positions are
 * read from `node.ui.position` if present, otherwise laid out left-to-right.
 */
export function specToGraph(spec: PipelineSpec): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = (spec.spec?.nodes ?? []).map((node, index) => {
    const ui = node.ui as { position?: { x: number; y: number } } | undefined;
    const position = ui?.position ?? { x: 40 + index * 240, y: 140 };
    return {
      id: node.id,
      type: flowTypeFor(node),
      position,
      data: { label: nodeLabel(node), node }
    };
  });
  const edges: FlowEdge[] = (spec.spec?.edges ?? []).map((edge) => ({
    id: `${edge.from}->${edge.to}${edge.fromPort ? `:${edge.fromPort}` : ""}`,
    source: edge.from,
    target: edge.to,
    sourceHandle: edge.fromPort ?? null,
    targetHandle: edge.toPort ?? null
  }));
  return { nodes, edges };
}

/**
 * Convert a React Flow graph back into a PipelineSpec. Node positions are
 * persisted under `node.ui.position` so a round-trip preserves layout.
 *
 * `metadata.labels` and `metadata.annotations` (when passed in) are PRESERVED,
 * not dropped — `annotations` is where the editor stores UI state such as the
 * viewport (see VIEWPORT_ANNOTATION), which the server tolerates and ignores.
 */
export function graphToSpec(
  nodes: FlowNode[],
  edges: FlowEdge[],
  metadata: {
    name: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  }
): PipelineSpec {
  const specNodes: PipelineNode[] = nodes.map((flowNode) => {
    const node = flowNode.data.node;
    return {
      ...node,
      id: flowNode.id,
      ui: { ...(node.ui ?? {}), position: flowNode.position }
    };
  });
  const specEdges: PipelineEdge[] = edges.map((edge) => {
    const result: PipelineEdge = { from: edge.source, to: edge.target };
    if (edge.sourceHandle) result.fromPort = edge.sourceHandle;
    if (edge.targetHandle) result.toPort = edge.targetHandle;
    return result;
  });
  return {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: {
      name: metadata.name,
      ...(metadata.labels ? { labels: metadata.labels } : {}),
      ...(metadata.annotations ? { annotations: metadata.annotations } : {})
    },
    spec: { nodes: specNodes, edges: specEdges }
  };
}

/** Build a new PipelineNode for a freshly added palette category. */
export function newNodeForCategory(category: PluginCategory, id: string): PipelineNode {
  return { id, plugin: defaultPluginRef(category), config: {} };
}

export function newIoNode(kind: "input" | "output", id: string): PipelineNode {
  return { id, type: kind };
}

/**
 * Extract every `${config.<path>}` reference found anywhere in the spec's node
 * config/secrets, de-duplicated and sorted. Mirrors the server's collectRefs.
 */
export function extractConfigRefs(spec: PipelineSpec): string[] {
  const found = new Set<string>();
  for (const node of spec.spec?.nodes ?? []) {
    const blob = JSON.stringify({ config: node.config ?? {}, secrets: node.secrets ?? {} });
    for (const match of blob.matchAll(/\$\{config\.([^}]+)\}/g)) found.add(match[1]);
  }
  return [...found].sort();
}

/** Extract every `${secret.<path>}` template reference, de-duplicated/sorted. */
export function extractSecretRefs(spec: PipelineSpec): string[] {
  const found = new Set<string>();
  for (const node of spec.spec?.nodes ?? []) {
    const blob = JSON.stringify({ config: node.config ?? {}, secrets: node.secrets ?? {} });
    for (const match of blob.matchAll(/\$\{secret\.([^}]+)\}/g)) found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * Structured secret refs declared on nodes (the `node.secrets` map). Returns
 * one entry per declared secret with its logical key.
 */
export function extractDeclaredSecrets(
  spec: PipelineSpec
): Array<{ nodeId: string; name: string; key: string; scope: string }> {
  const out: Array<{ nodeId: string; name: string; key: string; scope: string }> = [];
  for (const node of spec.spec?.nodes ?? []) {
    for (const [name, ref] of Object.entries(node.secrets ?? {})) {
      out.push({ nodeId: node.id, name, key: ref.key, scope: ref.scope });
    }
  }
  return out;
}

/**
 * Substitute `${config.*}` / `${secret.*}` placeholders in a spec using a flat
 * lookup map (e.g. the values from GET /api/config/resolved). Used by the live
 * Resolved Config preview. Secret values are expected to already be REDACTED by
 * the server; this only does string replacement.
 */
export function applyResolved(
  spec: PipelineSpec,
  configValues: Record<string, unknown>
): PipelineSpec {
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") {
      const direct = value.match(/^\$\{config\.([^}]+)\}$/);
      if (direct && direct[1] in configValues) return configValues[direct[1]];
      return value.replace(/\$\{config\.([^}]+)\}/g, (whole, path: string) =>
        path in configValues ? String(configValues[path]) : whole
      );
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") {
      const next: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) next[k] = replace(v);
      return next;
    }
    return value;
  };
  return {
    ...spec,
    spec: {
      ...spec.spec,
      nodes: spec.spec.nodes.map((node) => ({
        ...node,
        config: replace(node.config ?? {}) as Record<string, unknown>
      }))
    }
  };
}
