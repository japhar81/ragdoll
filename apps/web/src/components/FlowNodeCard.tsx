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

function manifestKey(plugin: { category: string; id: string; version: string }): string {
  return `${plugin.category}:${plugin.id}:${plugin.version}`;
}

/**
 * Vertical handle distribution. With N ports we lay them out evenly inside
 * the [10%, 90%] band so the topmost/bottommost ports don't sit on the rounded
 * corner of the node card.
 */
function portTop(index: number, total: number): string {
  if (total <= 1) return "50%";
  const top = 10 + (index * 80) / (total - 1);
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
 * Colored, icon-bearing custom React Flow node. Input/output framework nodes
 * keep their single-handle layout; plugins that declare inputPorts/outputPorts
 * render labelled handles down the corresponding edge of the card.
 */
function FlowNodeCardImpl({ data, selected }: NodeProps<RagNodeData>) {
  const node = data.node;
  const kind = nodeKind(node);
  const theme = nodeTheme(styleKeyFor(node));
  const manifests = useContext(PluginManifestContext);
  const manifest = node.plugin ? manifests.get(manifestKey(node.plugin)) : undefined;
  const inputPorts = manifest?.inputPorts ?? [];
  const outputPorts = manifest?.outputPorts ?? [];
  const hasInputPorts = inputPorts.length > 0;
  const hasOutputPorts = outputPorts.length > 0;
  return (
    <div
      className={`rf-node${selected ? " selected" : ""}${hasInputPorts || hasOutputPorts ? " has-ports" : ""}`}
      style={{ borderColor: theme.color }}
    >
      {kind !== "input" && !hasInputPorts && (
        <Handle type="target" position={Position.Left} className="rf-handle" />
      )}
      {hasInputPorts && <PortHandles type="target" ports={inputPorts} position={Position.Left} />}
      {hasInputPorts && <PortLabels ports={inputPorts} side="left" />}
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
      {kind !== "output" && !hasOutputPorts && (
        <Handle type="source" position={Position.Right} className="rf-handle" />
      )}
      {hasOutputPorts && <PortHandles type="source" ports={outputPorts} position={Position.Right} />}
      {hasOutputPorts && <PortLabels ports={outputPorts} side="right" />}
    </div>
  );
}

export const FlowNodeCard = React.memo(FlowNodeCardImpl);
export default FlowNodeCard;
