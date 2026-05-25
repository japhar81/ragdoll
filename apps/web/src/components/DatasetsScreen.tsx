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

      <DatasetPipelinesSection dataset={props.dataset} />
    </div>
  );
}

/**
 * Phase 13: inverse view. "Which pipelines reference this dataset?"
 * derived client-side from listPipelines + listVersions so we don't
 * need a new REST endpoint. Each visible pipeline's latest spec is
 * scanned for `node.dataset.slug === <our slug>`.
 *
 * Cost-aware: one versions call per visible pipeline. React Query
 * dedupes against the Pipelines screen's own cache (same
 * `pipeline-versions` key), so opening a dataset detail after
 * browsing the Pipelines list usually hits warm cache.
 */
function DatasetPipelinesSection(props: { dataset: DatasetView }) {
  const pipelines = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => api.listPipelines()
  });
  const rows = pipelines.data?.pipelines ?? [];
  return (
    <>
      <h4 style={{ marginTop: 16 }}>Pipelines</h4>
      <p className="muted" style={{ fontSize: "0.85em" }}>
        Pipelines whose latest spec references{" "}
        <code>{props.dataset.slug}</code>.
      </p>
      {pipelines.isLoading && <p className="muted">Loading…</p>}
      <DatasetPipelineList
        rows={rows.map((p) => ({ id: p.id, name: p.name, slug: p.slug ?? p.id }))}
        datasetSlug={props.dataset.slug}
      />
    </>
  );
}

/**
 * Streams DatasetPipelineRow probes for each visible pipeline; only
 * the ones whose latest spec references the target dataset slug
 * actually render. When NONE match, we surface a hint so the section
 * isn't silently empty.
 */
function DatasetPipelineList(props: {
  rows: Array<{ id: string; name: string; slug: string }>;
  datasetSlug: string;
}) {
  const [hits, setHits] = useState<Record<string, boolean>>({});
  const allChecked = props.rows.every((r) => hits[r.id] !== undefined);
  const anyHit = Object.values(hits).some(Boolean);
  return (
    <>
      {props.rows.map((p) => (
        <DatasetPipelineRow
          key={p.id}
          pipelineId={p.id}
          name={p.name}
          slug={p.slug}
          datasetSlug={props.datasetSlug}
          onChecked={(hit) =>
            setHits((prev) =>
              prev[p.id] === hit ? prev : { ...prev, [p.id]: hit }
            )
          }
        />
      ))}
      {allChecked && !anyHit && (
        <p className="muted">No pipelines reference this dataset yet.</p>
      )}
    </>
  );
}

/**
 * Renders a single pipeline row IFF its latest version references the
 * target dataset slug. Doing the filter at the row level instead of
 * batching keeps each lookup memoised in React Query and matches the
 * PipelinesScreen's own caching key.
 */
function DatasetPipelineRow(props: {
  pipelineId: string;
  name: string;
  slug: string;
  datasetSlug: string;
  onChecked: (hit: boolean) => void;
}) {
  const versions = useQuery({
    queryKey: ["pipeline-versions", props.pipelineId],
    queryFn: () => api.listVersions(props.pipelineId),
    staleTime: 30_000
  });
  const hit = useMemo(() => {
    const all = versions.data?.versions ?? [];
    const latestId = versions.data?.latestVersionId;
    const target = latestId
      ? all.find((v) => v.id === latestId) ?? all[0]
      : all[0];
    if (!target?.spec) return false;
    for (const node of (target.spec as { spec?: { nodes?: Array<{ dataset?: { slug?: string } }> } })?.spec?.nodes ?? []) {
      if (node.dataset?.slug === props.datasetSlug) return true;
    }
    return false;
  }, [versions.data, props.datasetSlug]);
  // Report whether this pipeline references the dataset so the parent
  // can decide whether the whole list is empty. We only call back when
  // the result is settled (versions.data loaded) to avoid flicker.
  useEffect(() => {
    if (versions.data) props.onChecked(hit);
  }, [versions.data, hit, props]);
  if (!hit) return null;
  return (
    <div style={{ padding: "2px 0" }}>
      <code>{props.slug}</code>{" "}
      <span className="muted">— {props.name}</span>
    </div>
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
  // Stable per-dataset URL: /datasets/:datasetId selects that row on
  // mount and on navigation; clicking "details" / "hide" updates the
  // URL via navigate(). Bookmarking a dataset works as expected.
  const { datasetId: routeId } = useParams<{ datasetId?: string }>();
  const [tenantFilter, setTenantFilter] = useState<string>("");
  const [environmentFilter, setEnvironmentFilter] = useState<string>("");
  const { environments } = useEnvironments(tenantFilter || undefined);

  const canAdmin = auth.can("dataset:admin");

  const datasets = useQuery({
    queryKey: ["datasets", tenantFilter, environmentFilter],
    queryFn: () =>
      api.listDatasets({
        tenantId: tenantFilter || undefined,
        environmentId: environmentFilter || undefined
      })
  });

  const visible = datasets.data?.datasets ?? [];
  // When the URL names a dataset that's NOT in the current filter view
  // (e.g. deep-link to a tenant-scoped dataset while the filter is on
  // a different tenant), fall back to fetching that one record so the
  // detail panel still renders rather than silently 404'ing.
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
          retrieve in others. Scope is global, tenant, or environment;
          resolution walks env → tenant → global at reference time.
        </p>

        <div className="inline-form" style={{ gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <select
            value={tenantFilter}
            onChange={(e) => {
              setTenantFilter(e.target.value);
              setEnvironmentFilter("");
            }}
          >
            <option value="">— all tenants —</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                tenant · {t.name}
              </option>
            ))}
          </select>
          <select
            value={environmentFilter}
            onChange={(e) => setEnvironmentFilter(e.target.value)}
            disabled={!tenantFilter || environments.length === 0}
          >
            <option value="">— all envs —</option>
            {environments.map((env) => (
              <option key={env.id} value={env.name}>
                env · {env.name}
              </option>
            ))}
          </select>
          {canAdmin && <CreateDatasetForm onCreated={(d) => setSelectedId(d.id)} />}
        </div>

        <DatasetsTable
          rows={visible}
          canAdmin={canAdmin}
          highlightedId={selectedId ?? undefined}
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
 * Flat datasets table. One row per dataset; actions inline; RBAC
 * gates write actions (Archive / Delete) when the user lacks
 * `dataset:admin` at that scope. Display name is editable in-place
 * (admin only).
 */
function DatasetsTable(props: {
  rows: DatasetView[];
  canAdmin: boolean;
  highlightedId?: string;
}) {
  const qc = useQueryClient();
  const archive = useMutation({
    mutationFn: (args: { id: string; archive: boolean }) =>
      api.updateDataset(args.id, { archived: args.archive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["datasets"] })
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteDataset(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["datasets"] })
  });
  if (props.rows.length === 0) {
    return <p className="muted">No datasets at this scope yet.</p>;
  }
  return (
    <Table
      columns={[
        "Slug",
        "Display name",
        "Scope",
        "Modalities",
        "Backends",
        "Current ver",
        "Status",
        ""
      ]}
      rows={props.rows.map((d) => [
        <code key="sl" style={{
          fontWeight: d.id === props.highlightedId ? "bold" : undefined
        }}>{d.slug}</code>,
        <EditableDisplayName key="dn" dataset={d} canAdmin={props.canAdmin} />,
        <span key="sc" className="status">
          {scopeLabel(d)}
        </span>,
        d.modalities.join(", ") || "—",
        <span key="be" className="muted">
          {Object.entries(d.backends)
            .map(
              ([modality, cfg]) =>
                `${modality}:${(cfg as { provider?: string })?.provider ?? "?"}`
            )
            .join(", ") || "—"}
        </span>,
        d.currentVersionId ? (
          <span key="cv" className="status status-running">
            ready
          </span>
        ) : (
          <span key="cv" className="muted">—</span>
        ),
        d.archivedAt ? (
          <span key="st" className="status status-cancelled">archived</span>
        ) : (
          <span key="st" className="status status-succeeded">active</span>
        ),
        <span key="actions" style={{ display: "inline-flex", gap: 6 }}>
          {props.canAdmin && (
            <>
              <button
                className="link-btn"
                title={d.archivedAt ? "Restore from archive" : "Archive (hide from default lists)"}
                onClick={() => archive.mutate({ id: d.id, archive: !d.archivedAt })}
                disabled={archive.isPending}
              >
                {d.archivedAt ? "unarchive" : "archive"}
              </button>
              <button
                className="link-btn danger"
                title="Permanently delete (refuses if pipelines reference it once that check is wired)"
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
      ])}
    />
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
