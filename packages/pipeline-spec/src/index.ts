import type { PipelineSpec, PipelineNode, PluginRef } from "../../core/src/index.ts";
import { pluginKey, type PluginRegistry } from "../../plugin-sdk/src/index.ts";

export * from "./yaml.ts";
export * from "./lifecycle.ts";

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
  for (const edge of spec.spec?.edges ?? []) {
    if (!nodeIds.has(edge.from)) issues.push({ level: "error", code: "missing_edge_source", message: `edge source ${edge.from} does not exist`, edge });
    if (!nodeIds.has(edge.to)) issues.push({ level: "error", code: "missing_edge_target", message: `edge target ${edge.to} does not exist`, edge });
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
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
