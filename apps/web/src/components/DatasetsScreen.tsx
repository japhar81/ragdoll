/**
 * Datasets admin screen (ADR-0023).
 *
 * Lists every Dataset the principal can read, scoped via the same
 * left-rail scope tree the Connections / Secrets / Config screens use.
 * The detail panel is binding-keyed: a dataset is a named map of
 * `<binding> → connection + collection`, full stop. The legacy
 * "modalities" + "backends" view (one row per modality, provider
 * column, etc.) is gone — migration 021 dropped the columns and
 * ADR-0024 made every storage kind a driver plugin in the unified
 * registry, so the binding-name vocabulary IS the operator-facing
 * vocabulary.
 *
 * Detail panel layout:
 *   ┌ Header — slug, display name, scope, archive toggle
 *   ├ Bindings — per-binding row: name + connection + collection +
 *   │            namespace policy + probe badge. Add / edit / remove.
 *   ├ Used by — pipelines that wire this slug, with the node + binding
 *   │            name from /api/datasets/:id/used-by.
 *   ├ Versions + aliases — collapsed by default; expand to manage
 *   │            version cuts + retarget the stable alias.
 *   └ Embedding profile / chunk schema — collapsed by default.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  api,
  ApiError,
  type DatasetView,
  type DatasetVersionView,
  type DatasetAliasView,
  type ConnectionView,
  type ConnectionKindInfo
} from "../lib/api.ts";
import { buildScopeTree, findScopeNode, type ScopeNode } from "../lib/orgtree.ts";
import { tenantIdFromScopeKey } from "../lib/tenantContext.ts";
import { useTenants } from "./useTenants.tsx";
import { useEnvironments } from "./useEnvironments.tsx";
import { useAuth } from "../auth/AuthContext.tsx";
import { Screen } from "./Screen.tsx";
import { CascadeDeleteModal } from "./CascadeDeleteModal.tsx";
import { ScopeTree } from "./ConfigScreen.tsx";

type Scope = "global" | "tenant" | "environment";

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const b = e.body as { error?: string; message?: string } | undefined;
    return `HTTP ${e.status}: ${b?.message ?? b?.error ?? JSON.stringify(e.body)}`;
  }
  return e instanceof Error ? e.message : String(e);
}

function fmtTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

// ===========================================================================
// Bindings table — the new first-class detail surface
// ===========================================================================

interface BindingDraft {
  name: string;
  connection: string;
  collection: string;
  namespace: string;
}

function emptyBindingDraft(): BindingDraft {
  return { name: "", connection: "", collection: "", namespace: "" };
}

function BindingsSection(props: {
  dataset: DatasetView;
  canAdmin: boolean;
  connections: ConnectionView[];
  kinds: ConnectionKindInfo[];
}) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<BindingDraft>(emptyBindingDraft());
  const [formError, setFormError] = useState<string | null>(null);

  // Connection slug → kind lookup so binding rows can show "qdrant
  // (Qdrant)" + the probe badge.
  const connBySlug = useMemo(() => {
    const m = new Map<string, ConnectionView>();
    for (const c of props.connections) m.set(c.slug, c);
    return m;
  }, [props.connections]);
  const kindByName = useMemo(() => {
    const m = new Map<string, ConnectionKindInfo>();
    for (const k of props.kinds) m.set(k.kind, k);
    return m;
  }, [props.kinds]);

  // Binding-name vocabulary — autocomplete from the union of every
  // registered driver's datasetBindings field. Operators can still
  // type a free-form name; the picker is just a hint.
  const knownBindingNames = useMemo(() => {
    const s = new Set<string>();
    for (const k of props.kinds) for (const b of k.datasetBindings ?? []) s.add(b);
    return [...s].sort();
  }, [props.kinds]);

  // Connections compatible with the binding name the user picked.
  // Filters by which kinds declare this binding name in their
  // datasetBindings manifest.
  const compatibleConnections = useMemo(() => {
    if (!draft.name) return props.connections;
    const matchingKinds = new Set(
      props.kinds
        .filter((k) => (k.datasetBindings ?? []).includes(draft.name))
        .map((k) => k.kind)
    );
    if (matchingKinds.size === 0) return props.connections;
    return props.connections.filter((c) => matchingKinds.has(c.kind));
  }, [props.connections, props.kinds, draft.name]);

  const save = useMutation({
    mutationFn: async (
      next: Record<
        string,
        { connection?: string; collection?: string; namespace?: string }
      >
    ) => api.updateDataset(props.dataset.id, { bindings: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["datasets-all"] });
      qc.invalidateQueries({ queryKey: ["dataset", props.dataset.id] });
      qc.invalidateQueries({ queryKey: ["dataset-used-by", props.dataset.id] });
      setAdding(false);
      setDraft(emptyBindingDraft());
      setFormError(null);
    },
    onError: (e) => setFormError(errText(e))
  });

  const submitAdd = (): void => {
    setFormError(null);
    if (!draft.name.trim()) {
      setFormError("binding name is required");
      return;
    }
    if (!draft.connection) {
      setFormError("pick a connection");
      return;
    }
    const merged = { ...(props.dataset.bindings ?? {}) };
    merged[draft.name.trim()] = {
      connection: draft.connection,
      ...(draft.collection.trim() ? { collection: draft.collection.trim() } : {}),
      ...(draft.namespace ? { namespace: draft.namespace } : {})
    };
    save.mutate(merged);
  };

  const remove = (name: string): void => {
    const merged = { ...(props.dataset.bindings ?? {}) };
    delete merged[name];
    save.mutate(merged);
  };

  const patchOne = (
    name: string,
    patch: Partial<{ connection: string; collection: string; namespace: string }>
  ): void => {
    const merged = { ...(props.dataset.bindings ?? {}) };
    const current = merged[name] ?? {};
    merged[name] = {
      connection: patch.connection ?? current.connection,
      collection:
        patch.collection !== undefined
          ? patch.collection || undefined
          : current.collection,
      namespace:
        patch.namespace !== undefined
          ? patch.namespace || undefined
          : current.namespace
    };
    save.mutate(merged);
  };

  const bindings = Object.entries(props.dataset.bindings ?? {});

  return (
    <section style={{ marginTop: 16 }}>
      <h3 style={{ marginBottom: 6 }}>Bindings</h3>
      <p className="muted" style={{ fontSize: "0.85em", marginTop: 0 }}>
        Each binding is a named slot a pipeline plugin can ask for —
        e.g. <code>vectors</code>, <code>text</code>, <code>graph</code>,
        <code>rows</code>. A plugin requesting binding <code>vectors</code> on
        this dataset will be handed the connection + collection wired
        below. Connection kinds advertise which slots they can fill on
        the Connections screen.
      </p>
      <table className="grid" style={{ marginTop: 8 }}>
        <thead>
          <tr>
            <th>Binding</th>
            <th>Connection</th>
            <th>Collection / index</th>
            <th>Namespace</th>
            <th>Probe</th>
            {props.canAdmin && <th></th>}
          </tr>
        </thead>
        <tbody>
          {bindings.length === 0 && (
            <tr>
              <td colSpan={props.canAdmin ? 6 : 5} className="muted">
                No bindings yet. Add one below — plugins requiring a slot
                on this dataset will fail until at least one matching
                binding exists.
              </td>
            </tr>
          )}
          {bindings.map(([name, b]) => {
            const conn = b?.connection ? connBySlug.get(b.connection) : undefined;
            const kindInfo = conn ? kindByName.get(conn.kind) : undefined;
            return (
              <tr key={name}>
                <td>
                  <code>{name}</code>
                </td>
                <td>
                  {props.canAdmin ? (
                    <select
                      value={b?.connection ?? ""}
                      onChange={(e) => patchOne(name, { connection: e.target.value })}
                      disabled={save.isPending}
                    >
                      <option value="">— pick connection —</option>
                      {props.connections.map((c) => (
                        <option key={c.id} value={c.slug}>
                          {c.slug} · {kindByName.get(c.kind)?.displayName ?? c.kind}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span>
                      <code>{b?.connection ?? "—"}</code>{" "}
                      {kindInfo && <span className="muted">· {kindInfo.displayName}</span>}
                    </span>
                  )}
                </td>
                <td>
                  {props.canAdmin ? (
                    <input
                      type="text"
                      defaultValue={b?.collection ?? ""}
                      onBlur={(e) => {
                        if (e.target.value !== (b?.collection ?? "")) {
                          patchOne(name, { collection: e.target.value });
                        }
                      }}
                      placeholder="(defaults to version's backendCollections)"
                      style={{ width: "100%" }}
                      disabled={save.isPending}
                    />
                  ) : (
                    <code>{b?.collection ?? "(default)"}</code>
                  )}
                </td>
                <td>
                  {props.canAdmin ? (
                    <select
                      value={b?.namespace ?? ""}
                      onChange={(e) => patchOne(name, { namespace: e.target.value })}
                      disabled={save.isPending}
                    >
                      <option value="">shared</option>
                      <option value="by-tenant">by-tenant</option>
                      <option value="by-env">by-env</option>
                      <option value="by-tenant-env">by-tenant-env</option>
                    </select>
                  ) : (
                    <span className="muted">{b?.namespace ?? "shared"}</span>
                  )}
                </td>
                <td>
                  {!conn ? (
                    <span className="muted">no connection</span>
                  ) : conn.lastProbeOk === null ? (
                    <span className="muted">never probed</span>
                  ) : conn.lastProbeOk ? (
                    <span
                      className="status status-succeeded"
                      title={`Last probe ${fmtTimestamp(conn.lastProbedAt)}`}
                    >
                      ok
                    </span>
                  ) : (
                    <span
                      className="status status-failed"
                      title={conn.lastProbeError ?? "probe failed"}
                    >
                      down
                    </span>
                  )}
                </td>
                {props.canAdmin && (
                  <td>
                    <button
                      className="link-btn error"
                      onClick={() => {
                        if (window.confirm(`Remove binding "${name}"?`))
                          remove(name);
                      }}
                      disabled={save.isPending}
                    >
                      remove
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {save.isError && <p className="error">{errText(save.error)}</p>}

      {props.canAdmin && !adding && (
        <button
          className="link-btn"
          style={{ marginTop: 8 }}
          onClick={() => {
            setDraft(emptyBindingDraft());
            setFormError(null);
            setAdding(true);
          }}
        >
          + add binding
        </button>
      )}
      {props.canAdmin && adding && (
        <div
          className="settings-card"
          style={{ marginTop: 12, padding: 12, display: "grid", gap: 8, gridTemplateColumns: "1fr 1fr 1fr 1fr" }}
        >
          <label>
            <div className="muted" style={{ fontSize: "0.85em" }}>Binding name</div>
            <input
              list="binding-name-options"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value, connection: "" })}
              placeholder="vectors / text / graph / …"
            />
            <datalist id="binding-name-options">
              {knownBindingNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </label>
          <label>
            <div className="muted" style={{ fontSize: "0.85em" }}>Connection</div>
            <select
              value={draft.connection}
              onChange={(e) => setDraft({ ...draft, connection: e.target.value })}
            >
              <option value="">— pick connection —</option>
              {compatibleConnections.map((c) => (
                <option key={c.id} value={c.slug}>
                  {c.slug} · {kindByName.get(c.kind)?.displayName ?? c.kind}
                </option>
              ))}
            </select>
            {draft.name && compatibleConnections.length === 0 && (
              <div className="muted" style={{ fontSize: "0.75em" }}>
                No registered connection kind declares this binding — create
                one in Connections, or pick a different name.
              </div>
            )}
          </label>
          <label>
            <div className="muted" style={{ fontSize: "0.85em" }}>
              Collection (optional)
            </div>
            <input
              value={draft.collection}
              onChange={(e) => setDraft({ ...draft, collection: e.target.value })}
              placeholder="(defaults to version's name)"
            />
          </label>
          <label>
            <div className="muted" style={{ fontSize: "0.85em" }}>Namespace</div>
            <select
              value={draft.namespace}
              onChange={(e) => setDraft({ ...draft, namespace: e.target.value })}
            >
              <option value="">shared</option>
              <option value="by-tenant">by-tenant</option>
              <option value="by-env">by-env</option>
              <option value="by-tenant-env">by-tenant-env</option>
            </select>
          </label>
          {formError && (
            <p className="error" style={{ gridColumn: "1 / -1" }}>
              {formError}
            </p>
          )}
          <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
            <button className="primary" onClick={submitAdd} disabled={save.isPending}>
              Add
            </button>
            <button
              onClick={() => {
                setAdding(false);
                setFormError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ===========================================================================
// Used-by panel — server-side cross-ref
// ===========================================================================

function UsedBySection(props: { dataset: DatasetView }) {
  const navigate = useNavigate();
  const usedBy = useQuery({
    queryKey: ["dataset-used-by", props.dataset.id],
    queryFn: () => api.getDatasetUsedBy(props.dataset.id),
    staleTime: 30_000
  });
  if (usedBy.isLoading) {
    return (
      <section style={{ marginTop: 16 }}>
        <h3>Used by</h3>
        <p className="muted">Loading cross-refs…</p>
      </section>
    );
  }
  const pipelines = usedBy.data?.pipelines ?? [];
  return (
    <section style={{ marginTop: 16 }}>
      <h3>Used by</h3>
      {pipelines.length === 0 ? (
        <p className="muted">
          No pipeline wires this slug yet. Pin a dataset slug from any
          storage-touching node in the Builder.
        </p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Pipeline</th>
              <th>Nodes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {pipelines.map((p) => (
              <tr key={p.id}>
                <td>
                  <code>{p.slug}</code>
                  <br />
                  <span className="muted">{p.name}</span>
                </td>
                <td>
                  {p.nodes.map((n) => (
                    <span key={n.id} style={{ marginRight: 8 }}>
                      <code>{n.id}</code>
                      {n.bindingName && (
                        <span className="muted"> ({n.bindingName})</span>
                      )}
                    </span>
                  ))}
                </td>
                <td>
                  <button
                    className="link-btn"
                    onClick={() => navigate(`/builder/${encodeURIComponent(p.id)}`)}
                  >
                    open in builder
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ===========================================================================
// Versions + aliases — collapsible secondary surface
// ===========================================================================

function VersionsSection(props: { dataset: DatasetView; canAdmin: boolean }) {
  const qc = useQueryClient();
  const versions = useQuery({
    queryKey: ["dataset-versions", props.dataset.id],
    queryFn: () => api.listDatasetVersions(props.dataset.id),
    staleTime: 30_000
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
    <>
      <h4 style={{ marginTop: 16 }}>Versions</h4>
      {versionList.length === 0 ? (
        <p className="muted">No versions cut yet.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Version</th>
              <th>Status</th>
              <th>Backend collections</th>
              <th>Created</th>
              <th>Current</th>
            </tr>
          </thead>
          <tbody>
            {versionList.map((v: DatasetVersionView) => (
              <tr key={v.id}>
                <td>
                  <strong>{v.versionLabel}</strong>
                </td>
                <td>
                  <span
                    className={`status ${
                      v.status === "ready"
                        ? "status-succeeded"
                        : v.status === "building"
                          ? "status-running"
                          : "status-cancelled"
                    }`}
                  >
                    {v.status}
                  </span>
                </td>
                <td>
                  <code style={{ fontSize: "0.85em" }}>
                    {Object.entries(v.backendCollections)
                      .map(([m, c]) => `${m}:${c}`)
                      .join(", ") || "—"}
                  </code>
                </td>
                <td>{new Date(v.createdAt).toLocaleString()}</td>
                <td>
                  {props.dataset.currentVersionId === v.id && (
                    <span className="status status-running">current</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4 style={{ marginTop: 16 }}>Aliases</h4>
      {aliasList.length === 0 ? (
        <p className="muted">No aliases.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Alias</th>
              <th>Points to</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {aliasList.map((a: DatasetAliasView) => {
              const ver = versionList.find((v) => v.id === a.versionId);
              return (
                <tr key={a.id}>
                  <td>
                    <strong>{a.alias}</strong>
                  </td>
                  <td>
                    {ver
                      ? `${ver.versionLabel} (${ver.status})`
                      : a.versionId.slice(0, 8) + "…"}
                  </td>
                  <td>{new Date(a.updatedAt).toLocaleString()}</td>
                  <td>
                    {props.canAdmin && (
                      <select
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
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {aliasSwap.isError && <p className="error">{errText(aliasSwap.error)}</p>}
    </>
  );
}

// ===========================================================================
// Detail panel — the right pane when a dataset is selected
// ===========================================================================

function DatasetDetail(props: {
  dataset: DatasetView;
  canAdmin: boolean;
  connections: ConnectionView[];
  kinds: ConnectionKindInfo[];
}) {
  const qc = useQueryClient();
  const archive = useMutation({
    mutationFn: () =>
      api.updateDataset(props.dataset.id, {
        archived: !props.dataset.archivedAt
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["datasets-all"] })
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  // Hard delete is separate from archive — archive flips a flag, delete
  // removes the row + cascades versions/aliases. The modal handles
  // refuse-on-used-by with the pipelineReferences count from the same
  // walk GET /:id/used-by uses.
  const [deleteOpen, setDeleteOpen] = useState(false);
  return (
    <section className="settings-card" style={{ marginTop: 16, padding: 16 }}>
      <header
        style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}
      >
        <div>
          <h2 style={{ margin: 0 }}>{props.dataset.displayName}</h2>
          <div className="muted">
            <code>{props.dataset.slug}</code> · scope{" "}
            {props.dataset.scope === "global"
              ? "global"
              : props.dataset.scope === "tenant"
                ? `tenant ${props.dataset.tenantId?.slice(0, 8)}…`
                : `tenant ${props.dataset.tenantId?.slice(0, 8)}… · env ${props.dataset.environmentId}`}
            {props.dataset.archivedAt ? " · archived" : ""}
          </div>
          {props.dataset.description && (
            <p style={{ marginTop: 8 }}>{props.dataset.description}</p>
          )}
        </div>
        {props.canAdmin && (
          <div style={{ display: "flex", gap: 12 }}>
            <button
              className="link-btn"
              onClick={() => archive.mutate()}
              disabled={archive.isPending}
            >
              {props.dataset.archivedAt ? "Unarchive" : "Archive"}
            </button>
            <button
              className="link-btn danger"
              onClick={() => setDeleteOpen(true)}
              title="Delete this dataset. Refuses if any pipeline spec references the slug; force-delete cascades versions/aliases (pipeline references become dangling, operator opt-in)."
            >
              Delete
            </button>
          </div>
        )}
      </header>
      <CascadeDeleteModal
        open={deleteOpen}
        resourceLabel={`dataset "${props.dataset.slug}"`}
        description="Deleting a dataset is rejected by default when any pipeline references its slug. Force-delete cascades versions and aliases; pipeline specs that embed the slug become dangling references and fail at execute time (operator opt-in)."
        doDelete={({ force }) => api.deleteDataset(props.dataset.id, { force })}
        onDeleted={() => {
          setDeleteOpen(false);
          qc.invalidateQueries({ queryKey: ["datasets-all"] });
        }}
        onClose={() => setDeleteOpen(false)}
      />

      <BindingsSection
        dataset={props.dataset}
        canAdmin={props.canAdmin}
        connections={props.connections}
        kinds={props.kinds}
      />

      <UsedBySection dataset={props.dataset} />

      <section style={{ marginTop: 16 }}>
        <button className="link-btn" onClick={() => setShowVersions((v) => !v)}>
          {showVersions ? "▾" : "▸"} Versions + aliases
        </button>
        {showVersions && (
          <VersionsSection dataset={props.dataset} canAdmin={props.canAdmin} />
        )}
      </section>

      <section style={{ marginTop: 12 }}>
        <button className="link-btn" onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? "▾" : "▸"} Embedding profile + chunk schema
        </button>
        {showAdvanced && (
          <>
            <h4>Embedding profile</h4>
            <pre className="codeblock">
              {JSON.stringify(props.dataset.embeddingProfile, null, 2)}
            </pre>
            <h4>Chunk schema</h4>
            <pre className="codeblock">
              {JSON.stringify(props.dataset.chunkSchema, null, 2)}
            </pre>
          </>
        )}
      </section>
    </section>
  );
}

// ===========================================================================
// New-dataset form (top of the right pane)
// ===========================================================================

function CreateDatasetForm(props: {
  scope: Scope;
  tenantId?: string;
  environmentId?: string;
  onCreated: (d: DatasetView) => void;
}) {
  const qc = useQueryClient();
  const { tenants } = useTenants();
  const { environments } = useEnvironments(props.tenantId);
  const auth = useAuth();
  const hasGlobalAdmin = useMemo(
    () => auth.grants.some((g) => g.scope === "*"),
    [auth.grants]
  );
  const [scope, setScope] = useState<Scope>(props.scope);
  const [tenantId, setTenantId] = useState(props.tenantId ?? "");
  const [environmentId, setEnvironmentId] = useState(props.environmentId ?? "");
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    setScope(props.scope);
    setTenantId(props.tenantId ?? "");
    setEnvironmentId(props.environmentId ?? "");
  }, [props.scope, props.tenantId, props.environmentId]);

  const create = useMutation({
    mutationFn: () =>
      api.createDataset({
        scope,
        slug: slug.trim(),
        displayName: displayName.trim() || slug.trim(),
        description: description.trim() || undefined,
        tenantId: scope === "global" ? undefined : tenantId || undefined,
        environmentId: scope === "environment" ? environmentId || undefined : undefined,
        bindings: {}
      }),
    onSuccess: (res) => {
      setSlug("");
      setDisplayName("");
      setDescription("");
      qc.invalidateQueries({ queryKey: ["datasets-all"] });
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
      <select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
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
      <input
        placeholder="slug (a-z0-9_-)"
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
        required
        pattern="[a-z0-9][a-z0-9_-]{0,62}"
        title="lowercase letters / digits / _ - ; 1..63 chars"
      />
      <input
        placeholder="Display name (defaults to slug)"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
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

// ===========================================================================
// Top-level screen
// ===========================================================================

export function DatasetsScreen() {
  const auth = useAuth();
  const canAdmin = auth.can("dataset:admin");
  const { tenants } = useTenants();
  const navigate = useNavigate();
  const { datasetId: routeId } = useParams<{ datasetId?: string }>();
  const [selectedKey, setSelectedKey] = useState("global");
  const [filter, setFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const ctx = useMemo<{
    tenantId?: string;
    envId?: string;
    isGlobal: boolean;
    scope: Scope;
  }>(() => {
    if (selectedKey === "global") return { isGlobal: true, scope: "global" };
    const m = selectedKey.match(/^tenant:([^|]+)(?:\|env:(.+))?$/);
    if (m) {
      return {
        tenantId: m[1],
        envId: m[2],
        isGlobal: false,
        scope: m[2] ? "environment" : "tenant"
      };
    }
    return { isGlobal: false, scope: "tenant" };
  }, [selectedKey]);

  useEffect(() => {
    api.setTenant(tenantIdFromScopeKey(selectedKey));
  }, [selectedKey]);

  const datasets = useQuery({
    // showArchived in the key so toggling re-fetches — the server hides
    // archived rows by default and only includes them when the screen
    // opts in. Without this segment, react-query would serve the
    // cached active-only list when the user flips the toggle on
    // (same trap the Connections screen fix solved).
    queryKey: [
      "datasets-all",
      ctx.tenantId ?? "global",
      ctx.envId ?? "",
      showArchived ? "with-archived" : "active-only"
    ],
    queryFn: () =>
      api.listDatasets({
        tenantId: ctx.tenantId,
        environmentId: ctx.envId,
        includeArchived: showArchived
      })
  });
  // The detail panel needs connections + kinds to render the bindings
  // picker; load both once at the screen level and pass down. Same data
  // the Connections screen uses; React Query dedupes when both are open.
  const connections = useQuery({
    queryKey: ["connections", ctx.tenantId ?? "global", ctx.envId ?? ""],
    queryFn: () =>
      api.listConnections({
        tenantId: ctx.tenantId,
        environmentId: ctx.envId
      })
  });
  const kinds = useQuery({
    queryKey: ["connection-kinds"],
    queryFn: () => api.listConnectionKinds()
  });

  const fallbackDataset = useQuery({
    queryKey: ["dataset", routeId],
    queryFn: () => api.getDataset(routeId as string),
    enabled: !!routeId && !(datasets.data?.datasets ?? []).some((d) => d.id === routeId)
  });

  const rows = useMemo(() => {
    const all = datasets.data?.datasets ?? [];
    const q = filter.trim().toLowerCase();
    return all.filter((d) => {
      if (!showArchived && d.archivedAt) return false;
      if (!q) return true;
      return (
        d.slug.toLowerCase().includes(q) ||
        d.displayName.toLowerCase().includes(q)
      );
    });
  }, [datasets.data, filter, showArchived]);

  const selected =
    rows.find((d) => d.id === routeId) ??
    (datasets.data?.datasets ?? []).find((d) => d.id === routeId) ??
    fallbackDataset.data?.dataset ??
    null;

  const setSelectedId = (id: string | null): void => {
    navigate(id ? `/datasets/${encodeURIComponent(id)}` : "/datasets");
  };

  const scopeRoot = useMemo<ScopeNode>(
    () => buildScopeTree(tenants ?? [], []),
    [tenants]
  );
  const node = findScopeNode(scopeRoot, selectedKey) ?? scopeRoot;

  return (
    <Screen
      title="Datasets"
      isLoading={datasets.isLoading}
      error={datasets.error}
    >
      <div className="scope-layout">
        <aside className="scope-tree">
          <h2>Scope</h2>
          <ScopeTree
            root={scopeRoot}
            selectedKey={selectedKey}
            onSelect={(k) => {
              setSelectedKey(k);
              setSelectedId(null);
            }}
          />
          <p className="muted" style={{ fontSize: "0.8em", marginTop: 12 }}>
            Pick a scope to filter the list. Cascade still applies —
            tenant view includes inherited globals, env view inherits
            both above.
          </p>
        </aside>
        <div className="scope-body">
          <h2>
            {node.scope === "global"
              ? "Global · cluster-wide datasets"
              : node.scope === "tenant"
                ? `Tenant ${node.label} · tenant + inherited`
                : `Env ${node.label} · env + inherited`}
          </h2>

          {canAdmin && (
            <div style={{ marginBottom: 12 }}>
              <CreateDatasetForm
                scope={ctx.scope}
                tenantId={ctx.tenantId}
                environmentId={ctx.envId}
                onCreated={(d) => setSelectedId(d.id)}
              />
            </div>
          )}

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <input
              placeholder="filter slug / name…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ minWidth: 240 }}
            />
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              show archived
            </label>
          </div>

          <table className="grid">
            <thead>
              <tr>
                <th>Slug</th>
                <th>Display name</th>
                <th>Scope</th>
                <th>Bindings</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    {datasets.data
                      ? "No datasets at this scope. Create one above."
                      : "Loading…"}
                  </td>
                </tr>
              )}
              {rows.map((d) => (
                <tr
                  key={d.id}
                  onClick={() => setSelectedId(d.id)}
                  className={
                    "row-selectable" +
                    (d.id === selected?.id ? " row-selected" : "")
                  }
                  style={d.archivedAt ? { opacity: 0.55 } : undefined}
                >
                  <td>
                    <code>{d.slug}</code>
                  </td>
                  <td>{d.displayName}</td>
                  <td>
                    {d.scope === "global"
                      ? "global"
                      : d.scope === "tenant"
                        ? "tenant"
                        : `env: ${d.environmentId}`}
                  </td>
                  <td>
                    {Object.keys(d.bindings ?? {}).length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      <code style={{ fontSize: "0.85em" }}>
                        {Object.keys(d.bindings).join(" · ")}
                      </code>
                    )}
                  </td>
                  <td>
                    {d.archivedAt ? (
                      <span className="status status-cancelled">archived</span>
                    ) : (
                      <span className="status status-succeeded">active</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {selected && (
            <DatasetDetail
              dataset={selected}
              canAdmin={canAdmin}
              connections={connections.data?.connections ?? []}
              kinds={kinds.data?.kinds ?? []}
            />
          )}
        </div>
      </div>
    </Screen>
  );
}
