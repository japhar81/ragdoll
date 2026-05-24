/**
 * Tree View — user-defined stage sections × per-node expandable pin editor.
 *
 * Stages are now first-class organizational containers (see
 * `PipelineSpec.metadata.stages` and `node.ui.stageId`). Tree View
 * groups nodes by their stage id; nodes with no stage land in an
 * "Unassigned" pseudo-section at the bottom. The toolbar above the
 * tree owns stage CRUD ("+ Add stage", "Auto-stage from flow"); each
 * stage banner exposes rename, delete, and reorder controls. Per-row
 * "Move to ▾" reassigns a node's stage.
 *
 * Each row is single-line when collapsed. Expanded shows INPUTS (one
 * row per declared input port, with a `<select>` of every other node's
 * output ports) and OUTPUTS (one row per declared output port, with
 * currently-connected targets + "+ Add target ▾"). All edits go through
 * the shared `edges` array so toggling to the Flow View reflects the
 * change immediately.
 */
import { useCallback, useMemo, useState } from "react";
import type { Node, Edge } from "reactflow";
import {
  nodeIcon,
  nodeLabel,
  nodeDisplay,
  portsFor
} from "../../lib/builderViews.ts";
import { decodePaletteDrag, type PaletteDragItem } from "../../lib/palette.ts";
import { DND_MIME } from "../../lib/graph.ts";
import type { PluginInfo } from "../../lib/api.ts";
import type { PipelineStage } from "../../lib/types.ts";

export interface BuilderTreeProps {
  nodes: Node[];
  edges: Edge[];
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
  onAddChild: (parentId: string, item: PaletteDragItem) => void;
  onDelete: (id: string) => void;
  pluginManifestMap: Map<string, PluginInfo>;
  onConnect: (
    sourceId: string,
    sourcePort: string | null,
    targetId: string,
    targetPort: string | null
  ) => void;
  onDisconnect: (edgeId: string) => void;
  stages: PipelineStage[];
  onAddStage: (label: string) => void;
  onRenameStage: (stageId: string, label: string) => void;
  onDeleteStage: (stageId: string) => void;
  onAssignNodeToStage: (nodeId: string, stageId: string | null) => void;
  onAutoStage: () => void;
}

const SEP = "";
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

/** Friendly label for a `(nodeId, port|null)` option. Uses the node's
 *  alias when set; appends the strict id in parens when distinct from
 *  the alias so two nodes with the same alias stay distinguishable. */
function pinLabel(
  nodeById: Map<string, Node>,
  nodeId: string,
  port: string | null | undefined
): string {
  const display = nodeDisplay(nodeById.get(nodeId));
  const portPart = port ? `.${port}` : " (default)";
  if (display && display !== nodeId) return `${display}${portPart} (${nodeId})`;
  return `${nodeId}${portPart}`;
}

interface PinEditorProps {
  nodes: Node[];
  edges: Edge[];
  pluginManifestMap: Map<string, PluginInfo>;
  node: Node;
  onConnect: BuilderTreeProps["onConnect"];
  onDisconnect: BuilderTreeProps["onDisconnect"];
  stages: PipelineStage[];
  onAssignNodeToStage: BuilderTreeProps["onAssignNodeToStage"];
}

function PinEditor(props: PinEditorProps) {
  const {
    nodes,
    edges,
    pluginManifestMap,
    node,
    onConnect,
    onDisconnect,
    stages,
    onAssignNodeToStage
  } = props;
  const nodeById = useMemo(() => {
    const m = new Map<string, Node>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  const { inputs, outputs } = useMemo(() => {
    const declared = portsFor(node, pluginManifestMap);
    const ins = new Set<string>(declared.inputs);
    const outs = new Set<string>(declared.outputs);
    for (const e of edges) {
      if (e.target === node.id && e.targetHandle) ins.add(e.targetHandle);
      if (e.source === node.id && e.sourceHandle) outs.add(e.sourceHandle);
    }
    return { inputs: [...ins].sort(), outputs: [...outs].sort() };
  }, [node, edges, pluginManifestMap]);

  const sourceOptions = useMemo(() => {
    const out: Array<{ nodeId: string; port: string | null; key: string }> =
      [];
    for (const other of nodes) {
      if (other.id === node.id) continue;
      const ps = portsFor(other, pluginManifestMap).outputs;
      if (ps.length === 0) continue;
      for (const p of ps) {
        out.push({ nodeId: other.id, port: p, key: encodePin(other.id, p) });
      }
    }
    out.sort((a, b) =>
      a.nodeId === b.nodeId
        ? (a.port ?? "").localeCompare(b.port ?? "")
        : a.nodeId.localeCompare(b.nodeId)
    );
    return out;
  }, [nodes, node.id, pluginManifestMap]);

  const targetOptions = useMemo(() => {
    const out: Array<{ nodeId: string; port: string | null; key: string }> =
      [];
    for (const other of nodes) {
      if (other.id === node.id) continue;
      const ps = portsFor(other, pluginManifestMap).inputs;
      if (ps.length === 0) continue;
      for (const p of ps) {
        out.push({ nodeId: other.id, port: p, key: encodePin(other.id, p) });
      }
    }
    out.sort((a, b) =>
      a.nodeId === b.nodeId
        ? (a.port ?? "").localeCompare(b.port ?? "")
        : a.nodeId.localeCompare(b.nodeId)
    );
    return out;
  }, [nodes, node.id, pluginManifestMap]);

  const currentStageId =
    (node.data as { node?: { ui?: { stageId?: string } } } | undefined)?.node
      ?.ui?.stageId ?? "";

  return (
    <div className="builder-pin-editor">
      {/* Stage assignment — first thing so re-org is one click. */}
      <div className="builder-pin-section">
        <div className="builder-pin-heading">Stage</div>
        <div className="builder-pin-row">
          <span className="builder-pin-name">assigned to</span>
          <select
            value={currentStageId || NONE}
            onChange={(e) => {
              const v = e.target.value;
              onAssignNodeToStage(node.id, v === NONE ? null : v);
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <option value={NONE}>(unassigned)</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {inputs.length > 0 && (
        <div className="builder-pin-section">
          <div className="builder-pin-heading">Inputs</div>
          {inputs.map((portName) => {
            const wired = edges.find(
              (e) =>
                e.target === node.id && (e.targetHandle ?? null) === portName
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
                      {pinLabel(nodeById, opt.nodeId, opt.port)}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      )}

      {outputs.length > 0 && (
        <div className="builder-pin-section">
          <div className="builder-pin-heading">Outputs</div>
          {outputs.map((portName) => {
            const wired = edges.filter(
              (e) =>
                e.source === node.id && (e.sourceHandle ?? null) === portName
            );
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
                      {pinLabel(nodeById, e.target, e.targetHandle ?? null)}
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
                          {pinLabel(nodeById, opt.nodeId, opt.port)}
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
  stages: PipelineStage[];
  onAssignNodeToStage: BuilderTreeProps["onAssignNodeToStage"];
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
    onDisconnect,
    stages,
    onAssignNodeToStage
  } = props;
  const isSelected = node.id === selectedId;
  const display = nodeDisplay(node);
  const labelSub = nodeLabel(node);
  const subParts: string[] = [];
  if (labelSub) subParts.push(labelSub);
  if (display !== node.id) subParts.push(node.id);
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
          <strong>{display}</strong>
          {subParts.length > 0 && (
            <span className="muted"> {subParts.join(" · ")}</span>
          )}
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
          stages={stages}
          onAssignNodeToStage={onAssignNodeToStage}
        />
      )}
    </>
  );
}

interface StageHeadProps {
  stage: PipelineStage | null;
  nodeCount: number;
  onRename: (id: string, label: string) => void;
  onDelete: (id: string) => void;
}

function StageHead(props: StageHeadProps) {
  const { stage, nodeCount, onRename, onDelete } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(stage?.label ?? "");
  if (!stage) {
    return (
      <header className="builder-tree-stage-head builder-tree-stage-head-unassigned">
        <span>Unassigned</span>
        <span className="muted">
          {nodeCount} node{nodeCount === 1 ? "" : "s"}
        </span>
      </header>
    );
  }
  if (editing) {
    const commit = () => {
      const trimmed = draft.trim();
      if (trimmed && trimmed !== stage.label) onRename(stage.id, trimmed);
      setEditing(false);
    };
    return (
      <header className="builder-tree-stage-head">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              setDraft(stage.label);
              setEditing(false);
            }
          }}
        />
        <span className="muted">
          {nodeCount} node{nodeCount === 1 ? "" : "s"}
        </span>
      </header>
    );
  }
  return (
    <header className="builder-tree-stage-head">
      <span
        className="builder-tree-stage-name"
        title="Click to rename"
        onClick={() => {
          setDraft(stage.label);
          setEditing(true);
        }}
      >
        {stage.label}
      </span>
      <span className="muted">
        {nodeCount} node{nodeCount === 1 ? "" : "s"}
      </span>
      <button
        type="button"
        className="link-btn builder-tree-stage-del"
        title="Delete stage (nodes move to Unassigned)"
        onClick={() => onDelete(stage.id)}
      >
        delete
      </button>
    </header>
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
    onDisconnect,
    stages,
    onAddStage,
    onRenameStage,
    onDeleteStage,
    onAssignNodeToStage,
    onAutoStage
  } = props;

  // Build the section list: every declared stage in declared order
  // (with its members), followed by an Unassigned bucket for anything
  // whose stageId is missing or unknown.
  const sections = useMemo(() => {
    const known = new Set(stages.map((s) => s.id));
    const byStage = new Map<string, Node[]>();
    for (const s of stages) byStage.set(s.id, []);
    const unassigned: Node[] = [];
    for (const n of nodes) {
      const sid = (n.data as { node?: { ui?: { stageId?: string } } } | undefined)
        ?.node?.ui?.stageId;
      if (sid && known.has(sid)) {
        byStage.get(sid)!.push(n);
      } else {
        unassigned.push(n);
      }
    }
    const sectionStages = stages.map((s) => ({
      stage: s as PipelineStage | null,
      nodes: (byStage.get(s.id) ?? []).slice().sort((a, b) => a.id.localeCompare(b.id))
    }));
    if (unassigned.length > 0) {
      sectionStages.push({
        stage: null,
        nodes: unassigned.slice().sort((a, b) => a.id.localeCompare(b.id))
      });
    }
    return sectionStages;
  }, [nodes, stages]);

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
          {nodes.length} node{nodes.length === 1 ? "" : "s"} ·{" "}
          {stages.length} stage{stages.length === 1 ? "" : "s"}
        </span>
        <span className="builder-tree-toolbar">
          <button
            type="button"
            className="link-btn"
            title="Append a new stage"
            onClick={() => {
              const name = window.prompt("New stage name:");
              if (name && name.trim()) onAddStage(name.trim());
            }}
          >
            + Add stage
          </button>
          <button
            type="button"
            className="link-btn"
            title="Generate stages from the topological layout"
            onClick={onAutoStage}
          >
            Auto-stage
          </button>
        </span>
      </header>

      {nodes.length === 0 ? (
        <p className="muted" style={{ padding: 16 }}>
          Drop a node from the palette to start.
        </p>
      ) : (
        sections.map((section, i) => (
          <section
            key={section.stage ? section.stage.id : "__unassigned__" + i}
            className="builder-tree-stage"
          >
            <StageHead
              stage={section.stage}
              nodeCount={section.nodes.length}
              onRename={onRenameStage}
              onDelete={onDeleteStage}
            />
            {section.nodes.length === 0 && section.stage && (
              <p className="muted builder-tree-stage-empty">
                Empty — assign a node from another stage via its "Stage"
                dropdown in the expanded view.
              </p>
            )}
            {section.nodes.map((node) => (
              <NodeRow
                key={node.id}
                node={node}
                expanded={expanded.has(node.id)}
                selectedId={selectedId}
                onSelect={onSelect}
                onToggle={toggleExpand}
                nodes={nodes}
                edges={edges}
                pluginManifestMap={pluginManifestMap}
                onConnect={onConnect}
                onDisconnect={onDisconnect}
                stages={stages}
                onAssignNodeToStage={onAssignNodeToStage}
              />
            ))}
          </section>
        ))
      )}
    </div>
  );
}
