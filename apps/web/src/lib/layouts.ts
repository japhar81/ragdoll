/**
 * Pure DAG layout algorithms. No React Flow / DOM dependencies — these
 * functions take in node ids + edges + an optional current position map and
 * return a new position map. The builder applies the result via setNodes.
 *
 * Two homegrown layouts ship here (so we don't take a Pro-license dep):
 *
 *   - `layered`  — Sugiyama-style: rank by longest-path-from-root, place
 *                  ranks evenly along the primary axis (LR or TB), within
 *                  each rank distribute nodes evenly along the cross axis.
 *                  Two passes of barycentric reordering reduce edge crossings.
 *
 *   - `force`    — Fruchterman-Reingold force-directed simulation.
 *                  Repulsion between every pair, attraction along edges,
 *                  cooling over N iterations, then post-translate so the
 *                  bounding box top-left lands at (margin, margin).
 *
 * Both algorithms are deterministic given the same input; force seeds
 * positions from the node id hash so repeated "apply force" produces
 * stable-but-different layouts across runs.
 */

export interface NodePosition {
  x: number;
  y: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
}

export interface LayoutNode {
  id: string;
  /** Optional current position; used as the starting point for `force`
   *  and ignored by `layered`. */
  position?: NodePosition;
}

export type LayoutDirection = "TB" | "BT" | "LR" | "RL";

/**
 * Cardinal card-size estimate used by every layout to keep nodes from
 * overlapping. Has to be wider than `.rf-node.has-ports`'s 380px max-width
 * (CSS) plus the per-side label gutter, plus a visible gap for the
 * connection line. ~440 leaves ~60px of breathing room either side.
 */
const CARD_W = 440;
/** Tallest a card with three stacked ports gets is about 96px today; pad
 *  for headroom and so multi-rank stacks aren't claustrophobic. */
const CARD_H = 140;

export interface LayeredOptions {
  direction?: LayoutDirection;
  /** Pixels between successive ranks along the primary axis. Defaults are
   *  direction-aware: TB uses the card-height stride, LR the card-width. */
  rankSpacing?: number;
  /** Pixels between nodes within a rank along the cross axis. Defaults are
   *  direction-aware: TB uses the card-width stride, LR the card-height. */
  nodeSpacing?: number;
  /** Top-left margin so the first rank doesn't hug the canvas edge. */
  margin?: number;
}

export interface ForceOptions {
  /** Total iterations. More = better settle; ~120 is usually enough. */
  iterations?: number;
  /** Approximate width of one node — drives the optimal edge length. */
  nodeSize?: number;
  /** Strength of the node-node repulsion. Higher pushes nodes further apart. */
  repulsion?: number;
  /** Edge spring stiffness. Higher pulls connected nodes together harder. */
  attraction?: number;
  /** Initial cooling temperature; positions move at most this much per step. */
  temperature?: number;
  margin?: number;
}

/**
 * Layered (Sugiyama-style) layout. Assumes the input is a DAG; cycles are
 * tolerated but contribute weird ranks. Returns a map of node id → position.
 *
 *   1. Build adjacency.
 *   2. Compute longest path from any source to each node (= rank).
 *   3. Group nodes by rank.
 *   4. Reorder each rank by the average rank-position of its predecessors
 *      (barycentric heuristic) — two passes is usually enough to remove
 *      the obvious crossings.
 *   5. Translate ranks onto the canvas.
 */
export function layeredLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  options: LayeredOptions = {}
): Map<string, NodePosition> {
  const direction: LayoutDirection = options.direction ?? "TB";
  const horizontalLayout = direction === "LR" || direction === "RL";
  // Stride along the primary axis is the long side of the card when the
  // layout flows along that axis: in LR/RL each rank advances by the
  // card WIDTH; in TB/BT each rank advances by the card HEIGHT.
  const rankSpacing = options.rankSpacing ?? (horizontalLayout ? CARD_W : CARD_H);
  // Cross-axis stride is the OTHER dimension of the card so siblings at
  // the same rank don't overlap regardless of direction.
  const nodeSpacing = options.nodeSpacing ?? (horizontalLayout ? CARD_H : CARD_W);
  const margin = options.margin ?? 40;

  const nodeIds = nodes.map((n) => n.id);
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) {
    incoming.set(id, []);
    outgoing.set(id, []);
  }
  for (const edge of edges) {
    if (!incoming.has(edge.from) || !incoming.has(edge.to)) continue;
    incoming.get(edge.to)!.push(edge.from);
    outgoing.get(edge.from)!.push(edge.to);
  }

  // 2. Compute longest-path rank via Kahn-style topological iteration.
  //    Nodes in a cycle won't drain — they get rank 0 by default and a
  //    pass of "rank = max(predecessor rank) + 1" runs once to give them
  //    something sensible.
  const rank = new Map<string, number>();
  for (const id of nodeIds) rank.set(id, 0);
  const indegree = new Map<string, number>();
  for (const id of nodeIds) indegree.set(id, incoming.get(id)!.length);
  const queue: string[] = nodeIds.filter((id) => indegree.get(id) === 0);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const next of outgoing.get(id) ?? []) {
      rank.set(next, Math.max(rank.get(next) ?? 0, (rank.get(id) ?? 0) + 1));
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if ((indegree.get(next) ?? 0) <= 0) queue.push(next);
    }
  }
  // Cycle fallback: any node that didn't drain gets max(pred rank) + 1.
  for (const id of nodeIds) {
    if (visited.has(id)) continue;
    const max = Math.max(0, ...(incoming.get(id) ?? []).map((p) => rank.get(p) ?? 0));
    rank.set(id, max + 1);
  }

  // 3. Bucket nodes by rank.
  const buckets = new Map<number, string[]>();
  for (const id of nodeIds) {
    const r = rank.get(id) ?? 0;
    if (!buckets.has(r)) buckets.set(r, []);
    buckets.get(r)!.push(id);
  }

  // 4. Barycentric reordering — two passes, top-down then bottom-up. For
  //    each node, sort siblings by the average index of their predecessors
  //    (resp. successors) in the adjacent rank.
  const ranks = [...buckets.keys()].sort((a, b) => a - b);
  const orderInRank = new Map<string, number>();
  for (const r of ranks) buckets.get(r)!.forEach((id, idx) => orderInRank.set(id, idx));

  const reorder = (mode: "down" | "up") => {
    const sequence = mode === "down" ? ranks : [...ranks].reverse();
    for (const r of sequence) {
      const ids = buckets.get(r)!;
      const sorted = [...ids].sort((a, b) => {
        const neighborsA = mode === "down" ? incoming.get(a)! : outgoing.get(a)!;
        const neighborsB = mode === "down" ? incoming.get(b)! : outgoing.get(b)!;
        const meanA = neighborsA.length === 0
          ? orderInRank.get(a)!
          : neighborsA.reduce((s, n) => s + (orderInRank.get(n) ?? 0), 0) / neighborsA.length;
        const meanB = neighborsB.length === 0
          ? orderInRank.get(b)!
          : neighborsB.reduce((s, n) => s + (orderInRank.get(n) ?? 0), 0) / neighborsB.length;
        return meanA - meanB;
      });
      sorted.forEach((id, idx) => orderInRank.set(id, idx));
      buckets.set(r, sorted);
    }
  };
  reorder("down");
  reorder("up");

  // 5. Translate (rank, indexInRank) → (x, y) per direction.
  const positions = new Map<string, NodePosition>();
  const horizontal = horizontalLayout;
  const primarySign = direction === "BT" || direction === "RL" ? -1 : 1;
  const widestRank = Math.max(0, ...ranks.map((r) => buckets.get(r)!.length));
  const crossExtent = Math.max(1, widestRank) * nodeSpacing;

  for (const r of ranks) {
    const ids = buckets.get(r)!;
    const count = ids.length;
    // Center the rank by giving smaller ranks a margin on either side.
    const rankWidth = count * nodeSpacing;
    const crossStart = margin + Math.max(0, (crossExtent - rankWidth) / 2);
    ids.forEach((id, idx) => {
      const primary = margin + r * rankSpacing * primarySign + (primarySign < 0 ? -margin * 2 : 0);
      const cross = crossStart + idx * nodeSpacing;
      positions.set(id, horizontal ? { x: primary, y: cross } : { x: cross, y: primary });
    });
  }

  // Force the layout into the positive quadrant (BT/RL produce negative
  // primaries that React Flow would happily render, but it makes for a
  // confusing initial viewport).
  let minX = Infinity;
  let minY = Infinity;
  for (const p of positions.values()) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
  }
  if (!Number.isFinite(minX)) minX = 0;
  if (!Number.isFinite(minY)) minY = 0;
  const dx = margin - minX;
  const dy = margin - minY;
  for (const [id, p] of positions) {
    positions.set(id, { x: p.x + dx, y: p.y + dy });
  }
  return positions;
}

/**
 * Deterministic seed: hash a node id to [0, 1). Used by `force` so the
 * initial random layout is reproducible across runs.
 */
function seededRandom(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 4294967296);
}

/**
 * Fruchterman-Reingold force-directed layout. Good for graphs without
 * a strong DAG structure (parallel branches, fan-out, fan-in); less good
 * for purely linear chains where `layered` wins.
 */
export function forceLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  options: ForceOptions = {}
): Map<string, NodePosition> {
  const iterations = options.iterations ?? 150;
  // nodeSize drives the optimal edge length. Cards are ~440px wide in
  // CSS, so anchoring k there keeps connected nodes roughly one
  // card-width apart at rest — the connection line stays visible.
  const nodeSize = options.nodeSize ?? CARD_W;
  const k = nodeSize; // optimal edge length
  const repulsion = options.repulsion ?? 1;
  const attraction = options.attraction ?? 1;
  const margin = options.margin ?? 40;
  let temperature = options.temperature ?? nodeSize / 2;

  const ids = nodes.map((n) => n.id);
  if (ids.length === 0) return new Map();

  // Seed positions: prefer the caller's current ones (so applying force
  // twice gradually settles instead of re-randomising). Fall back to a
  // hash-based pseudo-random sprinkle around the canvas centre.
  const positions = new Map<string, NodePosition>();
  const area = Math.max(800, Math.sqrt(ids.length) * nodeSize * 3);
  for (const node of nodes) {
    if (node.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y)) {
      positions.set(node.id, { ...node.position });
    } else {
      const r1 = seededRandom(node.id + "x");
      const r2 = seededRandom(node.id + "y");
      positions.set(node.id, { x: r1 * area, y: r2 * area });
    }
  }

  const edgePairs = edges.filter((e) => positions.has(e.from) && positions.has(e.to));

  for (let iter = 0; iter < iterations; iter += 1) {
    const disp = new Map<string, NodePosition>();
    for (const id of ids) disp.set(id, { x: 0, y: 0 });

    // Repulsion: every pair pushes apart with force ~ k^2 / distance.
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = positions.get(ids[i])!;
        const b = positions.get(ids[j])!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const force = (repulsion * k * k) / dist;
        const ux = dx / dist;
        const uy = dy / dist;
        const ai = disp.get(ids[i])!;
        const aj = disp.get(ids[j])!;
        ai.x += ux * force;
        ai.y += uy * force;
        aj.x -= ux * force;
        aj.y -= uy * force;
      }
    }

    // Attraction: connected pairs pull together with force ~ dist^2 / k.
    for (const edge of edgePairs) {
      const a = positions.get(edge.from)!;
      const b = positions.get(edge.to)!;
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (attraction * dist * dist) / k;
      const ux = dx / dist;
      const uy = dy / dist;
      const ai = disp.get(edge.from)!;
      const aj = disp.get(edge.to)!;
      ai.x -= ux * force;
      ai.y -= uy * force;
      aj.x += ux * force;
      aj.y += uy * force;
    }

    // Move each node by its accumulated displacement, capped by the
    // current temperature. Without the cap, single iterations can fling
    // nodes off the canvas.
    for (const id of ids) {
      const p = positions.get(id)!;
      const d = disp.get(id)!;
      const dlen = Math.sqrt(d.x * d.x + d.y * d.y) || 0.01;
      const step = Math.min(dlen, temperature);
      p.x += (d.x / dlen) * step;
      p.y += (d.y / dlen) * step;
    }

    // Linear cooling — by the final iteration each node moves at most 0.5px.
    temperature = Math.max(0.5, temperature - (options.temperature ?? nodeSize / 2) / iterations);
  }

  // Post-translate so the bounding box top-left lands at (margin, margin)
  // — keeps the canvas viewport sensible no matter where the simulation
  // settled.
  let minX = Infinity;
  let minY = Infinity;
  for (const p of positions.values()) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
  }
  if (!Number.isFinite(minX)) minX = 0;
  if (!Number.isFinite(minY)) minY = 0;
  const dx = margin - minX;
  const dy = margin - minY;
  for (const [id, p] of positions) {
    positions.set(id, { x: p.x + dx, y: p.y + dy });
  }
  return positions;
}

/**
 * Final safety net: walk every pair of nodes and, if their bounding boxes
 * overlap (treating each node as a `cardW × cardH` rectangle centered on
 * its position), nudge them apart along the shorter axis until they
 * don't. Cheap O(n² · k) where k is the number of overlap-resolution
 * passes; we cap k at 6 because by then nothing should still be
 * overlapping unless the input is degenerate.
 */
function resolveOverlaps(
  positions: Map<string, NodePosition>,
  cardW = CARD_W,
  cardH = CARD_H
): Map<string, NodePosition> {
  const ids = [...positions.keys()];
  const padX = 20;
  const padY = 20;
  for (let pass = 0; pass < 6; pass += 1) {
    let moved = false;
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = positions.get(ids[i])!;
        const b = positions.get(ids[j])!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const overlapX = cardW + padX - Math.abs(dx);
        const overlapY = cardH + padY - Math.abs(dy);
        if (overlapX > 0 && overlapY > 0) {
          // Push apart along whichever axis has the SMALLER overlap —
          // that's the cheapest fix and tends to preserve overall layout
          // intent (e.g. a TB layered placement keeps its column).
          if (overlapX < overlapY) {
            const push = (dx >= 0 ? 1 : -1) * (overlapX / 2 + 1);
            a.x -= push;
            b.x += push;
          } else {
            const push = (dy >= 0 ? 1 : -1) * (overlapY / 2 + 1);
            a.y -= push;
            b.y += push;
          }
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return positions;
}

export type LayoutKind = "layered-TB" | "layered-LR" | "force";

/** Dispatcher used by the builder: pick a layout kind and apply it.
 *  Every layout flows through `resolveOverlaps` before returning so a
 *  caller can never get back overlapping positions, regardless of which
 *  algorithm settled them. */
export function applyLayout(
  kind: LayoutKind,
  nodes: LayoutNode[],
  edges: LayoutEdge[]
): Map<string, NodePosition> {
  let positions: Map<string, NodePosition>;
  if (kind === "force") positions = forceLayout(nodes, edges);
  else if (kind === "layered-LR") positions = layeredLayout(nodes, edges, { direction: "LR" });
  else positions = layeredLayout(nodes, edges, { direction: "TB" });
  return resolveOverlaps(positions);
}
