/**
 * Topological-layer projector used by the Stages view.
 *
 * Stage = longest path from any root to a given node. Nodes in the same
 * stage are independent (their inputs are all in earlier stages) and so
 * can run in parallel. Reading the projection top-to-bottom is reading
 * the pipeline in execution order; parallel pipelines naturally align
 * side-by-side and convergence nodes land at the bottom of the deepest
 * branch they consume.
 *
 * Cycle-safe: cycle members are pinned to the last cycle stage so the
 * projection never loops. Pure / DOM-free.
 */

export interface StagesEdge {
  source: string;
  target: string;
}

export interface Stage {
  /** 0-indexed stage number — stage 0 is the roots, stage N runs after
   *  every node in stages 0..N-1. */
  index: number;
  /** Node ids in this stage, sorted lexically for stable output. */
  nodeIds: string[];
}

export interface StagesProjection {
  stages: Stage[];
}

function byId(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * Iteratively relax stage = max(deps.stage) + 1 starting from 0. Cycle
 * members never have all-resolved deps so they get pinned to
 * (maxResolvedStage + 1) on a final sweep — keeps the layout total
 * without losing nodes.
 */
export function projectStages(
  nodeIds: readonly string[],
  edges: readonly StagesEdge[]
): StagesProjection {
  const ids = [...nodeIds];
  const allowed = new Set(ids);

  // Build the dependency map (incoming edge → predecessor list).
  const deps = new Map<string, string[]>();
  for (const id of ids) deps.set(id, []);
  for (const e of edges) {
    if (!allowed.has(e.source) || !allowed.has(e.target)) continue;
    // Self-loops would never resolve; ignore (treated as cycle).
    if (e.source === e.target) continue;
    const list = deps.get(e.target)!;
    if (!list.includes(e.source)) list.push(e.source);
  }

  const stage = new Map<string, number>();
  // Roots start at stage 0.
  const queue: string[] = [];
  for (const id of ids) {
    if ((deps.get(id) ?? []).length === 0) {
      stage.set(id, 0);
      queue.push(id);
    }
  }

  // Iterate: a node's stage = max(deps' stages) + 1 once every dep has
  // resolved. Worst case O(V·E) which is fine for the DAG sizes the
  // builder cares about.
  let safety = ids.length * (ids.length + 1);
  while (queue.length > 0 && safety-- > 0) {
    const next: string[] = [];
    for (const id of ids) {
      if (stage.has(id)) continue;
      const ds = deps.get(id) ?? [];
      let maxDep = -1;
      let allResolved = true;
      for (const d of ds) {
        const s = stage.get(d);
        if (s === undefined) {
          allResolved = false;
          break;
        }
        if (s > maxDep) maxDep = s;
      }
      if (allResolved) {
        stage.set(id, maxDep + 1);
        next.push(id);
      }
    }
    if (next.length === 0) break;
    queue.length = 0;
    queue.push(...next);
  }

  // Cycle pin: any node not yet placed sits at one stage past the
  // deepest resolved stage, so cycles still appear in the rendering.
  let maxResolved = -1;
  for (const s of stage.values()) if (s > maxResolved) maxResolved = s;
  const cyclePin = maxResolved + 1;
  for (const id of ids) {
    if (!stage.has(id)) stage.set(id, cyclePin);
  }

  // Bucket into stage rows, sorted ascending; nodes within a stage are
  // id-sorted for stable rendering.
  const buckets = new Map<number, string[]>();
  for (const [id, s] of stage) {
    const list = buckets.get(s) ?? [];
    list.push(id);
    buckets.set(s, list);
  }
  const stages: Stage[] = [];
  const sortedStages = [...buckets.keys()].sort((a, b) => a - b);
  for (const idx of sortedStages) {
    const nodesInStage = buckets.get(idx)!.slice().sort(byId);
    stages.push({ index: stages.length, nodeIds: nodesInStage });
  }
  return { stages };
}
