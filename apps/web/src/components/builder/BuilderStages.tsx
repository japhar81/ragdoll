/**
 * Stages view — every node grouped into the topological layer it runs in.
 *
 * Reads "top to bottom = first to last": every node in stage N is
 * independent of every other node in stage N (they have no dependency
 * on each other) and runs strictly after every node in stages
 * 0..N-1. Parallel pipelines visually line up side-by-side without any
 * projection tricks; convergence rows sit at the bottom of the deepest
 * branch they depend on.
 *
 * Each card shows incoming edges as `← source (fromPort → toPort)` chips
 * with the editable PortChip, so wiring stays visible + tweakable
 * without leaving the view. Dropping a palette plugin on a stage adds
 * a new node (unwired by default — user wires from another view or by
 * editing edges in the Flow View).
 */
import { useCallback, useMemo } from "react";
import type { Node, Edge } from "reactflow";
import { projectStages } from "../../lib/stagesProjection.ts";
import { nodeIcon, nodeLabel } from "../../lib/builderViews.ts";
import { decodePaletteDrag, type PaletteDragItem } from "../../lib/palette.ts";
import { DND_MIME } from "../../lib/graph.ts";
import type { PluginInfo } from "../../lib/api.ts";
import { PortChip } from "./PortChip.tsx";

export interface BuilderStagesProps {
  nodes: Node[];
  edges: Edge[];
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
  onAddChild: (parentId: string, item: PaletteDragItem) => void;
  onDelete: (id: string) => void;
  pluginManifestMap: Map<string, PluginInfo>;
  onUpdateEdge: (
    edgeId: string,
    patch: { sourceHandle?: string | null; targetHandle?: string | null }
  ) => void;
}

export function BuilderStages(props: BuilderStagesProps) {
  const {
    nodes,
    edges,
    selectedId,
    onSelect,
    onAddChild,
    onDelete,
    pluginManifestMap,
    onUpdateEdge
  } = props;

  const projection = useMemo(
    () =>
      projectStages(
        nodes.map((n) => n.id),
        edges.map((e) => ({ source: e.source, target: e.target }))
      ),
    [nodes, edges]
  );

  // Pre-index incoming edges per target so we can render each card's
  // upstream list in O(1) per card instead of scanning edges N times.
  const incomingByTarget = useMemo(() => {
    const map = new Map<string, Edge[]>();
    for (const e of edges) {
      const list = map.get(e.target) ?? [];
      list.push(e);
      map.set(e.target, list);
    }
    return map;
  }, [edges]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!selectedId) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        onDelete(selectedId);
      }
    },
    [selectedId, onDelete]
  );

  const handleStageDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const raw = event.dataTransfer.getData(DND_MIME);
      const item = decodePaletteDrag(raw);
      if (!item) return;
      event.preventDefault();
      // Stages auto-compute — a freshly-added node with no inputs lands
      // in stage 0 and shows up at the top. Wire it via another view.
      onAddChild("", item);
    },
    [onAddChild]
  );

  return (
    <div
      className="builder-stages"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onDragOver={(e) => e.preventDefault()}
    >
      <header className="builder-tree-head">
        <span className="muted">
          {projection.stages.length} stage
          {projection.stages.length === 1 ? "" : "s"} · {nodes.length} nodes
        </span>
        <span className="muted builder-tree-hint">
          each row groups nodes that run in parallel — click a row's port
          chip to rewire · drop a palette plugin on any stage to add a node
        </span>
      </header>

      {projection.stages.length === 0 && (
        <p className="muted" style={{ padding: 16 }}>
          Drop a node from the palette to start.
        </p>
      )}

      {projection.stages.map((stage) => (
        <section
          key={stage.index}
          className="builder-stage"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleStageDrop}
        >
          <header className="builder-stage-head">
            <strong>Stage {stage.index + 1}</strong>
            <span className="muted">
              {stage.nodeIds.length} node
              {stage.nodeIds.length === 1 ? "" : "s"}
            </span>
          </header>
          <div className="builder-stage-cards">
            {stage.nodeIds.map((id) => {
              const flow = nodes.find((n) => n.id === id);
              const incoming = incomingByTarget.get(id) ?? [];
              const isSelected = id === selectedId;
              return (
                <div
                  key={id}
                  className={
                    "builder-stage-card" +
                    (isSelected ? " selected" : "")
                  }
                  onClick={() => onSelect(id)}
                  title={id}
                >
                  <div className="builder-stage-card-head">
                    <span className="builder-tree-icon" aria-hidden>
                      {nodeIcon(flow)}
                    </span>
                    <strong>{id}</strong>
                    <span className="muted"> {nodeLabel(flow)}</span>
                  </div>
                  {incoming.length > 0 && (
                    <div className="builder-stage-card-inputs">
                      {incoming.map((e) => (
                        <div
                          key={e.id}
                          className="builder-stage-card-input"
                        >
                          <span className="muted">←</span>
                          <button
                            type="button"
                            className="builder-stage-card-input-source"
                            title={`Select ${e.source}`}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              onSelect(e.source);
                            }}
                          >
                            {e.source}
                          </button>
                          <PortChip
                            edgeId={e.id}
                            sourceId={e.source}
                            targetId={e.target}
                            fromPort={e.sourceHandle}
                            toPort={e.targetHandle}
                            nodes={nodes}
                            manifestMap={pluginManifestMap}
                            onUpdateEdge={onUpdateEdge}
                            variant="stage"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
