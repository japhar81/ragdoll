import type {
  PipelineSpec,
  PipelineNode,
  PluginCategory,
  PluginRef
} from "../../core/src/index.ts";
import { pluginKey, type PluginRegistry } from "../../plugin-sdk/src/index.ts";
import { applyLayout } from "./layouts.ts";
import { projectStages } from "./stagesProjection.ts";

export * from "./yaml.ts";
export * from "./lifecycle.ts";
export * from "./layouts.ts";
export * from "./stagesProjection.ts";

/**
 * Categories whose plugins touch a backend collection / index — the ones a
 * Dataset reference is meaningful for. A node with one of these categories
 * MUST carry `node.dataset = { slug, ... }` so the runtime can resolve the
 * scoped backend collection at execute time.
 *
 * Exposed from pipeline-spec so the validator and the Builder UI agree on
 * which nodes are "storage-touching".
 */
export const STORAGE_CATEGORIES: ReadonlySet<PluginCategory> = new Set<PluginCategory>([
  "vector_store",
  "retriever",
  "sink",
  "loader"
]);

export function isStorageCategory(category: string | undefined): boolean {
  return !!category && STORAGE_CATEGORIES.has(category as PluginCategory);
}

/**
 * Apply a left-to-right Sugiyama layout to a pipeline spec, writing
 * `ui.position` on every node that lacks one. Nodes that already have a
 * position are left untouched so a user's saved layout survives. Pure:
 * returns a new spec, never mutates the input.
 *
 * Used by:
 *  - the API SAVE path so a spec authored without positions (CLI, MCP,
 *    a hand-written YAML) lands in storage with positions baked in;
 *  - the web Builder's `specToGraph` as a defensive fallback for older
 *    seeded specs that never went through the API SAVE path.
 */
export function autoLayoutSpec(spec: PipelineSpec): PipelineSpec {
  const nodes = spec.spec?.nodes ?? [];
  const edges = spec.spec?.edges ?? [];
  if (nodes.length === 0) return spec;
  // If every node already carries a position, return the input untouched
  // so callers can rely on this function as a no-op when not needed.
  const allHavePositions = nodes.every((n: PipelineNode) => {
    const ui = n.ui as { position?: { x?: unknown; y?: unknown } } | undefined;
    const pos = ui?.position;
    return (
      pos !== undefined &&
      typeof (pos as { x?: unknown }).x === "number" &&
      typeof (pos as { y?: unknown }).y === "number"
    );
  });
  if (allHavePositions) return spec;
  const layoutNodes = nodes.map((n: PipelineNode) => {
    const ui = n.ui as { position?: { x: number; y: number } } | undefined;
    return { id: n.id, position: ui?.position };
  });
  const layoutEdges = edges.map((e) => ({ from: e.from, to: e.to }));
  const positions = applyLayout("layered-LR", layoutNodes, layoutEdges);
  const nextNodes: PipelineNode[] = nodes.map((n: PipelineNode) => {
    // Preserve any explicitly-set position so a partial spec (some nodes
    // positioned, some not) doesn't lose the user's chosen layout. Only
    // fill in the gaps.
    const existing = (n.ui as { position?: { x?: unknown; y?: unknown } } | undefined)
      ?.position;
    if (
      existing &&
      typeof (existing as { x?: unknown }).x === "number" &&
      typeof (existing as { y?: unknown }).y === "number"
    ) {
      return n;
    }
    const placed = positions.get(n.id);
    if (!placed) return n;
    return {
      ...n,
      ui: {
        ...(n.ui ?? {}),
        position: { x: placed.x, y: placed.y }
      }
    };
  });
  return {
    ...spec,
    spec: { ...(spec.spec ?? { nodes: [], edges: [] }), nodes: nextNodes, edges }
  };
}

/**
 * Apply topological-layer staging to a pipeline spec. No-op when the
 * spec already carries `metadata.stages`; otherwise builds one stage
 * per layer (sources at "Stage 1", convergence rows at the end) and
 * writes `ui.stageId` on every node so the Builder Tree groups them
 * and the Flow View renders containers around them. Pure: returns a
 * new spec, never mutates the input.
 *
 * Used by the one-off DB / seed / example migration scripts so every
 * pre-populated pipeline boots with sensible stage sections. NOT
 * applied on the API save path — new pipelines may intentionally
 * carry their own (or no) stages.
 */
export function autoStageSpec(spec: PipelineSpec): PipelineSpec {
  const existing = (spec.metadata as { stages?: unknown } | undefined)?.stages;
  if (Array.isArray(existing) && existing.length > 0) return spec;
  const nodes = spec.spec?.nodes ?? [];
  const edges = spec.spec?.edges ?? [];
  if (nodes.length === 0) return spec;
  const projection = projectStages(
    nodes.map((n) => n.id),
    edges.map((e) => ({ source: e.from, target: e.to }))
  );
  if (projection.stages.length === 0) return spec;
  // Stable, deterministic stage ids (no Math.random) so re-running
  // the migration on the same input produces identical output —
  // matters for idempotent migrations + checksum stability.
  const stages = projection.stages.map((s, i) => ({
    id: `s_auto_${i + 1}`,
    label: `Stage ${i + 1}`
  }));
  const stageByNode = new Map<string, string>();
  projection.stages.forEach((stage, i) => {
    for (const nid of stage.nodeIds) stageByNode.set(nid, stages[i].id);
  });
  const nextNodes: PipelineNode[] = nodes.map((n: PipelineNode) => {
    const stageId = stageByNode.get(n.id);
    if (!stageId) return n;
    return {
      ...n,
      ui: { ...(n.ui ?? {}), stageId }
    };
  });
  return {
    ...spec,
    metadata: { ...spec.metadata, stages },
    spec: { ...(spec.spec ?? { nodes: [], edges: [] }), nodes: nextNodes, edges }
  };
}

export interface ValidationIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
  edge?: { from: string; to: string };
}

export interface DatasetSlotRef {
  nodeId: string;
  slug: string;
  alias: string;
}

export interface PipelineValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  requiredSecrets: string[];
  requiredConfig: string[];
  missingPlugins: PluginRef[];
  /** Every node currently binding a dataset slug (storage-touching nodes
   *  with a `node.dataset.slug`). Drives the Deploy modal: each entry is
   *  one "slot" the operator must resolve to a concrete dataset for the
   *  target (tenant, env). */
  datasetSlots: DatasetSlotRef[];
}

/**
 * Optional slug → modalities map injected by the Builder. The validator uses
 * this to check that a node bound to a slug has all the modalities the
 * plugin requires (e.g. opensearch_delete pinned to a vector-only dataset).
 * When omitted, modality mismatches go silently — the worker re-validates
 * at execute time with the real dataset rows.
 */
export type DatasetModalityIndex = (slug: string) => string[] | undefined;

export function validatePipelineSpec(
  spec: PipelineSpec,
  registry?: PluginRegistry,
  datasetModalityIndex?: DatasetModalityIndex
): PipelineValidationResult {
  const issues: ValidationIssue[] = [];
  const requiredSecrets = new Set<string>();
  const requiredConfig = new Set<string>();
  const missingPlugins: PluginRef[] = [];
  const datasetSlots: DatasetSlotRef[] = [];

  if (spec.apiVersion !== "rag-platform/v1") {
    issues.push({ level: "error", code: "invalid_api_version", message: "apiVersion must be rag-platform/v1" });
  }
  if (spec.kind !== "Pipeline") {
    issues.push({ level: "error", code: "invalid_kind", message: "kind must be Pipeline" });
  }
  if (!spec.metadata?.name) {
    issues.push({ level: "error", code: "missing_name", message: "metadata.name is required" });
  }

  const nodeIds = new Set<string>();
  for (const node of spec.spec?.nodes ?? []) {
    if (nodeIds.has(node.id)) issues.push({ level: "error", code: "duplicate_node", message: `duplicate node id ${node.id}`, nodeId: node.id });
    nodeIds.add(node.id);
    if (!node.type && !node.plugin) {
      issues.push({ level: "error", code: "missing_plugin", message: "node must have a type or plugin", nodeId: node.id });
    }
    if (node.plugin && registry && !registry.get(node.plugin)) {
      missingPlugins.push(node.plugin);
      issues.push({ level: "error", code: "missing_plugin_ref", message: `plugin ${pluginKey(node.plugin)} is not registered`, nodeId: node.id });
    }
    // Storage-touching nodes (vector_store / retriever / sink / loader) MUST
    // pin a dataset slug. The runtime resolves the (tenant, env)-scoped
    // dataset at execute time; without a slug the worker has nowhere to read
    // / write. Pipelines that fail this check can still SAVE — operators may
    // want to stash a draft — but Run / Publish / Deploy are blocked.
    const dataset = node.dataset as { slug?: string; alias?: string } | undefined;
    // Storage-touching nodes only need a dataset binding when the plugin
    // declares contract v2 (the dataset-aware contract). Legacy v1 plugins
    // still name their own collection via `config.collection` / `config.index`
    // and don't need a Dataset row — flagging them here would break every
    // pre-Dataset pipeline.
    if (node.plugin && isStorageCategory(node.plugin.category) && !dataset?.slug) {
      const manifest = registry?.get(node.plugin)?.manifest as
        | { contract?: number }
        | undefined;
      const contract = manifest?.contract ?? 1;
      if (contract >= 2) {
        issues.push({
          level: "error",
          code: "missing_required_dataset",
          message: `node "${node.id}" (${node.plugin.category}) needs a dataset binding — pick a slug in the Inspector`,
          nodeId: node.id
        });
      }
    }
    if (dataset?.slug) {
      datasetSlots.push({
        nodeId: node.id,
        slug: dataset.slug,
        alias: dataset.alias ?? "stable"
      });
      // Modality mismatch: if both the plugin AND the bound slug declare
      // their modalities, every one the plugin needs must be present on
      // the dataset. Reported as an error so the canvas badge lights up
      // and Run/Deploy are blocked the same way `missing_required_dataset`
      // does — operators don't get to ship a doomed wiring.
      if (node.plugin && datasetModalityIndex) {
        const manifest = registry?.get(node.plugin)?.manifest as
          | { datasetModalities?: string[] }
          | undefined;
        const required = manifest?.datasetModalities ?? [];
        if (required.length > 0) {
          const present = datasetModalityIndex(dataset.slug);
          if (present) {
            const missing = required.filter((m) => !present.includes(m));
            if (missing.length > 0) {
              issues.push({
                level: "error",
                code: "dataset_modality_mismatch",
                message: `node "${node.id}" needs the ${missing.join("/")} backend on dataset "${dataset.slug}" but it isn't declared — add it on the Datasets screen or pick a different slug`,
                nodeId: node.id
              });
            }
          }
        }
      }
    }
    collectRefs(node, requiredConfig, requiredSecrets);
  }

  const adjacency = new Map<string, string[]>();
  const nodeById = new Map(spec.spec?.nodes?.map((node) => [node.id, node]) ?? []);
  for (const edge of spec.spec?.edges ?? []) {
    if (!nodeIds.has(edge.from)) issues.push({ level: "error", code: "missing_edge_source", message: `edge source ${edge.from} does not exist`, edge });
    if (!nodeIds.has(edge.to)) issues.push({ level: "error", code: "missing_edge_target", message: `edge target ${edge.to} does not exist`, edge });
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);

    if (registry) {
      // Soft-validate port names against the upstream/downstream plugin
      // manifests when both ends have a plugin reference. Unknown ports become
      // warnings (not errors) so legacy plugins without declared ports keep
      // validating cleanly and so iteration body specs can edit independently.
      const fromNode = nodeById.get(edge.from);
      if (edge.fromPort && fromNode?.plugin) {
        const manifest = registry.get(fromNode.plugin)?.manifest;
        if (manifest?.outputPorts && !manifest.outputPorts.some((port) => port.name === edge.fromPort)) {
          issues.push({
            level: "warning",
            code: "unknown_output_port",
            message: `edge.fromPort "${edge.fromPort}" is not declared by ${manifest.id} v${manifest.version}`,
            edge
          });
        }
      }
      const toNode = nodeById.get(edge.to);
      if (edge.toPort && toNode?.plugin) {
        const manifest = registry.get(toNode.plugin)?.manifest;
        if (manifest?.inputPorts && !manifest.inputPorts.some((port) => port.name === edge.toPort)) {
          issues.push({
            level: "warning",
            code: "unknown_input_port",
            message: `edge.toPort "${edge.toPort}" is not declared by ${manifest.id} v${manifest.version}`,
            edge
          });
        }
      }
    }
  }

  const cycle = findCycle(adjacency);
  if (cycle) {
    issues.push({ level: "error", code: "cycle_detected", message: `pipeline graph contains a cycle: ${cycle.join(" -> ")}` });
  }

  const inputCount = [...nodeIds].filter((id) => spec.spec.nodes.find((node) => node.id === id)?.type === "input").length;
  const outputCount = [...nodeIds].filter((id) => spec.spec.nodes.find((node) => node.id === id)?.type === "output").length;
  if (inputCount === 0) issues.push({ level: "warning", code: "no_input_node", message: "pipeline has no explicit input node" });
  if (outputCount === 0) issues.push({ level: "warning", code: "no_output_node", message: "pipeline has no explicit output node" });

  return {
    valid: issues.every((issue) => issue.level !== "error"),
    errors: issues.filter((issue) => issue.level === "error"),
    warnings: issues.filter((issue) => issue.level === "warning"),
    requiredSecrets: [...requiredSecrets],
    requiredConfig: [...requiredConfig],
    missingPlugins,
    datasetSlots
  };
}

function collectRefs(node: PipelineNode, requiredConfig: Set<string>, requiredSecrets: Set<string>): void {
  const values = JSON.stringify({ config: node.config ?? {}, secrets: node.secrets ?? {} });
  for (const match of values.matchAll(/\$\{config\.([^}]+)\}/g)) requiredConfig.add(match[1]);
  for (const match of values.matchAll(/\$\{secret\.([^}]+)\}/g)) requiredSecrets.add(match[1]);
}

function findCycle(adjacency: Map<string, string[]>): string[] | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function visit(node: string): string[] | undefined {
    if (visiting.has(node)) return [...stack.slice(stack.indexOf(node)), node];
    if (visited.has(node)) return undefined;
    visiting.add(node);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return undefined;
  }

  for (const node of adjacency.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return undefined;
}
