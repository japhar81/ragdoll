/**
 * Datasets screen (Phase 4e of dataset/RBAC/retrieval refactor).
 *
 * Lists every Dataset visible at the selected tenant/env scope, lets
 * users with `dataset:admin` create new ones at the picked scope, and
 * surfaces a detail panel (versions + aliases + schema) for whatever
 * is currently selected. Mutations invalidate ["datasets", …] so the
 * other screens that show dataset chips refresh in lockstep with
 * Builder edits and live ChangeEvents.
 *
 * Read access is gated by `dataset:read`; the create form is gated by
 * `dataset:admin` (which `platform_admin` and `tenant_admin` hold, plus
 * `pipeline_admin` within their own pipelines). The server still
 * enforces — this is just cosmetic UI.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.ts";
import type { DatasetView, DatasetVersionView, DatasetAliasView } from "../lib/api.ts";
import { Screen, Table } from "./Screen.tsx";
import { DataGrid, type DataGridColumn } from "./DataGrid.tsx";
import { useAuth } from "../auth/AuthContext.tsx";
import { useTenants } from "./useTenants.tsx";
import { useEnvironments } from "./useEnvironments.tsx";

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const b = e.body as { error?: string; message?: string } | undefined;
    return `HTTP ${e.status}: ${b?.message ?? b?.error ?? JSON.stringify(e.body)}`;
  }
  return e instanceof Error ? e.message : String(e);
}

function scopeLabel(d: DatasetView): string {
  if (d.scope === "global") return "global";
  if (d.scope === "tenant") {
    return `tenant ${d.tenantId?.slice(0, 8)}…`;
  }
  return `tenant ${d.tenantId?.slice(0, 8)}… · env ${d.environmentId}`;
}

function DatasetDetail(props: { dataset: DatasetView; canAdmin: boolean }) {
  const qc = useQueryClient();
  const versions = useQuery({
    queryKey: ["dataset-versions", props.dataset.id],
    queryFn: () => api.listDatasetVersions(props.dataset.id)
  });
  const archive = useMutation({
    mutationFn: () =>
      api.updateDataset(props.dataset.id, {
        archived: !props.dataset.archivedAt
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["datasets"] })
  });
  const aliasSwap = useMutation({
    mutationFn: (args: { alias: string; versionId: string }) =>
      api.setDatasetAlias(props.dataset.id, args.alias, args.versionId),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["dataset-versions", props.dataset.id] })
  });

  const versionList = versions.data?.versions ?? [];
  const aliasList = versions.data?.aliases ?? [];

  return (
    <div className="settings-card" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <h3 style={{ margin: 0 }}>{props.dataset.displayName}</h3>
          <div className="muted">
            <code>{props.dataset.slug}</code> · {scopeLabel(props.dataset)}
            {props.dataset.archivedAt ? " · archived" : ""}
          </div>
          {props.dataset.description && (
            <p style={{ marginTop: 8 }}>{props.dataset.description}</p>
          )}
        </div>
        {props.canAdmin && (
          <button
            className="link-btn"
            onClick={() => archive.mutate()}
            disabled={archive.isPending}
          >
            {props.dataset.archivedAt ? "Unarchive" : "Archive"}
          </button>
        )}
      </div>

      <h4>Modalities + backends</h4>
      <div className="muted">
        {props.dataset.modalities.join(", ") || "—"}
        {" · "}
        {Object.keys(props.dataset.backends).length > 0
          ? Object.entries(props.dataset.backends)
              .map(
                ([modality, cfg]) =>
                  `${modality}: ${(cfg as { provider?: string })?.provider ?? "?"}`
              )
              .join(", ")
          : "no backends declared"}
      </div>
      <DatasetBackendResolutionPanel dataset={props.dataset} />
      {props.canAdmin && <AddBackendForm dataset={props.dataset} />}

      <h4>Embedding profile</h4>
      <pre className="codeblock">
        {JSON.stringify(props.dataset.embeddingProfile, null, 2)}
      </pre>

      <h4>Versions</h4>
      <Table
        columns={["Version", "Status", "Backends", "Created", "Current"]}
        rows={versionList.map((v: DatasetVersionView) => [
          <strong key="vl">{v.versionLabel}</strong>,
          <span
            key="st"
            className={`status ${
              v.status === "ready"
                ? "status-succeeded"
                : v.status === "building"
                  ? "status-running"
                  : "status-cancelled"
            }`}
          >
            {v.status}
          </span>,
          <code key="bc" style={{ fontSize: "0.85em" }}>
            {Object.entries(v.backendCollections)
              .map(([m, c]) => `${m}:${c}`)
              .join(", ") || "—"}
          </code>,
          new Date(v.createdAt).toLocaleString(),
          props.dataset.currentVersionId === v.id ? (
            <span key="cur" className="status status-running">current</span>
          ) : (
            ""
          )
        ])}
      />

      <h4>Aliases</h4>
      <Table
        columns={["Alias", "Points to", "Updated", ""]}
        rows={aliasList.map((a: DatasetAliasView) => {
          const ver = versionList.find((v) => v.id === a.versionId);
          return [
            <strong key="al">{a.alias}</strong>,
            ver ? `${ver.versionLabel} (${ver.status})` : a.versionId.slice(0, 8) + "…",
            new Date(a.updatedAt).toLocaleString(),
            props.canAdmin ? (
              <select
                key="swap"
                defaultValue=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  aliasSwap.mutate({
                    alias: a.alias,
                    versionId: e.target.value
                  });
                }}
                disabled={aliasSwap.isPending}
              >
                <option value="">retarget…</option>
                {versionList
                  .filter((v) => v.id !== a.versionId && v.status === "ready")
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      → {v.versionLabel}
                    </option>
                  ))}
              </select>
            ) : (
              ""
            )
          ];
        })}
      />
      {aliasSwap.isError && <p className="error">{errText(aliasSwap.error)}</p>}

      {props.canAdmin && <CreateVariantForm slug={props.dataset.slug} />}
      <DatasetPipelinesSection dataset={props.dataset} />
      <DatasetBindingOverridesSection dataset={props.dataset} canAdmin={props.canAdmin} />
    </div>
  );
}

/**
 * PR3 cross-ref: every pipeline_dataset_binding row that pins THIS
 * dataset as its target. Shows the operator at a glance "if I delete
 * or archive this dataset, these (pipeline, tenant, env) tuples
 * break". Pulled by walking every pipeline's bindings — small N for
 * the install sizes we target; if it ever scales we'd add an
 * /api/datasets/:id/binding-refs endpoint.
 */
function DatasetBindingOverridesSection(props: { dataset: DatasetView; canAdmin: boolean }) {
  const pipelines = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => api.listPipelines()
  });
  const rows = pipelines.data?.pipelines ?? [];
  // Fan out to /api/pipelines/:id/dataset-bindings for each pipeline.
  const bindingQueries = useQuery({
    queryKey: ["dataset-bindings-by-dataset", props.dataset.id, rows.map((p) => p.id).join(",")],
    queryFn: async () => {
      const lists = await Promise.all(
        rows.map((p) => api.listPipelineBindings(p.id).then((r) => ({ pipeline: p, bindings: r.bindings })))
      );
      return lists.flatMap(({ pipeline, bindings }) =>
        bindings
          .filter((b) => b.targetDatasetId === props.dataset.id)
          .map((b) => ({ pipeline, binding: b }))
      );
    },
    enabled: rows.length > 0
  });
  const items = bindingQueries.data ?? [];
  return (
    <>
      <h4 style={{ marginTop: 16 }}>Binding overrides targeting this dataset</h4>
      <p className="muted" style={{ fontSize: "0.85em" }}>
        Per-(pipeline, tenant, env) overrides that pin a slug to this dataset.
        Removing this dataset breaks them — review before archiving.
      </p>
      {bindingQueries.isLoading && <p className="muted">Loading…</p>}
      {items.length === 0 && !bindingQueries.isLoading && (
        <p className="muted">No binding overrides target this dataset.</p>
      )}
      {items.length > 0 && (
        <Table
          columns={["Pipeline", "Tenant", "Env", "From slug", ""]}
          rows={items.map(({ pipeline, binding }) => [
            <code key="p">{pipeline.slug ?? pipeline.id.slice(0, 8)}</code>,
            <code key="t">{binding.tenantId.slice(0, 8)}…</code>,
            binding.environmentId ?? <em key="e">(all envs)</em>,
            <code key="s">{binding.sourceSlug}</code>,
            props.canAdmin ? (
              <BindingDeleteButton key="d" id={binding.id} />
            ) : (
              ""
            )
          ])}
        />
      )}
    </>
  );
}

function BindingDeleteButton(props: { id: string }) {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () => api.deletePipelineBinding(props.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dataset-bindings-by-dataset"] })
  });
  return (
    <button
      className="link-danger"
      onClick={() => {
        if (window.confirm("Delete this binding override?")) del.mutate();
      }}
      disabled={del.isPending}
    >
      Delete
    </button>
  );
}

/**
 * Inverse view: every pipeline node that pins this slug, with a deep-link
 * back to the Builder so the operator can re-wire from one click. The
 * Builder reads `?node=<id>` and selects that node in the Inspector on
 * mount, so rewiring is a slug-change away.
 *
 * Derived client-side from listPipelines + listVersions; React Query
 * dedupes against the Pipelines screen's own `pipeline-versions` cache.
 */
function DatasetPipelinesSection(props: { dataset: DatasetView }) {
  const pipelines = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => api.listPipelines()
  });
  const rows = pipelines.data?.pipelines ?? [];
  return (
    <>
      <h4 style={{ marginTop: 16 }}>Pipelines wiring slug "{props.dataset.slug}"</h4>
      <p className="muted" style={{ fontSize: "0.85em" }}>
        Each row is one node that pins this slug. Click <em>open in builder</em>
        {" "}to rewire it.
      </p>
      {pipelines.isLoading && <p className="muted">Loading…</p>}
      <DatasetPipelineList
        rows={rows.map((p) => ({ id: p.id, name: p.name, slug: p.slug ?? p.id }))}
        datasetSlug={props.dataset.slug}
      />
    </>
  );
}

interface PipelineBinding {
  pipelineId: string;
  pipelineSlug: string;
  pipelineName: string;
  nodeId: string;
  alias: string;
}

function DatasetPipelineList(props: {
  rows: Array<{ id: string; name: string; slug: string }>;
  datasetSlug: string;
}) {
  const [bindings, setBindings] = useState<Record<string, PipelineBinding[]>>({});
  const allChecked = props.rows.every((r) => bindings[r.id] !== undefined);
  const flat = useMemo(
    () => Object.values(bindings).flat(),
    [bindings]
  );
  return (
    <>
      {props.rows.map((p) => (
        <DatasetPipelineProbe
          key={p.id}
          pipelineId={p.id}
          pipelineName={p.name}
          pipelineSlug={p.slug}
          datasetSlug={props.datasetSlug}
          onResolved={(found) =>
            setBindings((prev) =>
              prev[p.id] !== undefined
                ? prev
                : { ...prev, [p.id]: found }
            )
          }
        />
      ))}
      {allChecked && flat.length === 0 && (
        <p className="muted">No pipelines reference this slug yet.</p>
      )}
      {flat.length > 0 && <BindingTable bindings={flat} />}
    </>
  );
}

function BindingTable(props: { bindings: PipelineBinding[] }) {
  const navigate = useNavigate();
  return (
    <table className="grid" style={{ marginTop: 8 }}>
      <thead>
        <tr>
          <th>Pipeline</th>
          <th>Node</th>
          <th>Alias</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {props.bindings.map((b) => (
          <tr key={`${b.pipelineId}-${b.nodeId}`}>
            <td>
              <code>{b.pipelineSlug}</code>
              <br />
              <span className="muted">{b.pipelineName}</span>
            </td>
            <td>
              <code>{b.nodeId}</code>
            </td>
            <td>
              <code>{b.alias}</code>
            </td>
            <td>
              <button
                className="link-btn"
                onClick={() =>
                  navigate(
                    `/builder/${encodeURIComponent(b.pipelineId)}?node=${encodeURIComponent(b.nodeId)}`
                  )
                }
                title="Jump to this node in the Builder"
              >
                open in builder
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Probes one pipeline's latest version for nodes pinning the target slug.
 * Reports the full list of bindings (potentially several per pipeline) to
 * the parent so the BindingTable can render every wired node.
 */
function DatasetPipelineProbe(props: {
  pipelineId: string;
  pipelineName: string;
  pipelineSlug: string;
  datasetSlug: string;
  onResolved: (found: PipelineBinding[]) => void;
}) {
  const versions = useQuery({
    queryKey: ["pipeline-versions", props.pipelineId],
    queryFn: () => api.listVersions(props.pipelineId),
    staleTime: 30_000
  });
  const found = useMemo<PipelineBinding[]>(() => {
    const all = versions.data?.versions ?? [];
    const latestId = versions.data?.latestVersionId;
    const target = latestId
      ? all.find((v) => v.id === latestId) ?? all[0]
      : all[0];
    if (!target?.spec) return [];
    const out: PipelineBinding[] = [];
    const nodes =
      (target.spec as {
        spec?: { nodes?: Array<{ id: string; dataset?: { slug?: string; alias?: string } }> };
      })?.spec?.nodes ?? [];
    for (const node of nodes) {
      if (node.dataset?.slug === props.datasetSlug) {
        out.push({
          pipelineId: props.pipelineId,
          pipelineSlug: props.pipelineSlug,
          pipelineName: props.pipelineName,
          nodeId: node.id,
          alias: node.dataset.alias ?? "stable"
        });
      }
    }
    return out;
  }, [
    versions.data,
    props.datasetSlug,
    props.pipelineId,
    props.pipelineName,
    props.pipelineSlug
  ]);
  useEffect(() => {
    if (versions.data) props.onResolved(found);
    // intentional: only report once per data refresh
  }, [versions.data, found, props]);
  return null;
}

/**
 * Inline "create another scope variant of this slug" form. Lets operators
 * spawn a tenant- or env-scoped override without leaving the Datasets
 * screen. Uses the same {scope, slug, …} createDataset call the deploy
 * modal does, so the resulting variant lights up everywhere.
 */
function CreateVariantForm(props: { slug: string }) {
  const auth = useAuth();
  const qc = useQueryClient();
  const { tenants } = useTenants();
  const [scope, setScope] = useState<"global" | "tenant" | "environment">("tenant");
  const [tenantId, setTenantId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const { environments } = useEnvironments(tenantId || undefined);
  const hasGlobalAdmin = useMemo(
    () => auth.grants.some((g) => g.scope === "*"),
    [auth.grants]
  );
  const create = useMutation({
    mutationFn: () =>
      api.createDataset({
        scope,
        slug: props.slug,
        displayName: props.slug,
        tenantId: scope === "global" ? undefined : tenantId || undefined,
        environmentId:
          scope === "environment" ? environmentId || undefined : undefined,
        modalities: ["vector"]
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["datasets-all"] });
      qc.invalidateQueries({ queryKey: ["datasets-slugs"] });
      qc.invalidateQueries({ queryKey: ["datasets-deploy"] });
    }
  });
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
      style={{ flexWrap: "wrap", gap: 8, marginTop: 8 }}
    >
      <span className="muted">
        New variant of <code>{props.slug}</code> at:
      </span>
      <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
        {hasGlobalAdmin && <option value="global">global</option>}
        <option value="tenant">tenant</option>
        <option value="environment">environment</option>
      </select>
      {scope !== "global" && (
        <select
          value={tenantId}
          onChange={(e) => {
            setTenantId(e.target.value);
            setEnvironmentId("");
          }}
          required
        >
          <option value="">— tenant —</option>
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      {scope === "environment" && (
        <select
          value={environmentId}
          onChange={(e) => setEnvironmentId(e.target.value)}
          disabled={!tenantId}
          required
        >
          <option value="">— env —</option>
          {environments.map((env) => (
            <option key={env.id} value={env.name}>
              {env.name}
            </option>
          ))}
        </select>
      )}
      <button type="submit" className="primary" disabled={create.isPending}>
        {create.isPending ? "Creating…" : "Create variant"}
      </button>
      {create.isError && <span className="error">{errText(create.error)}</span>}
    </form>
  );
}

function CreateDatasetForm(props: { onCreated: (d: DatasetView) => void }) {
  const auth = useAuth();
  const qc = useQueryClient();
  const { tenants } = useTenants();
  const [scope, setScope] = useState<"global" | "tenant" | "environment">("tenant");
  const [tenantId, setTenantId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");

  const { environments } = useEnvironments(tenantId || undefined);

  const hasGlobalAdmin = useMemo(
    () => auth.grants.some((g) => g.scope === "*"),
    [auth.grants]
  );

  const create = useMutation({
    mutationFn: () =>
      api.createDataset({
        scope,
        slug: slug.trim(),
        displayName: displayName.trim(),
        description: description.trim() || undefined,
        tenantId: scope === "global" ? undefined : tenantId || undefined,
        environmentId: scope === "environment" ? environmentId || undefined : undefined,
        modalities: ["vector"]
      }),
    onSuccess: (res) => {
      setSlug("");
      setDisplayName("");
      setDescription("");
      qc.invalidateQueries({ queryKey: ["datasets"] });
      props.onCreated(res.dataset);
    }
  });

  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
      style={{ flexWrap: "wrap", gap: 8 }}
    >
      <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
        {hasGlobalAdmin && <option value="global">scope · global</option>}
        <option value="tenant">scope · tenant</option>
        <option value="environment">scope · environment</option>
      </select>
      {scope !== "global" && (
        <select
          value={tenantId}
          onChange={(e) => {
            setTenantId(e.target.value);
            setEnvironmentId("");
          }}
          required
        >
          <option value="">— tenant —</option>
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      {scope === "environment" && (
        <select
          value={environmentId}
          onChange={(e) => setEnvironmentId(e.target.value)}
          disabled={!tenantId}
          required
        >
          <option value="">— env —</option>
          {environments.map((env) => (
            <option key={env.id} value={env.name}>
              {env.name}
            </option>
          ))}
        </select>
      )}
      <input
        placeholder="slug (a-z0-9_-)"
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
        required
        pattern="[a-z0-9][a-z0-9_-]{0,62}"
        title="lowercase letters / digits / _ - ; 1..63 chars"
      />
      <input
        placeholder="Display name"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        required
      />
      <input
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        style={{ minWidth: 240 }}
      />
      <button type="submit" className="primary" disabled={create.isPending}>
        {create.isPending ? "Creating…" : "Create dataset"}
      </button>
      {create.isError && <span className="error">{errText(create.error)}</span>}
    </form>
  );
}

export function DatasetsScreen() {
  const auth = useAuth();
  const { tenants } = useTenants();
  const navigate = useNavigate();
  const { datasetId: routeId } = useParams<{ datasetId?: string }>();
  const canAdmin = auth.can("dataset:admin");

  // Phase 13 follow-up #2: ONE grid showing everything the user can
  // see — global + every tenant + every env — with column-level
  // filters. The previous tenant/env dropdowns gated which rows the
  // API returned; the new grid asks for everything at once
  // (server-side RBAC still filters by what the principal can read).
  const datasets = useQuery({
    queryKey: ["datasets-all"],
    queryFn: async () => {
      // Without `x-tenant-id` the server returns globals + any
      // tenant-scoped rows the principal can read. We also fetch
      // per-tenant lists for tenant + env scopes — the API filters
      // those by `x-tenant-id` so we walk the principal's visible
      // tenants and merge. Cheap with React Query dedup.
      const baseline = await api.listDatasets();
      const merged = new Map<string, (typeof baseline.datasets)[number]>();
      for (const d of baseline.datasets) merged.set(d.id, d);
      for (const tenant of tenants) {
        try {
          const res = await api.listDatasets({ tenantId: tenant.id });
          for (const d of res.datasets) merged.set(d.id, d);
        } catch {
          /* skip tenants the principal can't read; keep going */
        }
      }
      return { datasets: [...merged.values()] };
    },
    enabled: tenants.length > 0 || !canAdmin
  });

  const visible = datasets.data?.datasets ?? [];
  // Index tenant + env names so the grid can show them without forcing
  // every row through another tenant lookup.
  const tenantName = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tenants) m.set(t.id, t.name ?? t.slug);
    return m;
  }, [tenants]);

  const fallbackDataset = useQuery({
    queryKey: ["dataset", routeId],
    queryFn: () => api.getDataset(routeId as string),
    enabled: !!routeId && !visible.some((d) => d.id === routeId)
  });
  const selected =
    visible.find((d) => d.id === routeId) ??
    fallbackDataset.data?.dataset ??
    null;
  const setSelectedId = (id: string | null): void => {
    navigate(id ? `/datasets/${encodeURIComponent(id)}` : "/datasets");
  };
  const selectedId = routeId ?? null;

  return (
    <Screen title="Datasets">
      <div className="settings-card">
        <p className="muted">
          Named, schema'd corpora that pipelines read from and write
          into. One Dataset can back many pipelines — ingest in one,
          retrieve in others. Filter or sort any column; click a row
          to open its versions + aliases.
        </p>

        {canAdmin && (
          <div style={{ marginBottom: 12 }}>
            <CreateDatasetForm onCreated={(d) => setSelectedId(d.id)} />
          </div>
        )}

        <DatasetsGrid
          rows={visible}
          tenantName={tenantName}
          canAdmin={canAdmin}
          highlightedId={selectedId ?? undefined}
          onOpen={setSelectedId}
        />
        {datasets.isError && <p className="error">{errText(datasets.error)}</p>}
      </div>

      {/* A deep-link selects a row; we render the version + alias panel
          below the table so operators can still drill into versions
          without leaving the screen. */}
      {selected && <DatasetDetail dataset={selected} canAdmin={canAdmin} />}
    </Screen>
  );
}

/**
 * Datasets grid. All visible datasets in one sortable + filterable
 * table; columns for tenant + env + scope mean the operator picks
 * which slice they want without a separate dropdown. RBAC gates
 * archive / delete; rename happens in-place on the displayName cell.
 */
function DatasetsGrid(props: {
  rows: DatasetView[];
  tenantName: Map<string, string>;
  canAdmin: boolean;
  highlightedId?: string;
  onOpen: (id: string | null) => void;
}) {
  const qc = useQueryClient();
  const archive = useMutation({
    mutationFn: (args: { id: string; archive: boolean }) =>
      api.updateDataset(args.id, { archived: args.archive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["datasets-all"] })
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteDataset(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["datasets-all"] })
  });
  const columns: DataGridColumn<DatasetView>[] = [
    {
      key: "slug",
      header: "Slug",
      accessor: (d) => d.slug,
      cell: (d) => <code>{d.slug}</code>,
      width: "16%"
    },
    {
      key: "displayName",
      header: "Display name",
      accessor: (d) => d.displayName,
      cell: (d) => <EditableDisplayName dataset={d} canAdmin={props.canAdmin} />,
      width: "18%"
    },
    {
      key: "scope",
      header: "Scope",
      accessor: (d) => d.scope,
      filter: "select",
      width: "9%"
    },
    {
      key: "tenant",
      header: "Tenant",
      accessor: (d) =>
        d.tenantId ? props.tenantName.get(d.tenantId) ?? d.tenantId : "—",
      filter: "select",
      width: "12%"
    },
    {
      key: "env",
      header: "Env",
      accessor: (d) => d.environmentId ?? "—",
      filter: "select",
      width: "9%"
    },
    {
      key: "modalities",
      header: "Modalities",
      accessor: (d) => d.modalities.join(", "),
      width: "11%"
    },
    {
      key: "backends",
      header: "Backends",
      accessor: (d) =>
        Object.entries(d.backends)
          .map(
            ([modality, cfg]) =>
              `${modality}:${(cfg as { provider?: string })?.provider ?? "?"}`
          )
          .join(", "),
      cell: (d) => (
        <span className="muted">
          {Object.entries(d.backends)
            .map(
              ([modality, cfg]) =>
                `${modality}:${(cfg as { provider?: string })?.provider ?? "?"}`
            )
            .join(", ") || "—"}
        </span>
      ),
      width: "13%"
    },
    {
      key: "status",
      header: "Status",
      accessor: (d) => (d.archivedAt ? "archived" : "active"),
      cell: (d) =>
        d.archivedAt ? (
          <span className="status status-cancelled">archived</span>
        ) : (
          <span className="status status-succeeded">active</span>
        ),
      filter: "select",
      width: "7%"
    },
    {
      key: "actions",
      header: "",
      accessor: () => "",
      filter: "none",
      sortable: false,
      cell: (d) => (
        <span style={{ display: "inline-flex", gap: 6 }}>
          <button
            className="link-btn"
            onClick={() => props.onOpen(d.id)}
            title="Show versions, aliases, and pipelines referencing this dataset"
          >
            details
          </button>
          {props.canAdmin && (
            <>
              <button
                className="link-btn"
                title={d.archivedAt ? "Restore from archive" : "Archive"}
                onClick={() => archive.mutate({ id: d.id, archive: !d.archivedAt })}
                disabled={archive.isPending}
              >
                {d.archivedAt ? "unarchive" : "archive"}
              </button>
              <button
                className="link-btn danger"
                title="Permanently delete"
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete dataset "${d.slug}"? This cannot be undone.`
                    )
                  ) {
                    remove.mutate(d.id);
                  }
                }}
                disabled={remove.isPending}
              >
                delete
              </button>
            </>
          )}
        </span>
      ),
      width: "5%"
    }
  ];
  return (
    <DataGrid
      columns={columns}
      rows={props.rows}
      rowKey={(d) => d.id}
      rowClassName={(d) =>
        d.id === props.highlightedId ? "row-highlighted" : undefined
      }
      emptyMessage="No datasets at any scope you can read. Create one above."
    />
  );
}

/**
 * "+ Add backend" affordance on the dataset detail card. Lets an admin
 * extend a single-modality dataset (e.g. vector-only `code_indexer`) with
 * another backend (e.g. opensearch text) so a hybrid pipeline can pin the
 * same slug across both nodes. The API's PATCH /api/datasets/:id already
 * merges in `modalities` + `backends`, so this is a one-shot mutation.
 */
function AddBackendForm(props: { dataset: DatasetView }) {
  const qc = useQueryClient();
  // Only offer modalities + providers we actually have plugins for. Adding
  // graph/neo4j or image here without a backing plugin gets the operator a
  // dead binding the runtime can't resolve.
  const providersByModality: Record<string, string[]> = {
    vector: ["qdrant", "pgvector"],
    text: ["opensearch"]
  };
  const allModalities = Object.keys(providersByModality);
  const existingModalities = new Set(props.dataset.modalities);
  const existingBackends = props.dataset.backends ?? {};
  // Candidates = modalities the user could add OR fill in a missing
  // backend for. A modality is "addable" if either:
  //   (a) the dataset doesn't declare it yet, OR
  //   (b) it's declared but the backends map has no entry (legacy half-
  //       populated row — the runtime can't dispatch it without this).
  const candidateModalities = allModalities.filter(
    (m) => !existingModalities.has(m) || !existingBackends[m]
  );
  const [open, setOpen] = useState(false);
  const [modality, setModality] = useState(candidateModalities[0] ?? "");
  const [provider, setProvider] = useState(
    providersByModality[candidateModalities[0] ?? ""]?.[0] ?? ""
  );
  const isHealing = modality
    ? existingModalities.has(modality) && !existingBackends[modality]
    : false;
  const add = useMutation({
    mutationFn: async () => {
      const nextBackends = {
        ...(props.dataset.backends ?? {}),
        [modality]: { provider }
      };
      const nextModalities = [
        ...new Set([...props.dataset.modalities, modality])
      ];
      return api.updateDataset(props.dataset.id, {
        modalities: nextModalities,
        backends: nextBackends
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["datasets"] });
      qc.invalidateQueries({ queryKey: ["datasets-all"] });
      qc.invalidateQueries({ queryKey: ["datasets-slugs"] });
      setOpen(false);
    }
  });
  if (candidateModalities.length === 0) {
    return (
      <p className="muted" style={{ fontSize: "0.85em" }}>
        All supported modalities ({allModalities.join(", ")}) have a backend.
      </p>
    );
  }
  if (!open) {
    return (
      <button
        className="link-btn"
        onClick={() => setOpen(true)}
        style={{ marginTop: 4 }}
        title="Add a new modality or fix a declared modality with no backend"
      >
        + {candidateModalities.some((m) => existingModalities.has(m)) ? "Fix / add" : "Add"} backend
      </button>
    );
  }
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
      style={{ gap: 6, marginTop: 6, flexWrap: "wrap" }}
    >
      <span className="muted">{isHealing ? "Set backend for" : "Add modality"}</span>
      <select
        value={modality}
        onChange={(e) => {
          const m = e.target.value;
          setModality(m);
          setProvider(providersByModality[m]?.[0] ?? "");
        }}
      >
        {candidateModalities.map((m) => (
          <option key={m} value={m}>
            {m}
            {existingModalities.has(m) && !existingBackends[m]
              ? " (declared, no backend)"
              : ""}
          </option>
        ))}
      </select>
      <span className="muted">via</span>
      <select value={provider} onChange={(e) => setProvider(e.target.value)}>
        {(providersByModality[modality] ?? []).map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <button className="primary" type="submit" disabled={add.isPending || !provider}>
        {add.isPending ? "Saving…" : isHealing ? "Set backend" : "Add"}
      </button>
      <button
        type="button"
        className="link-btn"
        onClick={() => setOpen(false)}
      >
        cancel
      </button>
      {add.isError && <span className="error">{errText(add.error)}</span>}
    </form>
  );
}

function EditableDisplayName(props: {
  dataset: DatasetView;
  canAdmin: boolean;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(props.dataset.displayName);
  const save = useMutation({
    mutationFn: () =>
      api.updateDataset(props.dataset.id, { displayName: value.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["datasets"] });
      setEditing(false);
    }
  });
  if (!editing) {
    return (
      <span
        title={props.canAdmin ? "Click to rename" : undefined}
        onClick={() => props.canAdmin && setEditing(true)}
        style={{ cursor: props.canAdmin ? "pointer" : "default" }}
      >
        {props.dataset.displayName}
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", gap: 4 }}>
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save.mutate();
          if (e.key === "Escape") {
            setValue(props.dataset.displayName);
            setEditing(false);
          }
        }}
        style={{ minWidth: 160 }}
      />
      <button className="link-btn" onClick={() => save.mutate()} disabled={save.isPending}>
        save
      </button>
      <button
        className="link-btn"
        onClick={() => {
          setValue(props.dataset.displayName);
          setEditing(false);
        }}
      >
        cancel
      </button>
    </span>
  );
}

/**
 * Cross-ref panel (PR4): for each modality on the dataset whose
 * backend block carries a `connectionName`, resolve the connection
 * with the cascade endpoint for the current tenant + env, and render
 * a chip with the host + cascade reason + a "open in Connections"
 * link. Lets operators trace dataset → connection in one click.
 *
 * `useTenants().selectedId` + the URL's `?env=` give the active
 * (tenant, env) view; both are part of the dataset detail's existing
 * scope picker.
 */
function DatasetBackendResolutionPanel(props: { dataset: DatasetView }) {
  const tenants = useTenants();
  // Active tenant for the resolution view: the dataset's own tenant
  // if scoped, otherwise the first tenant in the list (global datasets
  // have no inherent tenant — the operator picks one to see what the
  // cascade would pick for THAT tenant).
  const tenantList = tenants.tenants;
  const tenantId = props.dataset.tenantId ?? tenantList[0]?.id;
  // Active env: dataset-scoped if env-scoped, else the URL query, else "dev".
  const url = new URL(window.location.href);
  const env =
    props.dataset.environmentId ?? url.searchParams.get("env") ?? "dev";

  // Each modality with a `connectionName` gets one resolve query.
  const backendEntries = Object.entries(props.dataset.backends ?? {}).filter(
    ([, raw]) => typeof (raw as { connectionName?: string })?.connectionName === "string"
  );
  if (backendEntries.length === 0) return null;

  return (
    <>
      <h4 style={{ marginTop: 16 }}>Resolved connections (tenant: {tenantId?.slice(0, 8)}…, env: {env})</h4>
      <table className="muted" style={{ fontSize: "0.9em", marginTop: 4 }}>
        <thead>
          <tr>
            <th align="left">Modality</th>
            <th align="left">Connection</th>
            <th align="left">Resolved host</th>
            <th align="left">Cascade</th>
          </tr>
        </thead>
        <tbody>
          {backendEntries.map(([modality, raw]) => {
            const connName = (raw as { connectionName: string }).connectionName;
            return (
              <BackendResolutionRow
                key={modality}
                modality={modality}
                connectionName={connName}
                tenantId={tenantId}
                env={env}
              />
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function BackendResolutionRow(props: {
  modality: string;
  connectionName: string;
  tenantId: string | undefined;
  env: string;
}) {
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["connection-resolve", props.tenantId, props.connectionName, props.env],
    queryFn: () =>
      api.resolveConnection(props.tenantId!, props.connectionName, props.env),
    enabled: !!props.tenantId
  });
  if (!props.tenantId) {
    return (
      <tr>
        <td>{props.modality}</td>
        <td>{props.connectionName}</td>
        <td colSpan={2} style={{ color: "var(--text-muted)" }}>(no active tenant)</td>
      </tr>
    );
  }
  const reasonColor =
    q.data?.reason === "env_specific"
      ? "var(--status-succeeded)"
      : q.data?.reason === "tenant_fallback"
        ? "var(--status-running)"
        : "var(--status-cancelled)";
  const host = q.data?.resolved
    ? `${(q.data.resolved.config as { host?: string }).host ?? "?"}${
        (q.data.resolved.config as { port?: number }).port
          ? `:${(q.data.resolved.config as { port?: number }).port}`
          : ""
      }`
    : "—";
  return (
    <tr>
      <td>{props.modality}</td>
      <td>
        <button
          className="link-btn"
          onClick={() => navigate("/connections")}
          title="Open in Connections"
        >
          {props.connectionName}
        </button>
      </td>
      <td>{q.isLoading ? "…" : host}</td>
      <td style={{ color: reasonColor }}>{q.data?.reason ?? "…"}</td>
    </tr>
  );
}
