import type { PipelineSpec, PipelineNode, PluginRef } from "../../core/src/index.ts";
import { pluginKey, type PluginRegistry } from "../../plugin-sdk/src/index.ts";
import { applyLayout } from "./layouts.ts";

export * from "./yaml.ts";
export * from "./lifecycle.ts";
export * from "./layouts.ts";

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

export interface ValidationIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
  edge?: { from: string; to: string };
}

export interface PipelineValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  requiredSecrets: string[];
  requiredConfig: string[];
  missingPlugins: PluginRef[];
}

export function validatePipelineSpec(spec: PipelineSpec, registry?: PluginRegistry): PipelineValidationResult {
  const issues: ValidationIssue[] = [];
  const requiredSecrets = new Set<string>();
  const requiredConfig = new Set<string>();
  const missingPlugins: PluginRef[] = [];

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
    missingPlugins
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
