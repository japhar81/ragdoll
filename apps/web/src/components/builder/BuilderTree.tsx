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
 */
import { useMemo, useState, useCallback, useRef } from "react";
import type { Node, Edge } from "reactflow";
import {
  projectGraphToTree,
  isDescendant,
  type TreeNode
} from "../../lib/treeProjection.ts";
import { type PaletteDragItem, decodePaletteDrag } from "../../lib/palette.ts";
import { DND_MIME } from "../../lib/graph.ts";

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
}

/** Per-row drop hint, surfaced as a visual indicator while dragging. */
type DropMode = "child" | "reparent" | "blocked" | null;

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
}

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
    tree
  } = props;
  const flow = pipelineNodeFor(node.id);
  const isExpanded = expanded.has(node.id);
  const hasChildren = node.children.length > 0;
  const isSelected = node.id === selectedId;
  const isHover = node.id === hoverId;

  // Decide which kind of drop the row would accept given the *current* drag.
  // Computed at hover time so we can show a hint chip and refuse cycles.
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
      // Tree-move (internal) takes precedence — a drag-started node always
      // sets that MIME; checking it first avoids treating a stray palette
      // item as a re-parent.
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
        // Auto-expand the drop target so the new child is visible.
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
        className={
          "builder-tree-row" +
          (isSelected ? " selected" : "") +
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
        </span>
        {node.crossRefs.length > 0 && (
          <span className="builder-tree-refs" title="Additional inputs">
            {node.crossRefs.map((ref, i) => (
              <span key={i} className="builder-tree-ref">
                ← {ref.fromId}
                {ref.fromPort ? `:${ref.fromPort}` : ""}
              </span>
            ))}
          </span>
        )}
      </div>
      {isExpanded &&
        node.children.map((child) => (
          <Row
            key={child.id}
            {...props}
            node={child}
          />
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
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle,
          targetHandle: e.targetHandle
        }))
      ),
    [nodes, edges]
  );

  // Open every node by default so a freshly-loaded pipeline reveals its
  // structure; once the user collapses something we honor that choice.
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

  // Auto-add new nodes to the expanded set so a drop reveals its result.
  // Pure side effect of `tree` growing — never collapses anything.
  useMemo(() => {
    const e = expandedRef.current;
    let dirty = false;
    function walk(t: TreeNode): void {
      if (!e.has(t.id) && t.children.length > 0) {
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
    // A tiny mnemonic per category — purely cosmetic.
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

  // Keyboard delete: while a node is selected and focus is in the tree,
  // Delete/Backspace removes it. Backspace alone would interfere with
  // input fields in the inspector, so we only listen on the tree pane.
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

  // Root-level drop catches palette items dropped outside any row so a
  // new node still lands somewhere visible (it becomes a new root).
  const handleRootDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      // Only act when the drop wasn't already handled by a row.
      if (event.defaultPrevented) return;
      const raw = event.dataTransfer.getData(DND_MIME);
      const item = decodePaletteDrag(raw);
      if (!item) return;
      event.preventDefault();
      // Adding "to root" still uses onAddChild with a synthetic non-id;
      // the parent component knows to treat "" as "no parent, just add".
      props.onAddChild("", item);
    },
    [props]
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
          {nodes.length} node{nodes.length === 1 ? "" : "s"}
        </span>
        <span className="muted builder-tree-hint">
          drag plugins from the palette to add · drag a row onto another to
          re-parent · Delete to remove
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
          />
        ))
      )}
    </div>
  );
}
