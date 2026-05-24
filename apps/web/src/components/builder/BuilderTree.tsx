/**
 * Tree View — stages × expandable per-node pin editor.
 *
 * The DAG renders as a flat list grouped by topological stage. Each
 * stage is a thin banner; under it sit the nodes that run in that
 * stage. A node row collapses to a single line (icon · id · plugin)
 * for scannability and expands into a "PINS" panel:
 *
 *  - INPUTS  — one row per declared input port (or per port that has
 *              any current incoming edge). The source is chosen via a
 *              single `<select>` listing every other node's output
 *              ports — the input port stays single-source by design,
 *              so picking a new source replaces the prior wire.
 *  - OUTPUTS — one row per declared output port. Currently-connected
 *              targets list as `→ nodeX.portY` items with an × to
 *              detach. A "+ Add target ▾" selector appends a target.
 *
 * Everything writes through to the same React Flow `edges` array the
 * Flow View reads, so toggling between tabs is seamless.
 */
import { useCallback, useMemo, useState } from "react";
import type { Node, Edge } from "reactflow";
import { projectStages } from "../../lib/stagesProjection.ts";
import { nodeIcon, nodeLabel, portsFor } from "../../lib/builderViews.ts";
import { decodePaletteDrag, type PaletteDragItem } from "../../lib/palette.ts";
import { DND_MIME } from "../../lib/graph.ts";
import type { PluginInfo } from "../../lib/api.ts";

export interface BuilderTreeProps {
  nodes: Node[];
  edges: Edge[];
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
  /** Drop a palette item — parent id is empty since the new tree
   *  doesn't tie creation to a parent (wire via the expanded editor). */
  onAddChild: (parentId: string, item: PaletteDragItem) => void;
  onDelete: (id: string) => void;
  pluginManifestMap: Map<string, PluginInfo>;
  /** Ensure an edge from (sourceId, sourcePort) → (targetId, targetPort)
   *  exists. Any existing edge into the same (targetId, targetPort) is
   *  REPLACED so input ports stay single-source. `null` ports mean the
   *  default / no specific handle. */
  onConnect: (
    sourceId: string,
    sourcePort: string | null,
    targetId: string,
    targetPort: string | null
  ) => void;
  /** Remove one specific edge by its React Flow edge id. */
  onDisconnect: (edgeId: string) => void;
}

/** Encode a (nodeId, port|null) pair for use as an `<option>` value.
 *  Plain `nodeId.port` is ambiguous because a port name may contain `.`;
 *  pick a separator that nothing real uses. */
const SEP = "";
const NONE = "__none__";
function encodePin(nodeId: string, port: string | null | undefined): string {
  return `${nodeId}${SEP}${port ?? ""}`;
}
function decodePin(s: string): { nodeId: string; port: string | null } {
  const i = s.indexOf(SEP);
  if (i < 0) return { nodeId: s, port: null };
  const port = s.slice(i + SEP.length);
  return { nodeId: s.slice(0, i), port: port === "" ? null : port };
}

/** Friendly label for an `(nodeId, port|null)` option. */
function pinLabel(nodeId: string, port: string | null | undefined): string {
  return port ? `${nodeId}.${port}` : `${nodeId} (default)`;
}

interface PinEditorProps {
  nodes: Node[];
  edges: Edge[];
  pluginManifestMap: Map<string, PluginInfo>;
  node: Node;
  onConnect: BuilderTreeProps["onConnect"];
  onDisconnect: BuilderTreeProps["onDisconnect"];
}

function PinEditor(props: PinEditorProps) {
  const { nodes, edges, pluginManifestMap, node, onConnect, onDisconnect } =
    props;

  // Effective input/output port lists — union of declared manifest
  // ports and any ports already used by current edges (so dynamic-port
  // plugins still show what they have wired).
  const { inputs, outputs } = useMemo(() => {
    const declared = portsFor(node, pluginManifestMap);
    const ins = new Set<string>(declared.inputs);
    const outs = new Set<string>(declared.outputs);
    for (const e of edges) {
      if (e.target === node.id && e.targetHandle) ins.add(e.targetHandle);
      if (e.source === node.id && e.sourceHandle) outs.add(e.sourceHandle);
    }
    // For unconfigured plugin nodes with no declared ports and no current
    // edges, show a synthetic "default" so the user can begin wiring.
    if (ins.size === 0 && declared.inputs.length === 0 && node.type !== "input") {
      // Only inputs side — if this is a true source node we leave it empty
      // (an output node with no declared inputs is unusual but still
      //  editable with the synthetic slot).
    }
    return {
      inputs: [...ins].sort(),
      outputs: [...outs].sort()
    };
  }, [node, edges, pluginManifestMap]);

  // Every other node's output ports — option list for input dropdowns.
  const sourceOptions = useMemo(() => {
    const out: Array<{ nodeId: string; port: string | null; key: string }> =
      [];
    for (const other of nodes) {
      if (other.id === node.id) continue;
      const ps = portsFor(other, pluginManifestMap).outputs;
      if (ps.length === 0) {
        // A node with no declared outputs (e.g. an Output IO node) can't
        // be a source — skip it.
        continue;
      }
      for (const p of ps) {
        out.push({
          nodeId: other.id,
          port: p,
          key: encodePin(other.id, p)
        });
      }
    }
    // Stable order: by nodeId, then port.
    out.sort((a, b) =>
      a.nodeId === b.nodeId
        ? (a.port ?? "").localeCompare(b.port ?? "")
        : a.nodeId.localeCompare(b.nodeId)
    );
    return out;
  }, [nodes, node.id, pluginManifestMap]);

  // Every other node's input ports — option list for output add-target
  // dropdowns.
  const targetOptions = useMemo(() => {
    const out: Array<{ nodeId: string; port: string | null; key: string }> =
      [];
    for (const other of nodes) {
      if (other.id === node.id) continue;
      const ps = portsFor(other, pluginManifestMap).inputs;
      if (ps.length === 0) continue;
      for (const p of ps) {
        out.push({
          nodeId: other.id,
          port: p,
          key: encodePin(other.id, p)
        });
      }
    }
    out.sort((a, b) =>
      a.nodeId === b.nodeId
        ? (a.port ?? "").localeCompare(b.port ?? "")
        : a.nodeId.localeCompare(b.nodeId)
    );
    return out;
  }, [nodes, node.id, pluginManifestMap]);

  return (
    <div className="builder-pin-editor">
      {/* INPUTS */}
      {inputs.length > 0 && (
        <div className="builder-pin-section">
          <div className="builder-pin-heading">Inputs</div>
          {inputs.map((portName) => {
            const wired = edges.find(
              (e) => e.target === node.id && (e.targetHandle ?? null) === portName
            );
            return (
              <div key={"in:" + portName} className="builder-pin-row">
                <span className="builder-pin-name">{portName}</span>
                <span className="builder-pin-arrow">←</span>
                <select
                  value={
                    wired
                      ? encodePin(wired.source, wired.sourceHandle ?? null)
                      : NONE
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === NONE) {
                      if (wired) onDisconnect(wired.id);
                      return;
                    }
                    const { nodeId, port } = decodePin(v);
                    onConnect(nodeId, port, node.id, portName);
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <option value={NONE}>(disconnected)</option>
                  {sourceOptions.map((opt) => (
                    <option key={opt.key} value={opt.key}>
                      {pinLabel(opt.nodeId, opt.port)}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      )}

      {/* OUTPUTS */}
      {outputs.length > 0 && (
        <div className="builder-pin-section">
          <div className="builder-pin-heading">Outputs</div>
          {outputs.map((portName) => {
            const wired = edges.filter(
              (e) => e.source === node.id && (e.sourceHandle ?? null) === portName
            );
            // Targets already wired from THIS source port (so they don't
            // appear again in the "+ Add target" dropdown).
            const usedKeys = new Set(
              wired.map((e) => encodePin(e.target, e.targetHandle ?? null))
            );
            const available = targetOptions.filter(
              (o) => !usedKeys.has(o.key)
            );
            return (
              <div
                key={"out:" + portName}
                className="builder-pin-row builder-pin-out"
              >
                <span className="builder-pin-name">{portName}</span>
                <span className="builder-pin-arrow">→</span>
                <span className="builder-pin-targets">
                  {wired.map((e) => (
                    <span key={e.id} className="builder-pin-target">
                      {pinLabel(e.target, e.targetHandle ?? null)}
                      <button
                        type="button"
                        className="builder-pin-x"
                        title="Disconnect"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          onDisconnect(e.id);
                        }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {available.length > 0 && (
                    <select
                      // Always reset to empty so the user can pick the
                      // same option again later.
                      value=""
                      onChange={(e) => {
                        const v = e.target.value;
                        if (!v) return;
                        const { nodeId, port } = decodePin(v);
                        onConnect(node.id, portName, nodeId, port);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="builder-pin-add"
                    >
                      <option value="">+ Add target…</option>
                      {available.map((opt) => (
                        <option key={opt.key} value={opt.key}>
                          {pinLabel(opt.nodeId, opt.port)}
                        </option>
                      ))}
                    </select>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {inputs.length === 0 && outputs.length === 0 && (
        <p className="muted builder-pin-empty">
          This node has no declared pins. Wire it up in the Flow View.
        </p>
      )}
    </div>
  );
}

interface NodeRowProps {
  node: Node;
  expanded: boolean;
  selectedId: string | undefined;
  onSelect: BuilderTreeProps["onSelect"];
  onToggle: (id: string) => void;
  nodes: Node[];
  edges: Edge[];
  pluginManifestMap: Map<string, PluginInfo>;
  onConnect: BuilderTreeProps["onConnect"];
  onDisconnect: BuilderTreeProps["onDisconnect"];
}

function NodeRow(props: NodeRowProps) {
  const {
    node,
    expanded,
    selectedId,
    onSelect,
    onToggle,
    nodes,
    edges,
    pluginManifestMap,
    onConnect,
    onDisconnect
  } = props;
  const isSelected = node.id === selectedId;
  return (
    <>
      <div
        className={"builder-tree-row" + (isSelected ? " selected" : "")}
        onClick={() => onSelect(node.id)}
        title={node.id}
      >
        <button
          type="button"
          className="builder-tree-caret"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(node.id);
          }}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <span className="builder-tree-icon" aria-hidden>
          {nodeIcon(node)}
        </span>
        <span className="builder-tree-label">
          <strong>{node.id}</strong>
          <span className="muted"> {nodeLabel(node)}</span>
        </span>
      </div>
      {expanded && (
        <PinEditor
          nodes={nodes}
          edges={edges}
          pluginManifestMap={pluginManifestMap}
          node={node}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
        />
      )}
    </>
  );
}

export function BuilderTree(props: BuilderTreeProps) {
  const {
    nodes,
    edges,
    selectedId,
    onSelect,
    onAddChild,
    onDelete,
    pluginManifestMap,
    onConnect,
    onDisconnect
  } = props;

  const stages = useMemo(
    () =>
      projectStages(
        nodes.map((n) => n.id),
        edges.map((e) => ({ source: e.source, target: e.target }))
      ).stages,
    [nodes, edges]
  );

  const nodeById = useMemo(() => {
    const m = new Map<string, Node>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  // Per-node expansion state. Collapsed by default so the staged
  // overview is the first thing the user sees.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!selectedId) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        // Skip when the user is actually inside an editor (select / input).
        const tag = (event.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
        event.preventDefault();
        onDelete(selectedId);
      }
    },
    [selectedId, onDelete]
  );

  const handleRootDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const raw = event.dataTransfer.getData(DND_MIME);
      const item = decodePaletteDrag(raw);
      if (!item) return;
      event.preventDefault();
      // No parent — the new node lands as a root (stage 0). Wire it via
      // the expanded INPUTS editor.
      onAddChild("", item);
    },
    [onAddChild]
  );

  return (
    <div
      className="builder-tree"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleRootDrop}
    >
      <header className="builder-tree-head">
        <span className="muted">
          {nodes.length} node{nodes.length === 1 ? "" : "s"} ·
          {" "}
          {stages.length} stage{stages.length === 1 ? "" : "s"}
        </span>
        <span className="muted builder-tree-hint">
          drag plugins from the palette to add · expand a row to view + edit its pins
        </span>
      </header>

      {nodes.length === 0 ? (
        <p className="muted" style={{ padding: 16 }}>
          Drop a node from the palette to start.
        </p>
      ) : (
        stages.map((stage) => (
          <section key={stage.index} className="builder-tree-stage">
            <header className="builder-tree-stage-head">
              <span>Stage {stage.index + 1}</span>
              <span className="muted">
                {stage.nodeIds.length} node
                {stage.nodeIds.length === 1 ? "" : "s"}
              </span>
            </header>
            {stage.nodeIds.map((id) => {
              const flow = nodeById.get(id);
              if (!flow) return null;
              return (
                <NodeRow
                  key={id}
                  node={flow}
                  expanded={expanded.has(id)}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  onToggle={toggleExpand}
                  nodes={nodes}
                  edges={edges}
                  pluginManifestMap={pluginManifestMap}
                  onConnect={onConnect}
                  onDisconnect={onDisconnect}
                />
              );
            })}
          </section>
        ))
      )}
    </div>
  );
}
