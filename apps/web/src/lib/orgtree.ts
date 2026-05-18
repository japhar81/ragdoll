/**
 * Pure, DOM-free tree builders for the Pipelines screen (folder/pipeline
 * hierarchy) and the Config/Secrets scope navigator (Global -> Tenant ->
 * Pipeline), plus a small helper to render an activation's effective version.
 *
 * No React/DOM imports so this is unit-testable with `node --test`, zero
 * install.
 */

/** A folder node as returned (nested) by GET /api/folders. */
export interface FolderNode {
  id: string;
  parentId?: string | null;
  name: string;
  createdAt?: string;
  children?: FolderNode[];
}

/** Minimal pipeline shape the tree needs (id/name/folderId). */
export interface PipelineLike {
  id: string;
  slug?: string;
  name: string;
  folderId?: string | null;
  latestVersionId?: string | null;
}

/** A folder in the rendered tree, with its sub-folders and direct pipelines. */
export interface FolderTreeNode {
  id: string;
  name: string;
  parentId: string | null;
  depth: number;
  children: FolderTreeNode[];
  pipelines: PipelineLike[];
}

/** The full Pipelines tree: the folder forest plus root-level (uncategorized). */
export interface PipelineTree {
  folders: FolderTreeNode[];
  /** Pipelines with no folderId (or pointing at an unknown folder). */
  uncategorized: PipelineLike[];
}

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build the nested Pipelines tree. `folders` may arrive already-nested (the
 * documented GET /api/folders shape, children[]) OR as a flat list — both are
 * handled. Pipelines are bucketed under their folderId; any pipeline whose
 * folderId is null/unknown lands in `uncategorized`.
 */
export function buildFolderTree(
  pipelines: PipelineLike[],
  folders: FolderNode[]
): PipelineTree {
  // Flatten whatever we got into id -> {parentId,name} so we own the nesting.
  const flat = new Map<string, { id: string; parentId: string | null; name: string }>();
  const walk = (node: FolderNode, parentId: string | null): void => {
    flat.set(node.id, {
      id: node.id,
      parentId: node.parentId ?? parentId ?? null,
      name: node.name
    });
    for (const child of node.children ?? []) walk(child, node.id);
  };
  for (const f of folders) walk(f, f.parentId ?? null);

  const pipelinesByFolder = new Map<string, PipelineLike[]>();
  const uncategorized: PipelineLike[] = [];
  for (const p of pipelines) {
    const fid = p.folderId ?? null;
    if (fid && flat.has(fid)) {
      const list = pipelinesByFolder.get(fid) ?? [];
      list.push(p);
      pipelinesByFolder.set(fid, list);
    } else {
      uncategorized.push(p);
    }
  }

  const childrenOf = new Map<string | null, string[]>();
  for (const { id, parentId } of flat.values()) {
    const key = parentId && flat.has(parentId) ? parentId : null;
    const list = childrenOf.get(key) ?? [];
    list.push(id);
    childrenOf.set(key, list);
  }

  const build = (id: string, depth: number): FolderTreeNode => {
    const meta = flat.get(id)!;
    const node: FolderTreeNode = {
      id,
      name: meta.name,
      parentId: meta.parentId && flat.has(meta.parentId) ? meta.parentId : null,
      depth,
      children: sortByName(
        (childrenOf.get(id) ?? []).map((cid) => build(cid, depth + 1))
      ),
      pipelines: sortByName(pipelinesByFolder.get(id) ?? [])
    };
    return node;
  };

  const roots = sortByName(
    (childrenOf.get(null) ?? []).map((id) => build(id, 0))
  );
  return { folders: roots, uncategorized: sortByName(uncategorized) };
}

/** Flatten the folder tree depth-first (handy for an indented <select>). */
export function flattenFolders(tree: PipelineTree): FolderTreeNode[] {
  const out: FolderTreeNode[] = [];
  const visit = (n: FolderTreeNode): void => {
    out.push(n);
    for (const c of n.children) visit(c);
  };
  for (const r of tree.folders) visit(r);
  return out;
}

/**
 * Detect whether moving `folderId` under `targetParentId` would create a
 * cycle (target is the folder itself or one of its descendants). Used to keep
 * reparent operations safe before hitting PUT /api/folders/:id.
 */
export function wouldCycle(
  tree: PipelineTree,
  folderId: string,
  targetParentId: string | null
): boolean {
  if (targetParentId === null) return false;
  if (targetParentId === folderId) return true;
  const find = (nodes: FolderTreeNode[]): FolderTreeNode | undefined => {
    for (const n of nodes) {
      if (n.id === folderId) return n;
      const hit = find(n.children);
      if (hit) return hit;
    }
    return undefined;
  };
  const node = find(tree.folders);
  if (!node) return false;
  const stack = [...node.children];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur.id === targetParentId) return true;
    stack.push(...cur.children);
  }
  return false;
}

// ---- Config / Secrets scope navigator -----------------------------------

export type ScopeKind = "global" | "tenant" | "pipeline";

/** A node in the Global -> Tenant -> Pipeline scope tree. */
export interface ScopeNode {
  /** Stable key for React + selection. */
  key: string;
  label: string;
  scope: ScopeKind;
  /** scopeId to send to the API (undefined for the global root). */
  scopeId?: string;
  children: ScopeNode[];
}

export interface TenantLike {
  id: string;
  slug?: string;
  name: string;
}

/**
 * Build the scope navigator: a single Global root, each tenant beneath it,
 * and every pipeline beneath each tenant. Pipelines are shared across tenants
 * (the platform has no per-tenant pipeline list at this layer) so each tenant
 * lists the full pipeline set — selecting one yields scope="pipeline".
 */
export function buildScopeTree(
  tenants: TenantLike[],
  pipelines: PipelineLike[]
): ScopeNode {
  const sortedPipes = [...pipelines].sort((a, b) => a.name.localeCompare(b.name));
  const sortedTenants = [...tenants].sort((a, b) => a.name.localeCompare(b.name));
  return {
    key: "global",
    label: "Global",
    scope: "global",
    children: sortedTenants.map((t) => ({
      key: `tenant:${t.id}`,
      label: t.name,
      scope: "tenant" as const,
      scopeId: t.id,
      children: sortedPipes.map((p) => ({
        key: `tenant:${t.id}|pipeline:${p.id}`,
        label: p.name,
        scope: "pipeline" as const,
        scopeId: p.id,
        children: []
      }))
    }))
  };
}

/** Find a scope node by its key (depth-first). */
export function findScopeNode(root: ScopeNode, key: string): ScopeNode | undefined {
  if (root.key === key) return root;
  for (const c of root.children) {
    const hit = findScopeNode(c, key);
    if (hit) return hit;
  }
  return undefined;
}

// ---- Activation effective-version display -------------------------------

export interface ActivationLike {
  id: string;
  label: string;
  environment: string;
  pipelineVersionId?: string | null;
  trackLatest: boolean;
  enabled: boolean;
  effectiveVersionId?: string | null;
}

/**
 * Human label for what version an activation runs right now. Maps the raw
 * version id through `versionLabel` (e.g. id -> "1.2.0") when supplied.
 */
export function activationVersionLabel(
  act: ActivationLike,
  versionLabel?: (versionId: string) => string | undefined
): string {
  if (!act.enabled) return "disabled";
  const eff = act.effectiveVersionId;
  if (!eff) {
    return act.trackLatest ? "latest (unresolved)" : "unresolved";
  }
  const label = versionLabel?.(eff) ?? eff;
  return act.trackLatest ? `latest -> ${label}` : `pinned ${label}`;
}

/**
 * Aggregate GET /api/tenants/:id/pipelines results into a per-pipeline
 * rollup: which tenants run a given pipeline, through which activation, at
 * which effective version. Used by the Pipelines screen's rollup view.
 */
export interface TenantPipelinesResult {
  tenantId: string;
  pipelines: Array<{
    pipelineId: string;
    enabled: boolean;
    activations: ActivationLike[];
  }>;
}

export interface PipelineUsageRow {
  tenantId: string;
  pipelineId: string;
  associationEnabled: boolean;
  activationLabel: string;
  environment: string;
  effectiveVersionId: string | null;
  enabled: boolean;
}

export function rollupPipelineUsage(
  results: TenantPipelinesResult[],
  pipelineId: string
): PipelineUsageRow[] {
  const rows: PipelineUsageRow[] = [];
  for (const res of results) {
    for (const p of res.pipelines) {
      if (p.pipelineId !== pipelineId) continue;
      if (p.activations.length === 0) {
        rows.push({
          tenantId: res.tenantId,
          pipelineId,
          associationEnabled: p.enabled,
          activationLabel: "(no activations)",
          environment: "-",
          effectiveVersionId: null,
          enabled: false
        });
        continue;
      }
      for (const a of p.activations) {
        rows.push({
          tenantId: res.tenantId,
          pipelineId,
          associationEnabled: p.enabled,
          activationLabel: a.label,
          environment: a.environment,
          effectiveVersionId: a.effectiveVersionId ?? null,
          enabled: a.enabled
        });
      }
    }
  }
  return rows;
}
