/**
 * Pure helper that projects a pipeline DAG onto a FinalBuilder-style tree.
 *
 * The runtime model is a DAG — nodes may have multiple parents, and the
 * Builder canvas renders that DAG directly. The Tree View needs ONE
 * canonical position per node, so the projector picks each node's "primary
 * parent" (the first source encountered while walking the graph) and shows
 * every other incoming edge as a `crossRef` row beneath the parent the
 * tree did pick. Nothing is hidden — the DAG is fully recoverable from
 * the tree.
 *
 * No React / DOM imports so this is unit-testable with `node --test` and
 * zero install.
 */

/** Minimal edge shape — matches React Flow Edge as well as our internal
 *  PipelineSpec edge once `sourceHandle`/`targetHandle` are mapped onto
 *  `fromPort`/`toPort`. */
export interface ProjEdge {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

/** One reference to a non-primary parent → child join, rendered inline so
 *  the tree never silently drops a real edge. */
export interface CrossRef {
  /** The other source node id (the one not picked as primary parent). */
  fromId: string;
  fromPort?: string | null;
  toPort?: string | null;
}

export interface TreeNode {
  /** Pipeline node id. */
  id: string;
  /** Indent level (0 = root). */
  depth: number;
  /** True when this node ALSO appears earlier in the tree under a
   *  different primary parent — should never be true for a freshly
   *  projected forest, but kept for symmetry with future "show full
   *  fan-in" features. */
  isPlaceholder: boolean;
  /** Children whose primary-parent edge originates at this node. */
  children: TreeNode[];
  /** Every non-primary incoming edge → rendered inline so the tree never
   *  hides a real wire. Empty when the node has at most one parent. */
  crossRefs: CrossRef[];
}

export interface ProjectedTree {
  /** Forest of nodes with no incoming edges (or chosen as roots when a
   *  whole component is cycle-only). */
  roots: TreeNode[];
}

/** Stable id-sort so two equivalent graphs project to the same tree. */
function byId(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * Build the tree. Algorithm:
 *
 * 1. Collect outgoing edges per source and the in-degree of every node.
 * 2. Roots = nodes with in-degree 0, sorted by id for stability.
 * 3. If a graph has no roots (all components are cycles), promote the
 *    lowest-id node in each unvisited component to a root so nothing is
 *    lost.
 * 4. BFS from each root: the first time we touch a node, the visitor
 *    becomes its primary parent and the node is enqueued. Every
 *    subsequent edge into the same node becomes a `crossRef` recorded on
 *    THIS step (so the user sees the join inline near where the data
 *    arrives, not back where it diverged).
 */
export function projectGraphToTree(
  nodeIds: readonly string[],
  edges: readonly ProjEdge[]
): ProjectedTree {
  const ids = [...nodeIds];
  const allowed = new Set(ids);

  // Out + in adjacency keyed by source/target. Edges referencing unknown
  // ids are dropped — defensive against half-built specs.
  const out = new Map<string, ProjEdge[]>();
  const inDeg = new Map<string, number>();
  for (const id of ids) {
    out.set(id, []);
    inDeg.set(id, 0);
  }
  for (const e of edges) {
    if (!allowed.has(e.source) || !allowed.has(e.target)) continue;
    out.get(e.source)!.push(e);
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
  }

  // Sort each node's outgoing edges by target id so children render in a
  // stable order regardless of the underlying edge insertion sequence.
  for (const list of out.values()) {
    list.sort((a, b) => byId(a.target, b.target));
  }

  const primaryParent = new Map<string, string>();
  const crossRefs = new Map<string, CrossRef[]>();
  const visited = new Set<string>();
  const childrenOf = new Map<string, string[]>();
  for (const id of ids) childrenOf.set(id, []);

  function enqueueRoots(): string[] {
    const queue = ids
      .filter((id) => (inDeg.get(id) ?? 0) === 0)
      .sort(byId);
    if (queue.length > 0) return queue;
    // Cycle-only graph: pick the lowest-id node and let BFS unwind from it.
    // Anything in another cycle component is picked up by the unreachable
    // sweep below.
    return ids.length > 0 ? [ids.slice().sort(byId)[0]] : [];
  }

  function bfs(start: string): void {
    const queue: string[] = [];
    if (visited.has(start)) return;
    visited.add(start);
    queue.push(start);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of out.get(current) ?? []) {
        if (!visited.has(edge.target)) {
          visited.add(edge.target);
          primaryParent.set(edge.target, current);
          childrenOf.get(current)!.push(edge.target);
          queue.push(edge.target);
          continue;
        }
        // Non-primary edge into an already-placed node: record an inline
        // cross-reference under the destination so the user sees the join
        // where the data actually arrives.
        const existing = crossRefs.get(edge.target) ?? [];
        existing.push({
          fromId: current,
          fromPort: edge.sourceHandle ?? null,
          toPort: edge.targetHandle ?? null
        });
        crossRefs.set(edge.target, existing);
      }
    }
  }

  for (const root of enqueueRoots()) bfs(root);
  // Sweep any component the in-degree heuristic missed (e.g. a separate
  // cycle disconnected from every root). Promote the lowest-id unvisited
  // node and BFS from it; repeat until every node is placed.
  for (const id of ids.slice().sort(byId)) {
    if (!visited.has(id)) bfs(id);
  }

  // Materialise the tree depth-first from the root set so children come
  // out in BFS order.
  function build(id: string, depth: number): TreeNode {
    const refs = crossRefs.get(id) ?? [];
    return {
      id,
      depth,
      isPlaceholder: false,
      children: (childrenOf.get(id) ?? []).map((childId) =>
        build(childId, depth + 1)
      ),
      crossRefs: refs
    };
  }

  const rootIds = ids
    .filter((id) => !primaryParent.has(id) && visited.has(id))
    .sort(byId);
  return { roots: rootIds.map((id) => build(id, 0)) };
}

/** True when `candidate` is reachable from `start` via the primary-parent
 *  tree only — used to refuse drops that would create a cycle. */
export function isDescendant(
  tree: ProjectedTree,
  startId: string,
  candidateId: string
): boolean {
  const visited = new Set<string>();
  function walk(node: TreeNode): boolean {
    if (visited.has(node.id)) return false;
    visited.add(node.id);
    if (node.id === candidateId) return true;
    for (const child of node.children) if (walk(child)) return true;
    return false;
  }
  const start = findNode(tree, startId);
  return start ? walk(start) : false;
}

/** Locate a TreeNode by id (DFS). Returns undefined when the id is not in
 *  the projection — typical for a freshly-deleted node a stale handler
 *  still references. */
export function findNode(
  tree: ProjectedTree,
  id: string
): TreeNode | undefined {
  function walk(node: TreeNode): TreeNode | undefined {
    if (node.id === id) return node;
    for (const child of node.children) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return undefined;
  }
  for (const root of tree.roots) {
    const hit = walk(root);
    if (hit) return hit;
  }
  return undefined;
}
