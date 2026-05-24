/**
 * FinalBuilder-style tree projection of the same DAG the Flow View renders.
 *
 * Reads the SAME `nodes`/`edges` state the React Flow canvas owns, so any
 * edit here propagates instantly when the user toggles back. Drop targets
 * accept two payload types from the existing palette DnD contract:
 *
 *  - `application/ragdoll-node`   – palette plugin item → adds a new node
 *                                    as a child of the drop row.
 *  - `application/ragdoll-tree-move` – the tree's own internal payload
 *                                    (a node id) → re-parents the dragged
 *                                    node onto the drop row (rewrites the
 *                                    primary-parent edge; fan-in is kept).
 *
 * Convergence nodes (in-degree > 1, e.g. an `out` that receives every
 * branch) are hoisted to the top level instead of hiding under one
 * parent. Each contributing branch ends with a `→ joinId` leaf so the
 * data flow is visible where the data leaves; the hoisted row at the
 * bottom lists every contributing parent with its port pair.
 *
 * Every edge — primary, cross-ref, and join-ref — surfaces an editable
 * `from → to` port chip so the user can rewire without leaving the tree.
 */
import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import type { Node, Edge } from "reactflow";
import {
  projectGraphToTree,
  isDescendant,
  type TreeNode
} from "../../lib/treeProjection.ts";
import { type PaletteDragItem, decodePaletteDrag } from "../../lib/palette.ts";
import { DND_MIME } from "../../lib/graph.ts";
import type { PluginInfo } from "../../lib/api.ts";

/** Internal MIME for tree → tree drags. Kept distinct from the palette
 *  MIME so a single drop handler can dispatch on payload type. */
export const TREE_MOVE_MIME = "application/ragdoll-tree-move";

export interface BuilderTreeProps {
  /** React Flow node array (matches the Flow View source of truth). */
  nodes: Node[];
  /** React Flow edge array. */
  edges: Edge[];
  /** Currently selected node id — shared with the Inspector. */
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
  /** Drop a palette item as a child of `parentId`. Implementation owns
   *  node creation (so it can seed config from the plugin schema). */
  onAddChild: (parentId: string, item: PaletteDragItem) => void;
  /** Re-parent: replace the primary incoming edge of `nodeId` with one
   *  from `newParentId`. Other incoming edges (fan-in) are kept. */
  onReparent: (nodeId: string, newParentId: string) => void;
  /** Remove the selected node — called by the Delete/Backspace handler. */
  onDelete: (id: string) => void;
  /** Plugin manifests keyed by `${category}:${id}:${version}` — the port
   *  editor reads each node's declared input/output ports from here. */
  pluginManifestMap: Map<string, PluginInfo>;
  /** Mutate one edge's port pair. `null` clears a port (= default). */
  onUpdateEdge: (
    edgeId: string,
    patch: { sourceHandle?: string | null; targetHandle?: string | null }
  ) => void;
}

interface NodeLike {
  type?: string;
  plugin?: { category?: string; id?: string; version?: string };
}

/** Static port list for a node — declared `inputPorts` / `outputPorts`
 *  from the plugin manifest, or the synthetic single port that I/O nodes
 *  carry implicitly. Dynamic-ported plugins fall back to whatever names
 *  are already used in the spec so the dropdown still surfaces them. */
function portsFor(
  flowNode: Node | undefined,
  manifestMap: Map<string, PluginInfo>
): { inputs: string[]; outputs: string[] } {
  const pn = (flowNode?.data as { node?: NodeLike } | undefined)?.node;
  if (!pn) return { inputs: [], outputs: [] };
  if (pn.type === "input") return { inputs: [], outputs: ["output"] };
  if (pn.type === "output") return { inputs: ["input"], outputs: [] };
  const ref = pn.plugin;
  if (!ref?.category || !ref.id || !ref.version) {
    return { inputs: [], outputs: [] };
  }
  const m = manifestMap.get(`${ref.category}:${ref.id}:${ref.version}`);
  return {
    inputs: (m?.inputPorts ?? []).map((p) => p.name),
    outputs: (m?.outputPorts ?? []).map((p) => p.name)
  };
}

interface PortChipProps {
  edgeId: string | undefined;
  sourceId: string;
  targetId: string;
  fromPort: string | null | undefined;
  toPort: string | null | undefined;
  nodes: Node[];
  manifestMap: Map<string, PluginInfo>;
  onUpdateEdge: BuilderTreeProps["onUpdateEdge"];
  variant?: "primary" | "ref" | "join";
}

function PortChip(props: PortChipProps) {
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
  // Keep a draft so the user can cancel without writing.
  const [from, setFrom] = useState<string>(fromPort ?? "");
  const [to, setTo] = useState<string>(toPort ?? "");
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

  // If a current port doesn't appear in the manifest list (e.g. a
  // dynamic-port plugin or a freshly renamed plugin) keep it in the
  // dropdown so the user can still see what's wired today.
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

interface RowProps {
  node: TreeNode;
  selectedId: string | undefined;
  expanded: Set<string>;
  toggleExpand: (id: string) => void;
  onSelect: BuilderTreeProps["onSelect"];
  pipelineNodeFor: (id: string) => Node | undefined;
  pluginLabelFor: (n: Node | undefined) => string;
  pluginIconFor: (n: Node | undefined) => string;
  dragId: string | null;
  setDragId: (id: string | null) => void;
  hoverId: string | null;
  setHoverId: (id: string | null) => void;
  onAddChild: BuilderTreeProps["onAddChild"];
  onReparent: BuilderTreeProps["onReparent"];
  tree: ReturnType<typeof projectGraphToTree>;
  nodes: Node[];
  manifestMap: Map<string, PluginInfo>;
  onUpdateEdge: BuilderTreeProps["onUpdateEdge"];
  /** Node id whose every visual mention should be highlighted while the
   *  user hovers a link pill — gives a "preview" of the navigation
   *  before they click. Null when no link is being hovered. */
  linkHoverId: string | null;
  setLinkHoverId: (id: string | null) => void;
  /** Reveal a hoisted join row when the user clicks one of its inline
   *  pills (scrolls into view + briefly flashes so the connection
   *  reads as "same node, multiple mentions"). */
  revealNode: (id: string) => void;
}

type DropMode = "child" | "reparent" | "blocked" | null;

function Row(props: RowProps) {
  const {
    node,
    selectedId,
    expanded,
    toggleExpand,
    onSelect,
    pipelineNodeFor,
    pluginLabelFor,
    pluginIconFor,
    dragId,
    setDragId,
    hoverId,
    setHoverId,
    onAddChild,
    onReparent,
    tree,
    nodes,
    manifestMap,
    onUpdateEdge
  } = props;
  const {
    linkHoverId,
    setLinkHoverId,
    revealNode
  } = props;
  const flow = pipelineNodeFor(node.id);
  const isExpanded = expanded.has(node.id);
  // A row is expandable when it has primary children OR (for hoisted
  // join rows) when it has crossRefs to reveal.
  const hasChildren = node.children.length > 0 || node.crossRefs.length > 0;
  const isSelected = node.id === selectedId;
  // Row is "linked" while the user hovers a "→ id" pill that points at
  // it — a transient halo that makes "one logical node, several visual
  // mentions" legible. Solid selection styling stays on the row that's
  // actually selected.
  const isLinked = !isSelected && linkHoverId === node.id;
  const isHover = node.id === hoverId;

  const dropMode: DropMode = useMemo(() => {
    if (!isHover) return null;
    if (dragId) {
      if (dragId === node.id) return "blocked";
      if (isDescendant(tree, dragId, node.id)) return "blocked";
      return "reparent";
    }
    return "child";
  }, [isHover, dragId, node.id, tree]);

  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.dataTransfer.setData(TREE_MOVE_MIME, node.id);
      event.dataTransfer.effectAllowed = "move";
      setDragId(node.id);
    },
    [node.id, setDragId]
  );

  const handleDragEnd = useCallback(() => {
    setDragId(null);
    setHoverId(null);
  }, [setDragId, setHoverId]);

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = dropMode === "blocked" ? "none" : "move";
      if (hoverId !== node.id) setHoverId(node.id);
    },
    [dropMode, hoverId, node.id, setHoverId]
  );

  const handleDragLeave = useCallback(() => {
    if (hoverId === node.id) setHoverId(null);
  }, [hoverId, node.id, setHoverId]);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setHoverId(null);
      const moveId = event.dataTransfer.getData(TREE_MOVE_MIME);
      if (moveId) {
        if (moveId === node.id) return;
        if (isDescendant(tree, moveId, node.id)) return;
        onReparent(moveId, node.id);
        return;
      }
      const raw = event.dataTransfer.getData(DND_MIME);
      const item = decodePaletteDrag(raw);
      if (item) {
        onAddChild(node.id, item);
        if (!isExpanded) toggleExpand(node.id);
      }
    },
    [
      isExpanded,
      node.id,
      onAddChild,
      onReparent,
      setHoverId,
      toggleExpand,
      tree
    ]
  );

  return (
    <>
      <div
        data-tree-node-id={node.id}
        className={
          "builder-tree-row" +
          (isSelected ? " selected" : "") +
          (isLinked ? " linked" : "") +
          (node.isJoin ? " join" : "") +
          (isHover && dropMode === "reparent" ? " drop-reparent" : "") +
          (isHover && dropMode === "child" ? " drop-child" : "") +
          (isHover && dropMode === "blocked" ? " drop-blocked" : "")
        }
        style={{ paddingLeft: 4 + node.depth * 16 }}
        draggable
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => onSelect(node.id)}
        title={node.id}
      >
        <button
          type="button"
          className="builder-tree-caret"
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) toggleExpand(node.id);
          }}
          aria-label={isExpanded ? "Collapse" : "Expand"}
          disabled={!hasChildren}
        >
          {hasChildren ? (isExpanded ? "▾" : "▸") : "·"}
        </button>
        <span className="builder-tree-icon" aria-hidden>
          {pluginIconFor(flow)}
        </span>
        <span className="builder-tree-label">
          <strong>{node.id}</strong>
          <span className="muted"> {pluginLabelFor(flow)}</span>
          {node.isJoin && <span className="tree-join-badge">join</span>}
        </span>
        {/* Primary-parent port chip — every non-root non-join row has one. */}
        {node.primaryEdge && (
          <PortChip
            edgeId={node.primaryEdge.edgeId}
            sourceId={node.primaryEdge.fromId}
            targetId={node.id}
            fromPort={node.primaryEdge.fromPort}
            toPort={node.primaryEdge.toPort}
            nodes={nodes}
            manifestMap={manifestMap}
            onUpdateEdge={onUpdateEdge}
            variant="primary"
          />
        )}
        {/* Inline "→ target" pills for every outgoing edge into a hoisted
            join. Clicking a pill scrolls the hoisted row into view and
            selects it — the same row that lists every contributing edge
            (with editable port chips). Hovering a pill previews the
            hoisted row by lighting it up. */}
        {node.joinRefs.length > 0 && (
          <span className="tree-link-pills">
            {node.joinRefs.map((jr, i) => {
              const isJoinSelected = jr.targetId === selectedId;
              return (
                <button
                  type="button"
                  key={"link:" + (jr.edgeId ?? `${jr.targetId}:${i}`)}
                  className={
                    "tree-link-pill" + (isJoinSelected ? " selected" : "")
                  }
                  title={`Jump to ${jr.targetId}`}
                  onMouseEnter={() => setLinkHoverId(jr.targetId)}
                  onMouseLeave={() => setLinkHoverId(null)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(jr.targetId);
                    revealNode(jr.targetId);
                  }}
                >
                  → {jr.targetId}
                </button>
              );
            })}
          </span>
        )}
      </div>

      {/* Cross-refs: every additional incoming edge to this row. On a
          join row these are the FULL parent list; on a regular row they
          show cycle back-edges. Rendered as their own indented leaves
          so each gets its own port chip. */}
      {isExpanded &&
        node.crossRefs.map((ref, i) => (
          <div
            key={"cr:" + (ref.edgeId ?? `${ref.fromId}:${i}`)}
            className="builder-tree-subrow builder-tree-crossref"
            style={{ paddingLeft: 4 + (node.depth + 1) * 16 }}
          >
            <span className="tree-sub-icon" aria-hidden>
              ←
            </span>
            <span className="builder-tree-label">
              <strong>{ref.fromId}</strong>
              <span className="muted"> incoming</span>
            </span>
            <PortChip
              edgeId={ref.edgeId}
              sourceId={ref.fromId}
              targetId={node.id}
              fromPort={ref.fromPort}
              toPort={ref.toPort}
              nodes={nodes}
              manifestMap={manifestMap}
              onUpdateEdge={onUpdateEdge}
              variant="ref"
            />
          </div>
        ))}

      {/* Recursive children — primary-parent flows. */}
      {isExpanded &&
        node.children.map((child) => (
          <Row key={child.id} {...props} node={child} />
        ))}
    </>
  );
}

export function BuilderTree(props: BuilderTreeProps) {
  const { nodes, edges, selectedId, onSelect, onDelete } = props;
  const tree = useMemo(
    () =>
      projectGraphToTree(
        nodes.map((n) => n.id),
        edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle,
          targetHandle: e.targetHandle
        }))
      ),
    [nodes, edges]
  );

  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>();
    function walk(t: TreeNode): void {
      s.add(t.id);
      for (const c of t.children) walk(c);
    }
    for (const r of tree.roots) walk(r);
    return s;
  });
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  useMemo(() => {
    const e = expandedRef.current;
    let dirty = false;
    function walk(t: TreeNode): void {
      if (
        !e.has(t.id) &&
        (t.children.length > 0 || t.joinRefs.length > 0 || t.crossRefs.length > 0)
      ) {
        e.add(t.id);
        dirty = true;
      }
      for (const c of t.children) walk(c);
    }
    for (const r of tree.roots) walk(r);
    if (dirty) setExpanded(new Set(e));
  }, [tree]);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const [dragId, setDragId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [linkHoverId, setLinkHoverId] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);
  // Reveal a row by id: scroll it into view + add a 'flashing' class for
  // ~700ms so the user sees which row a `→ target` pill points at.
  const revealNode = useCallback((id: string) => {
    const el = treeRef.current?.querySelector<HTMLElement>(
      `[data-tree-node-id="${id}"]`
    );
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("flashing");
    window.setTimeout(() => el.classList.remove("flashing"), 700);
  }, []);

  const pipelineNodeFor = useCallback(
    (id: string) => nodes.find((n) => n.id === id),
    [nodes]
  );
  const pluginLabelFor = useCallback((n: Node | undefined): string => {
    const pn = (n?.data as { node?: { plugin?: { id?: string }; type?: string } })
      ?.node;
    if (!pn) return "";
    if (pn.type === "input") return "input";
    if (pn.type === "output") return "output";
    return pn.plugin?.id ?? "(unconfigured)";
  }, []);
  const pluginIconFor = useCallback((n: Node | undefined): string => {
    const pn = (n?.data as { node?: { plugin?: { category?: string }; type?: string } })
      ?.node;
    if (!pn) return "•";
    if (pn.type === "input") return "▶";
    if (pn.type === "output") return "■";
    const cat = pn.plugin?.category ?? "";
    const map: Record<string, string> = {
      datasource: "📥",
      transformer: "🔀",
      chunker: "📃",
      embedder: "🧬",
      vector_store: "🗄",
      retriever: "🔍",
      prompt_template: "📝",
      llm: "🤖",
      reranker: "🎯",
      sink: "📤",
      output_parser: "🧩",
      parser: "🧩",
      loader: "📄",
      tool: "🛠",
      router: "🔁",
      control: "🔁",
      memory: "🧠",
      guardrail: "🛡",
      evaluator: "✅"
    };
    return map[cat] ?? "•";
  }, []);

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

  const handleRootDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (event.defaultPrevented) return;
      const raw = event.dataTransfer.getData(DND_MIME);
      const item = decodePaletteDrag(raw);
      if (!item) return;
      event.preventDefault();
      props.onAddChild("", item);
    },
    [props]
  );

  return (
    <div
      ref={treeRef}
      className="builder-tree"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleRootDrop}
    >
      <header className="builder-tree-head">
        <span className="muted">
          {nodes.length} node{nodes.length === 1 ? "" : "s"}
        </span>
        <span className="muted builder-tree-hint">
          drag plugins from the palette to add · drag a row onto another to
          re-parent · click a port chip to rewire · click a → pill to jump
          to its join · Delete to remove
        </span>
      </header>
      {tree.roots.length === 0 ? (
        <p className="muted" style={{ padding: 16 }}>
          Drop a node from the palette to start.
        </p>
      ) : (
        tree.roots.map((root) => (
          <Row
            key={root.id}
            node={root}
            selectedId={selectedId}
            expanded={expanded}
            toggleExpand={toggleExpand}
            onSelect={onSelect}
            pipelineNodeFor={pipelineNodeFor}
            pluginLabelFor={pluginLabelFor}
            pluginIconFor={pluginIconFor}
            dragId={dragId}
            setDragId={setDragId}
            hoverId={hoverId}
            setHoverId={setHoverId}
            onAddChild={props.onAddChild}
            onReparent={props.onReparent}
            tree={tree}
            nodes={nodes}
            manifestMap={props.pluginManifestMap}
            onUpdateEdge={props.onUpdateEdge}
            linkHoverId={linkHoverId}
            setLinkHoverId={setLinkHoverId}
            revealNode={revealNode}
          />
        ))
      )}
    </div>
  );
}
