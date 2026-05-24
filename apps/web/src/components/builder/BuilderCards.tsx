/**
 * Cards view — one self-contained card per node, ordered topologically.
 *
 * Each card reads like a small datasheet for a single node: plugin icon
 * + name + node id at the top; inputs and outputs listed underneath with
 * editable port chips. Useful when the user wants to understand or wire
 * one node at a time without taking in the whole graph.
 */
import { useCallback, useMemo } from "react";
import type { Node, Edge } from "reactflow";
import { projectStages } from "../../lib/stagesProjection.ts";
import { nodeIcon, nodeLabel } from "../../lib/builderViews.ts";
import type { PluginInfo } from "../../lib/api.ts";
import { PortChip } from "./PortChip.tsx";

export interface BuilderCardsProps {
  nodes: Node[];
  edges: Edge[];
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
  onDelete: (id: string) => void;
  pluginManifestMap: Map<string, PluginInfo>;
  onUpdateEdge: (
    edgeId: string,
    patch: { sourceHandle?: string | null; targetHandle?: string | null }
  ) => void;
}

export function BuilderCards(props: BuilderCardsProps) {
  const {
    nodes,
    edges,
    selectedId,
    onSelect,
    onDelete,
    pluginManifestMap,
    onUpdateEdge
  } = props;

  // Topological order = "the order this DAG would execute in". Lay
  // cards out in that order so a reader walking the page reads the
  // pipeline.
  const orderedIds = useMemo(() => {
    const projection = projectStages(
      nodes.map((n) => n.id),
      edges.map((e) => ({ source: e.source, target: e.target }))
    );
    return projection.stages.flatMap((s) => s.nodeIds);
  }, [nodes, edges]);

  // Indexes for the per-card "inputs" + "outputs" listings.
  const { byTarget, bySource } = useMemo(() => {
    const t = new Map<string, Edge[]>();
    const s = new Map<string, Edge[]>();
    for (const e of edges) {
      const tl = t.get(e.target) ?? [];
      tl.push(e);
      t.set(e.target, tl);
      const sl = s.get(e.source) ?? [];
      sl.push(e);
      s.set(e.source, sl);
    }
    return { byTarget: t, bySource: s };
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

  return (
    <div className="builder-cards" tabIndex={0} onKeyDown={onKeyDown}>
      <header className="builder-tree-head">
        <span className="muted">
          {nodes.length} node{nodes.length === 1 ? "" : "s"} ·
          topological order
        </span>
        <span className="muted builder-tree-hint">
          one card per node — port chips on Inputs/Outputs edit wiring ·
          click a source/target name to jump to that card
        </span>
      </header>
      {orderedIds.length === 0 && (
        <p className="muted" style={{ padding: 16 }}>
          Drop a node from the palette to start.
        </p>
      )}
      {orderedIds.map((id) => {
        const flow = nodes.find((n) => n.id === id);
        const incoming = byTarget.get(id) ?? [];
        const outgoing = bySource.get(id) ?? [];
        const isSelected = id === selectedId;
        return (
          <article
            key={id}
            data-card-id={id}
            className={"builder-card" + (isSelected ? " selected" : "")}
            onClick={() => onSelect(id)}
            title={id}
          >
            <header className="builder-card-head">
              <span className="builder-tree-icon" aria-hidden>
                {nodeIcon(flow)}
              </span>
              <strong>{id}</strong>
              <span className="muted"> {nodeLabel(flow)}</span>
            </header>
            <div className="builder-card-body">
              <section>
                <h4>Inputs</h4>
                {incoming.length === 0 ? (
                  <p className="muted builder-card-empty">
                    (none — this is a source)
                  </p>
                ) : (
                  incoming.map((e) => (
                    <div key={e.id} className="builder-card-edge">
                      <span className="muted">←</span>
                      <button
                        type="button"
                        className="builder-card-link"
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
                        variant="ref"
                      />
                    </div>
                  ))
                )}
              </section>
              <section>
                <h4>Outputs</h4>
                {outgoing.length === 0 ? (
                  <p className="muted builder-card-empty">
                    (none — this is a sink)
                  </p>
                ) : (
                  outgoing.map((e) => (
                    <div key={e.id} className="builder-card-edge">
                      <span className="muted">→</span>
                      <button
                        type="button"
                        className="builder-card-link"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          onSelect(e.target);
                        }}
                      >
                        {e.target}
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
                        variant="join"
                      />
                    </div>
                  ))
                )}
              </section>
            </div>
          </article>
        );
      })}
    </div>
  );
}
