/**
 * Editable port-binding chip shared by every Builder view that wants to
 * show + rewire one edge's `(fromPort → toPort)` pair. Click the chip to
 * swap in two dropdowns (sourced from the source/target plugin's
 * declared output/input ports plus an explicit "(default)"), save writes
 * straight through to the same `edges` array every view reads.
 */
import { useEffect, useMemo, useState } from "react";
import type { Node } from "reactflow";
import type { PluginInfo } from "../../lib/api.ts";
import { portsFor } from "../../lib/builderViews.ts";

export interface PortChipProps {
  edgeId: string | undefined;
  sourceId: string;
  targetId: string;
  fromPort: string | null | undefined;
  toPort: string | null | undefined;
  nodes: Node[];
  manifestMap: Map<string, PluginInfo>;
  onUpdateEdge: (
    edgeId: string,
    patch: { sourceHandle?: string | null; targetHandle?: string | null }
  ) => void;
  /** Affects styling so the chip blends in with the surrounding row
   *  (`primary` parents are quiet; `ref` cross-refs and `join` join-refs
   *  are tinted to match their context). */
  variant?: "primary" | "ref" | "join" | "stage";
}

export function PortChip(props: PortChipProps) {
  const {
    edgeId,
    sourceId,
    targetId,
    fromPort,
    toPort,
    nodes,
    manifestMap,
    onUpdateEdge,
    variant = "primary"
  } = props;
  const [editing, setEditing] = useState(false);
  const [from, setFrom] = useState<string>(fromPort ?? "");
  const [to, setTo] = useState<string>(toPort ?? "");
  // Reset the draft whenever the underlying edge ports change (e.g. the
  // user toggled to Flow View, edited there, came back).
  useEffect(() => {
    setFrom(fromPort ?? "");
    setTo(toPort ?? "");
  }, [fromPort, toPort]);

  const sourceNode = useMemo(
    () => nodes.find((n) => n.id === sourceId),
    [nodes, sourceId]
  );
  const targetNode = useMemo(
    () => nodes.find((n) => n.id === targetId),
    [nodes, targetId]
  );
  const sourcePorts = portsFor(sourceNode, manifestMap).outputs;
  const targetPorts = portsFor(targetNode, manifestMap).inputs;

  // Dynamic-port plugins won't declare the port that's currently wired —
  // keep it in the dropdown anyway so the user can see what's there.
  const sourceOpts = useMemo(() => {
    const set = new Set(sourcePorts);
    if (fromPort) set.add(fromPort);
    return [...set];
  }, [sourcePorts, fromPort]);
  const targetOpts = useMemo(() => {
    const set = new Set(targetPorts);
    if (toPort) set.add(toPort);
    return [...set];
  }, [targetPorts, toPort]);

  if (!editing) {
    return (
      <button
        type="button"
        className={`tree-port-chip tree-port-chip-${variant}`}
        title="Click to edit the port binding"
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
      >
        <span className="tree-port-name">{fromPort || "default"}</span>
        <span className="tree-port-arrow">→</span>
        <span className="tree-port-name">{toPort || "default"}</span>
      </button>
    );
  }

  return (
    <span
      className="tree-port-editor"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <select
        value={from}
        onChange={(e) => setFrom(e.target.value)}
        title="Source port"
      >
        <option value="">(default)</option>
        {sourceOpts.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <span className="tree-port-arrow">→</span>
      <select
        value={to}
        onChange={(e) => setTo(e.target.value)}
        title="Target port"
      >
        <option value="">(default)</option>
        {targetOpts.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="primary tree-port-btn"
        onClick={() => {
          if (edgeId) {
            onUpdateEdge(edgeId, {
              sourceHandle: from ? from : null,
              targetHandle: to ? to : null
            });
          }
          setEditing(false);
        }}
      >
        save
      </button>
      <button
        type="button"
        className="link-btn tree-port-btn"
        onClick={() => {
          setFrom(fromPort ?? "");
          setTo(toPort ?? "");
          setEditing(false);
        }}
      >
        cancel
      </button>
    </span>
  );
}
