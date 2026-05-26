import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.ts";
import {
  buildFolderTree,
  rollupPipelineUsage,
  type FolderTreeNode,
  type PipelineLike,
  type TenantPipelinesResult
} from "../lib/orgtree.ts";
import { Screen } from "./Screen.tsx";
import type { EditingPipeline } from "../App.tsx";
import type { PipelineVersionRow } from "../lib/api.ts";
import type { DatasetSlotRef, PipelineSpec } from "../lib/types.ts";
import { datasetColor } from "../lib/datasetColor.ts";
import { TenantSelect, useSelectedTenant } from "./useTenants.tsx";
import { useEnvironments, EnvironmentSelect } from "./useEnvironments.tsx";
import { DeployModal } from "./DeployModal.tsx";

/** Pull dataset slots straight off the spec — same shape `validatePipelineSpec`
 *  emits, but without re-running the whole validator just to find the slots. */
function extractDatasetSlots(spec: PipelineSpec): DatasetSlotRef[] {
  return (spec.spec?.nodes ?? [])
    .filter((n) => n.dataset?.slug)
    .map((n) => ({
      nodeId: n.id,
      slug: n.dataset!.slug,
      alias: n.dataset?.alias ?? "stable"
    }));
}

/**
 * Phase 11.2: render colored pills for every Dataset a pipeline
 * references, so two pipelines sharing a corpus are visually paired
 * at a glance. The pipeline's spec is fetched on demand (cheap — the
 * version row is already cached when the user expanded the folder)
 * and the dataset refs are pulled out of `spec.spec.nodes[i].dataset`.
 *
 * Hover surfaces the alias; clicking deep-links to the dataset's
 * `/datasets/:id` page (env > tenant > global, same as the runtime
 * resolver).
 */
function PipelineDatasetPills(props: { pipelineId: string }) {
  const navigate = useNavigate();
  const versions = useQuery({
    queryKey: ["pipeline-versions", props.pipelineId],
    queryFn: () => api.listVersions(props.pipelineId),
    staleTime: 30_000
  });
  // We need the dataset IDs (not just slugs) to deep-link. Cross-reference
  // the spec's slug+alias against the live datasets list so the pill knows
  // which dataset row to navigate to.
  const visibleDatasets = useQuery({
    queryKey: ["datasets-for-pills"],
    queryFn: () => api.listDatasets(),
    staleTime: 60_000
  });
  const refs = useMemo(() => {
    const out: Array<{ slug: string; alias?: string; datasetId?: string }> = [];
    const all = versions.data?.versions ?? [];
    const latestId = versions.data?.latestVersionId;
    const target = latestId
      ? all.find((v) => v.id === latestId) ?? all[0]
      : all[0];
    if (!target?.spec) return out;
    const spec = target.spec as PipelineSpec;
    const datasets = visibleDatasets.data?.datasets ?? [];
    const seen = new Set<string>();
    for (const node of spec.spec?.nodes ?? []) {
      const slug = node.dataset?.slug;
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      // Pick the narrowest-scoped dataset that matches the slug: env >
      // tenant > global. The resolver does the same at runtime, so the
      // pill points at the same row the executor would resolve to.
      const env = datasets.find(
        (d) => d.slug === slug && d.scope === "environment"
      );
      const tenant = datasets.find(
        (d) => d.slug === slug && d.scope === "tenant"
      );
      const global = datasets.find(
        (d) => d.slug === slug && d.scope === "global"
      );
      out.push({
        slug,
        alias: node.dataset?.alias,
        datasetId: (env ?? tenant ?? global)?.id
      });
    }
    return out;
  }, [versions.data, visibleDatasets.data]);
  if (refs.length === 0) return null;
  return (
    <span style={{ display: "inline-flex", gap: 4, marginLeft: 8 }}>
      {refs.map(({ slug, alias, datasetId }) => {
        const c = datasetColor(slug);
        const common = {
          title: `Dataset: ${slug}${alias ? ` @ ${alias}` : ""}${datasetId ? "" : " (not visible)"}`,
          style: {
            background: c.bg,
            color: c.fg,
            padding: "1px 6px",
            borderRadius: 8,
            fontSize: "0.8em"
          } as const
        };
        return datasetId ? (
          <button
            key={slug}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/datasets/${encodeURIComponent(datasetId)}`);
            }}
            {...common}
          >
            {slug}
          </button>
        ) : (
          <span key={slug} {...common}>
            {slug}
          </span>
        );
      })}
    </span>
  );
}

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { error?: string; message?: string } | undefined;
    return `HTTP ${e.status}: ${body?.message ?? body?.error ?? JSON.stringify(e.body)}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Pipelines: a nested folder/pipeline tree. Per folder you can create
 * sub-folders / pipelines, rename and delete (409 on non-empty is surfaced).
 * Per pipeline: Edit (hands the pipeline to the Builder which loads its
 * latest spec) and Revisions (version lineage + rollback).
 */
export function PipelinesScreen(props: {
  onEditPipeline: (p: EditingPipeline) => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [revisionsFor, setRevisionsFor] = useState<PipelineLike | undefined>();
  const [banner, setBanner] = useState<string | undefined>();

  // Run target — shared by the per-row "Run" button and (later) the Run-All
  // flow. Tenant + env default to the demo wiring so the bundled pipelines
  // run out of the box; pickers above the tree let the operator switch.
  const tenantCtx = useSelectedTenant();
  const envs = useEnvironments(tenantCtx.tenantId);
  const [environment, setEnvironment] = useState("dev");

  const pipelines = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => api.listPipelines()
  });
  const folders = useQuery({
    queryKey: ["folders"],
    queryFn: () => api.listFolders()
  });
  const tenants = useQuery({
    queryKey: ["tenants"],
    queryFn: () => api.listTenants()
  });

  // ---- Single-pipeline Run ---------------------------------------------
  // `runTarget` holds the pipeline + its latest spec while the DeployModal is
  // open. Loading happens in the click handler so the modal opens with the
  // dataset slots already resolved — no flicker.
  const [runTarget, setRunTarget] = useState<
    | {
        pipeline: PipelineLike;
        slots: DatasetSlotRef[];
      }
    | undefined
  >();
  const [runBusy, setRunBusy] = useState(false);

  async function openRunModal(p: PipelineLike) {
    if (!tenantCtx.ready) {
      setBanner("Select a tenant first (the run is scoped per tenant).");
      return;
    }
    setBanner(undefined);
    setRunBusy(true);
    try {
      const versions = await api.listVersions(p.id);
      const latestId = versions.latestVersionId;
      const target = latestId
        ? versions.versions.find((v) => v.id === latestId) ?? versions.versions[0]
        : versions.versions[0];
      if (!target?.spec) {
        setBanner(`Pipeline ${p.name} has no published version yet.`);
        return;
      }
      const spec = target.spec as PipelineSpec;
      const slots = extractDatasetSlots(spec);
      setRunTarget({ pipeline: p, slots });
    } catch (e) {
      setBanner(errText(e));
    } finally {
      setRunBusy(false);
    }
  }

  async function doRun() {
    if (!runTarget) return;
    const { pipeline } = runTarget;
    setRunBusy(true);
    try {
      const result = await api.run(pipeline.id, {
        input: {},
        environment
      });
      setRunTarget(undefined);
      // Hop the operator straight to the Executions screen with the new
      // run selected so they can watch the trace stream in.
      navigate(`/executions?selected=${encodeURIComponent(result.executionId)}`);
    } catch (e) {
      setBanner(errText(e));
    } finally {
      setRunBusy(false);
    }
  }

  // Aggregate every tenant's pipeline associations so we can show a
  // tenant <-> activation <-> version rollup per pipeline.
  const tenantPipelines = useQuery({
    queryKey: ["tenant-pipelines-all", tenants.data?.tenants?.map((t) => t.id)],
    enabled: Boolean(tenants.data),
    queryFn: async (): Promise<TenantPipelinesResult[]> => {
      const list = tenants.data?.tenants ?? [];
      const out: TenantPipelinesResult[] = [];
      for (const t of list) {
        try {
          const res = await api.listTenantPipelines(t.id);
          out.push({ tenantId: t.id, pipelines: res.pipelines });
        } catch {
          out.push({ tenantId: t.id, pipelines: [] });
        }
      }
      return out;
    }
  });

  const tree = useMemo(
    () =>
      buildFolderTree(
        (pipelines.data?.pipelines ?? []) as PipelineLike[],
        folders.data?.folders ?? []
      ),
    [pipelines.data, folders.data]
  );

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["pipelines"] });
    qc.invalidateQueries({ queryKey: ["folders"] });
  }

  const createFolder = useMutation({
    mutationFn: (input: { name: string; parentId: string | null }) =>
      api.createFolder(input),
    onSuccess: () => {
      setBanner(undefined);
      invalidate();
    },
    onError: (e) => setBanner(errText(e))
  });
  const renameFolder = useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      api.updateFolder(input.id, { name: input.name }),
    onSuccess: () => {
      setBanner(undefined);
      invalidate();
    },
    onError: (e) => setBanner(errText(e))
  });
  const deleteFolder = useMutation({
    mutationFn: (id: string) => api.deleteFolder(id),
    onSuccess: () => {
      setBanner(undefined);
      invalidate();
    },
    onError: (e) =>
      setBanner(
        e instanceof ApiError && e.status === 409
          ? "Folder not empty — move or delete its pipelines/sub-folders first."
          : errText(e)
      )
  });
  const createPipeline = useMutation({
    mutationFn: (input: { name: string; slug: string; folderId: string | null }) =>
      api.createPipeline(input),
    onSuccess: () => {
      setBanner(undefined);
      invalidate();
    },
    onError: (e) => setBanner(errText(e))
  });

  function onNewFolder(parentId: string | null) {
    const name = window.prompt("New folder name");
    if (name) createFolder.mutate({ name: name.trim(), parentId });
  }
  function onNewPipeline(folderId: string | null) {
    const name = window.prompt("New pipeline name");
    if (!name) return;
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
    createPipeline.mutate({ name: name.trim(), slug, folderId });
  }
  function onRenameFolder(node: FolderTreeNode) {
    const name = window.prompt("Rename folder", node.name);
    if (name && name.trim() !== node.name) {
      renameFolder.mutate({ id: node.id, name: name.trim() });
    }
  }
  function onDeleteFolder(node: FolderTreeNode) {
    if (window.confirm(`Delete folder "${node.name}"?`)) {
      deleteFolder.mutate(node.id);
    }
  }

  function PipelineRow(props2: { p: PipelineLike }) {
    const { p } = props2;
    return (
      <li className="tree-leaf">
        <span className="tree-ico">{"\u{1F4C4}"}</span>
        <span className="tree-name">{p.name}</span>
        <span className="muted">{p.slug ?? p.id}</span>
        <PipelineDatasetPills pipelineId={p.id} />
        <span className="tree-tools">
          <button
            className="link-btn"
            disabled={runBusy || !tenantCtx.ready}
            onClick={() => openRunModal(p)}
            title={
              !tenantCtx.ready
                ? "Select a tenant first."
                : "Run this pipeline against the selected tenant + environment"
            }
          >
            ▶ Run
          </button>
          <button
            className="link-btn"
            onClick={() => props.onEditPipeline({ id: p.id, name: p.name })}
          >
            Edit
          </button>
          <button className="link-btn" onClick={() => setRevisionsFor(p)}>
            Revisions
          </button>
        </span>
      </li>
    );
  }

  function FolderBranch(props2: { node: FolderTreeNode }) {
    const { node } = props2;
    return (
      <li>
        <div
          className="tree-folder"
          style={{ paddingLeft: node.depth * 16 }}
        >
          <span className="tree-ico">{"\u{1F4C1}"}</span>
          <strong>{node.name}</strong>
          <span className="tree-tools">
            <button className="link-btn" onClick={() => onNewFolder(node.id)}>
              + Folder
            </button>
            <button className="link-btn" onClick={() => onNewPipeline(node.id)}>
              + Pipeline
            </button>
            <button className="link-btn" onClick={() => onRenameFolder(node)}>
              Rename
            </button>
            <button className="link-btn" onClick={() => onDeleteFolder(node)}>
              Delete
            </button>
          </span>
        </div>
        <ul className="tree-list" style={{ paddingLeft: node.depth * 16 + 16 }}>
          {node.children.map((c) => (
            <FolderBranch key={c.id} node={c} />
          ))}
          {node.pipelines.map((p) => (
            <PipelineRow key={p.id} p={p} />
          ))}
          {node.children.length === 0 && node.pipelines.length === 0 && (
            <li className="muted">(empty)</li>
          )}
        </ul>
      </li>
    );
  }

  return (
    <Screen
      title="Pipelines"
      isLoading={pipelines.isLoading || folders.isLoading}
      error={pipelines.error ?? folders.error}
    >
      <div className="inline-form" style={{ flexWrap: "wrap" }}>
        <button onClick={() => onNewFolder(null)}>+ Root folder</button>
        <button onClick={() => onNewPipeline(null)}>+ Root pipeline</button>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <span className="muted">Run target:</span>
          <TenantSelect
            tenants={tenantCtx.tenants}
            value={tenantCtx.tenantId}
            onChange={tenantCtx.setTenantId}
            isLoading={tenantCtx.isLoading}
          />
          <EnvironmentSelect
            environments={envs.data?.environments ?? []}
            value={environment}
            onChange={setEnvironment}
            isLoading={envs.isLoading}
          />
        </span>
      </div>
      {banner && <p className="error">{banner}</p>}

      <ul className="tree-list">
        {tree.folders.map((f) => (
          <FolderBranch key={f.id} node={f} />
        ))}
        {tree.uncategorized.length > 0 && (
          <li>
            <div className="tree-folder">
              <span className="tree-ico">{"\u{1F4C2}"}</span>
              <strong>Uncategorized</strong>
            </div>
            <ul className="tree-list" style={{ paddingLeft: 16 }}>
              {tree.uncategorized.map((p) => (
                <PipelineRow key={p.id} p={p} />
              ))}
            </ul>
          </li>
        )}
        {tree.folders.length === 0 && tree.uncategorized.length === 0 && (
          <li className="muted">No pipelines yet.</li>
        )}
      </ul>

      {revisionsFor && (
        <RevisionsModal
          pipeline={revisionsFor}
          onClose={() => setRevisionsFor(undefined)}
          onRolledBack={() => {
            qc.invalidateQueries({ queryKey: ["pipelines"] });
          }}
          usageRows={rollupPipelineUsage(
            tenantPipelines.data ?? [],
            revisionsFor.id
          )}
        />
      )}
      {runTarget && (
        <DeployModal
          open
          mode="run"
          tenantId={tenantCtx.tenantId}
          tenantSlug={tenantCtx.selected?.slug}
          environment={environment}
          pipelineSlug={runTarget.pipeline.slug ?? runTarget.pipeline.name}
          slots={runTarget.slots}
          onClose={() => setRunTarget(undefined)}
          onConfirm={doRun}
        />
      )}
    </Screen>
  );
}

function RevisionsModal(props: {
  pipeline: PipelineLike;
  onClose: () => void;
  onRolledBack: () => void;
  usageRows: ReturnType<typeof rollupPipelineUsage>;
}) {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<string | undefined>();

  const versions = useQuery({
    queryKey: ["versions", props.pipeline.id],
    queryFn: () => api.listVersions(props.pipeline.id)
  });

  const rollback = useMutation({
    mutationFn: (versionId: string) =>
      api.rollbackPipeline(props.pipeline.id, versionId),
    onSuccess: (res) => {
      setMsg(`Rolled back — latest is now ${res.latestVersionId}.`);
      qc.invalidateQueries({ queryKey: ["versions", props.pipeline.id] });
      props.onRolledBack();
    },
    onError: (e) => setMsg(errText(e))
  });

  const latestId = versions.data?.latestVersionId;
  const rows: PipelineVersionRow[] = versions.data?.versions ?? [];

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <strong>Revisions — {props.pipeline.name}</strong>
          <button className="link-btn" onClick={props.onClose}>
            Close
          </button>
        </header>
        {versions.isLoading && <p className="muted">Loading versions…</p>}
        {versions.error && <p className="error">{errText(versions.error)}</p>}
        {msg && <p className="muted">{msg}</p>}
        {versions.data && (
          <table className="grid">
            <thead>
              <tr>
                <th>Version</th>
                <th>Status</th>
                <th>Parent</th>
                <th>Latest</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    No versions yet.
                  </td>
                </tr>
              )}
              {rows.map((v) => {
                const isLatest = v.isLatest || v.id === latestId;
                return (
                  <tr key={v.id}>
                    <td>{v.version}</td>
                    <td>{v.status}</td>
                    <td className="muted">{v.parentVersionId ?? "-"}</td>
                    <td>{isLatest ? "★ latest" : ""}</td>
                    <td className="muted">{v.createdAt}</td>
                    <td>
                      {!isLatest && (
                        <button
                          className="link-btn"
                          disabled={rollback.isPending}
                          onClick={() => rollback.mutate(v.id)}
                        >
                          Rollback
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <h2>Tenant / activation / version rollup</h2>
        <table className="grid">
          <thead>
            <tr>
              <th>Tenant</th>
              <th>Assoc.</th>
              <th>Activation</th>
              <th>Environment</th>
              <th>Effective version</th>
              <th>Enabled</th>
            </tr>
          </thead>
          <tbody>
            {props.usageRows.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No tenant runs this pipeline.
                </td>
              </tr>
            )}
            {props.usageRows.map((r, i) => (
              <tr key={i}>
                <td>{r.tenantId}</td>
                <td>{r.associationEnabled ? "on" : "off"}</td>
                <td>{r.activationLabel}</td>
                <td>{r.environment}</td>
                <td className="muted">{r.effectiveVersionId ?? "-"}</td>
                <td>{r.enabled ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
