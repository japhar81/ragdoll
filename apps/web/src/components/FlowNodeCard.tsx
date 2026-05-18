import React from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import type { PipelineNode } from "../lib/types.ts";
import { nodeKind, nodeTheme, styleKeyFor } from "../lib/graph.ts";

export interface RagNodeData {
  label: string;
  node: PipelineNode;
}

/**
 * Colored, icon-bearing custom React Flow node. Input nodes expose only a
 * source handle, output nodes only a target handle, everything else both.
 */
function FlowNodeCardImpl({ data, selected }: NodeProps<RagNodeData>) {
  const node = data.node;
  const kind = nodeKind(node);
  const theme = nodeTheme(styleKeyFor(node));
  return (
    <div
      className={`rf-node${selected ? " selected" : ""}`}
      style={{ borderColor: theme.color }}
    >
      {kind !== "input" && (
        <Handle type="target" position={Position.Left} className="rf-handle" />
      )}
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
      {kind !== "output" && (
        <Handle type="source" position={Position.Right} className="rf-handle" />
      )}
    </div>
  );
}

export const FlowNodeCard = React.memo(FlowNodeCardImpl);
export default FlowNodeCard;
