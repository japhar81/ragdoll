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
import { useMemo, useState } from "react";
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
  const [tenantFilter, setTenantFilter] = useState<string>("");
  const [environmentFilter, setEnvironmentFilter] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  const selected = visible.find((d) => d.id === selectedId) ?? null;

  return (
    <Screen title="Datasets">
      <div className="settings-card">
        <p className="muted">
          Datasets are the named, schema'd corpora pipelines read from and
          write into. A single Dataset can be shared by many pipelines —
          ingest in one, retrieve in others. Scope is global, tenant, or
          environment; resolution walks env → tenant → global at reference
          time.
        </p>

        <div className="inline-form" style={{ gap: 8, marginBottom: 12 }}>
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
        </div>

        {canAdmin && (
          <>
            <h4>Create dataset</h4>
            <CreateDatasetForm
              onCreated={(d) => setSelectedId(d.id)}
            />
          </>
        )}

        <h4 style={{ marginTop: 16 }}>{visible.length} dataset{visible.length === 1 ? "" : "s"}</h4>
        <Table
          columns={["Slug", "Display", "Scope", "Modalities", "Current ver", ""]}
          rows={visible.map((d) => [
            <code key="sl">{d.slug}</code>,
            d.displayName,
            <span key="sc" className="status">
              {scopeLabel(d)}
            </span>,
            d.modalities.join(", ") || "—",
            d.currentVersionId ? "set" : "—",
            <button
              key="open"
              className="link-btn"
              onClick={() => setSelectedId(d.id === selectedId ? null : d.id)}
            >
              {selectedId === d.id ? "hide" : "details"}
            </button>
          ])}
        />
        {datasets.isError && <p className="error">{errText(datasets.error)}</p>}
      </div>

      {selected && <DatasetDetail dataset={selected} canAdmin={canAdmin} />}
    </Screen>
  );
}
