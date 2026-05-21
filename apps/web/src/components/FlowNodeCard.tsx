import React, { createContext, useContext } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import type { PipelineNode } from "../lib/types.ts";
import type { PluginInfo, PortInfo } from "../lib/api.ts";
import { nodeKind, nodeTheme, styleKeyFor } from "../lib/graph.ts";

export interface RagNodeData {
  label: string;
  node: PipelineNode;
}

/**
 * Provides plugin manifests to every FlowNodeCard so the card can render one
 * handle per declared input/output port. The provider lives at the builder
 * level; cards look up `node.plugin` to find their own ports. Plugins without
 * declared ports keep the single-handle layout.
 */
export const PluginManifestContext = createContext<Map<string, PluginInfo>>(new Map());

/**
 * Per-node validation buckets sourced from the builder's real-time
 * validatePipelineSpec run. Cards consult this to overlay a yellow ⚠ or
 * red ✕ corner badge with the relevant messages on hover. Empty map = no
 * validation surface (loading, or spec is clean).
 */
export interface NodeValidationBuckets {
  errors: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
}
export const NodeValidationContext = createContext<Map<string, NodeValidationBuckets>>(new Map());

function manifestKey(plugin: { category: string; id: string; version: string }): string {
  return `${plugin.category}:${plugin.id}:${plugin.version}`;
}

/**
 * Vertical handle distribution. With N ports we lay them out evenly inside
 * a 40% band centered on the card — half the original 80% spread so pins
 * sit closer together rather than spanning corner-to-corner.
 */
function portTop(index: number, total: number): string {
  if (total <= 1) return "50%";
  const top = 30 + (index * 40) / (total - 1);
  return `${top}%`;
}

function PortHandles({
  type,
  ports,
  position
}: {
  type: "source" | "target";
  ports: PortInfo[];
  position: Position;
}): React.ReactElement {
  return (
    <>
      {ports.map((port, idx) => (
        <Handle
          key={`${type}-${port.name}`}
          type={type}
          position={position}
          id={port.name}
          className={`rf-handle rf-handle-port${port.required ? " required" : ""}`}
          style={{ top: portTop(idx, ports.length) }}
          title={port.description ? `${port.name} — ${port.description}` : port.name}
        >
          {/* React Flow swallows children inside Handle in its current impl;
              the label is a sibling positioned via CSS in styles.css. */}
        </Handle>
      ))}
    </>
  );
}

function PortLabels({ ports, side }: { ports: PortInfo[]; side: "left" | "right" }): React.ReactElement {
  return (
    <div className={`rf-port-labels rf-port-labels-${side}`}>
      {ports.map((port, idx) => (
        <span
          key={`${side}-${port.name}`}
          className="rf-port-label"
          style={{ top: portTop(idx, ports.length) }}
        >
          {port.name}
        </span>
      ))}
    </div>
  );
}

/**
 * Synthetic "fallback" ports we render when a node has no declared
 * inputPorts/outputPorts. Framework `type: input`/`output` nodes get a
 * single labeled port too — "data" / "result" — so the canvas never has an
 * unlabelled handle. Datasources (which produce but don't consume) and sinks
 * (which consume but don't produce) get a default name on their missing side
 * so authors always see what they're wiring to.
 */
const FALLBACK_IN: PortInfo = { name: "in", description: "Default input — receives the upstream payload." };
const FALLBACK_OUT: PortInfo = { name: "out", description: "Default output — forwards the plugin's output bag." };
const FRAMEWORK_INPUT_OUT: PortInfo = { name: "data", description: "Pipeline runtime input forwarded into the DAG." };
const FRAMEWORK_OUTPUT_IN: PortInfo = { name: "result", description: "Final value delivered to the pipeline caller." };

/**
 * Colored, icon-bearing custom React Flow node. Resolves the effective input
 * and output port lists for the node (declared manifest ports first, falling
 * back to synthetic single-pin labels) so every visible handle has a name.
 */
function FlowNodeCardImpl({ data, selected }: NodeProps<RagNodeData>) {
  const node = data.node;
  const kind = nodeKind(node);
  const theme = nodeTheme(styleKeyFor(node));
  const manifests = useContext(PluginManifestContext);
  const manifest = node.plugin ? manifests.get(manifestKey(node.plugin)) : undefined;
  const validation = useContext(NodeValidationContext).get(node.id);
  // Errors win over warnings — a node with both shows the red ✕ and lists
  // every issue in the tooltip.
  const badgeSeverity: "error" | "warning" | undefined = validation?.errors.length
    ? "error"
    : validation?.warnings.length
    ? "warning"
    : undefined;
  const badgeTooltip = validation
    ? [...validation.errors, ...validation.warnings].map((i) => `• ${i.message}`).join("\n")
    : undefined;

  // Resolve effective ports for THIS node, layered:
  //   1. Framework `type: input` / `output` nodes get their canonical single
  //      synthetic port (no inputs for input, no outputs for output).
  //   2. Declared manifest ports win.
  //   3. Otherwise a synthetic "in"/"out" label fills the default handle.
  let inputPorts: PortInfo[] = [];
  let outputPorts: PortInfo[] = [];
  if (kind === "input") {
    outputPorts = [FRAMEWORK_INPUT_OUT];
  } else if (kind === "output") {
    inputPorts = [FRAMEWORK_OUTPUT_IN];
  } else {
    inputPorts = manifest?.inputPorts && manifest.inputPorts.length > 0 ? manifest.inputPorts : [FALLBACK_IN];
    outputPorts = manifest?.outputPorts && manifest.outputPorts.length > 0 ? manifest.outputPorts : [FALLBACK_OUT];
  }

  // Scale the card height with the per-side port count so a single-port node
  // (like the framework input/output cards) doesn't get the same vertical
  // padding as a three-port node. 12px per port + 24px chrome, floor 48px —
  // halved from the original 24px-per-port to tighten the pin stack.
  const maxPorts = Math.max(inputPorts.length, outputPorts.length);
  const minHeight = Math.max(48, maxPorts * 12 + 24);
  const sideClasses = [
    inputPorts.length > 0 ? "has-left-ports" : "",
    outputPorts.length > 0 ? "has-right-ports" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={`rf-node has-ports${selected ? " selected" : ""}${sideClasses ? ` ${sideClasses}` : ""}`}
      style={{ borderColor: theme.color, minHeight }}
    >
      {inputPorts.length > 0 && <PortHandles type="target" ports={inputPorts} position={Position.Left} />}
      {inputPorts.length > 0 && <PortLabels ports={inputPorts} side="left" />}
      <span className="rf-ico" style={{ background: theme.color }}>
        {theme.icon}
      </span>
      <div className="rf-body">
        <div className="rf-title">{data.label}</div>
        {node.plugin && (
          <div className="rf-sub">
            {node.plugin.id}@{node.plugin.version}
          </div>
        )}
        {node.type && <div className="rf-sub">{node.type}</div>}
      </div>
      {outputPorts.length > 0 && <PortHandles type="source" ports={outputPorts} position={Position.Right} />}
      {outputPorts.length > 0 && <PortLabels ports={outputPorts} side="right" />}
      {badgeSeverity && (
        <span
          className={`rf-validation-badge rf-validation-${badgeSeverity}`}
          title={badgeTooltip}
          aria-label={`${badgeSeverity}: ${validation?.errors.length ?? 0} error(s), ${validation?.warnings.length ?? 0} warning(s)`}
        >
          {badgeSeverity === "error" ? "✕" : "⚠"}
        </span>
      )}
    </div>
  );
}

export const FlowNodeCard = React.memo(FlowNodeCardImpl);
export default FlowNodeCard;
