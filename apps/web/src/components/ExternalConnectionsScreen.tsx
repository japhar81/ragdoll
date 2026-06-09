/**
 * External Connections admin (ADR-0021).
 *
 * Distinct from the per-tenant /connections screen — that one lists the
 * legacy `datasource_connections` rows (ADR-0020 + the scope-cascade
 * inheritance UI). This screen surfaces the new
 * `external_connections` registry: a flat list of named, RBAC'd
 * connections that pipeline nodes reference via `connection: { slug }`.
 *
 * Operator workflow:
 *   1. Create a row at the desired scope (global / tenant / environment)
 *      with `kind` + `options` + optional `secretRefId`.
 *   2. Reference it from a pipeline node and run the pipeline — the
 *      runtime resolves the slug via env -> tenant -> global cascade
 *      and hands the plugin a ResolvedExternalConnection.
 *   3. Hit "Probe" to verify the driver can actually reach the
 *      configured endpoint; the result is recorded on the row so the
 *      table shows green/red badges at a glance.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ExternalConnectionView } from "../lib/api.ts";
import { useTenants } from "./useTenants.tsx";
import { useAuth } from "../auth/AuthContext.tsx";
import { Screen } from "./Screen.tsx";

type Scope = "global" | "tenant" | "environment";

interface DraftConnection {
  scope: Scope;
  slug: string;
  displayName: string;
  description: string;
  kind: string;
  tenantId: string;
  environmentId: string;
  secretRefId: string;
  optionsJson: string;
}

const EMPTY_DRAFT: DraftConnection = {
  scope: "global",
  slug: "",
  displayName: "",
  description: "",
  kind: "mongodb",
  tenantId: "",
  environmentId: "",
  secretRefId: "",
  optionsJson: "{}"
};

function draftFromConnection(c: ExternalConnectionView): DraftConnection {
  return {
    scope: c.scope,
    slug: c.slug,
    displayName: c.displayName,
    description: c.description ?? "",
    kind: c.kind,
    tenantId: c.tenantId ?? "",
    environmentId: c.environmentId ?? "",
    secretRefId: c.secretRefId ?? "",
    optionsJson: JSON.stringify(c.options ?? {}, null, 2)
  };
}

function fmtTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function ProbeBadge(props: {
  ok: boolean | null | undefined;
  at: string | null | undefined;
  error: string | null | undefined;
}) {
  if (props.ok === null || props.ok === undefined) {
    return <span className="muted">never probed</span>;
  }
  if (props.ok) {
    return (
      <span className="status status-succeeded" title={`Probed ${fmtTimestamp(props.at)}`}>
        ok
      </span>
    );
  }
  return (
    <span
      className="status status-failed"
      title={props.error ?? "probe failed"}
    >
      down
    </span>
  );
}

export function ExternalConnectionsScreen() {
  const qc = useQueryClient();
  const auth = useAuth();
  const canAdmin = auth.can("external_connection:admin");
  const [filter, setFilter] = useState("");
  const [kindFilter, setKindFilter] = useState<string>("");
  const [scopeFilter, setScopeFilter] = useState<"" | Scope>("");
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<DraftConnection>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);

  const tenants = useTenants();
  const list = useQuery({
    queryKey: ["external-connections"],
    queryFn: () => api.listExternalConnections()
  });

  const rows = useMemo(() => {
    const items = list.data?.connections ?? [];
    const q = filter.trim().toLowerCase();
    return items.filter((c) => {
      if (!showArchived && c.archivedAt) return false;
      if (kindFilter && c.kind !== kindFilter) return false;
      if (scopeFilter && c.scope !== scopeFilter) return false;
      if (!q) return true;
      return (
        c.slug.toLowerCase().includes(q) ||
        c.displayName.toLowerCase().includes(q) ||
        c.kind.toLowerCase().includes(q)
      );
    });
  }, [list.data, filter, kindFilter, scopeFilter, showArchived]);

  const knownKinds = useMemo(() => {
    const set = new Set<string>();
    for (const c of list.data?.connections ?? []) set.add(c.kind);
    // Seed with the families we ship out of the box so the filter
    // dropdown isn't empty when the registry has nothing yet.
    set.add("mongodb");
    set.add("clickhouse");
    return [...set].sort();
  }, [list.data]);

  const tenantName = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tenants.data?.tenants ?? []) m.set(t.id, t.name ?? t.slug);
    return m;
  }, [tenants.data]);

  function openNew(): void {
    setDraft({ ...EMPTY_DRAFT });
    setFormError(null);
    setEditing("new");
  }

  function openEdit(c: ExternalConnectionView): void {
    setDraft(draftFromConnection(c));
    setFormError(null);
    setEditing(c.id);
  }

  function closeEditor(): void {
    setEditing(null);
    setFormError(null);
  }

  const create = useMutation({
    mutationFn: () => {
      const options = JSON.parse(draft.optionsJson || "{}");
      return api.createExternalConnection({
        scope: draft.scope,
        slug: draft.slug,
        displayName: draft.displayName,
        description: draft.description || undefined,
        kind: draft.kind,
        tenantId: draft.scope === "global" ? undefined : draft.tenantId || undefined,
        environmentId:
          draft.scope === "environment" ? draft.environmentId || undefined : undefined,
        secretRefId: draft.secretRefId || undefined,
        options
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["external-connections"] });
      closeEditor();
    },
    onError: (e) => setFormError(e instanceof Error ? e.message : String(e))
  });

  const update = useMutation({
    mutationFn: (id: string) => {
      const options = JSON.parse(draft.optionsJson || "{}");
      return api.updateExternalConnection(id, {
        displayName: draft.displayName,
        description: draft.description || null,
        kind: draft.kind,
        secretRefId: draft.secretRefId || null,
        options
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["external-connections"] });
      closeEditor();
    },
    onError: (e) => setFormError(e instanceof Error ? e.message : String(e))
  });

  const archive = useMutation({
    mutationFn: (id: string) => api.deleteExternalConnection(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["external-connections"] })
  });

  const probe = useMutation({
    mutationFn: (id: string) => api.probeExternalConnection(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["external-connections"] })
  });

  function submit(): void {
    setFormError(null);
    try {
      // Validate JSON eagerly so the user gets a clear in-line message
      // rather than a 422 from the API.
      JSON.parse(draft.optionsJson || "{}");
    } catch (e) {
      setFormError(`options must be valid JSON: ${(e as Error).message}`);
      return;
    }
    if (!draft.slug.trim() || !draft.displayName.trim() || !draft.kind.trim()) {
      setFormError("slug, displayName, and kind are required");
      return;
    }
    if (editing === "new") create.mutate();
    else if (editing) update.mutate(editing);
  }

  return (
    <Screen
      title="External Connections"
      isLoading={list.isLoading}
      error={list.error}
    >
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <input
          placeholder="filter slug / name / kind…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ minWidth: 240 }}
        />
        <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
          <option value="">all kinds</option>
          {knownKinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select
          value={scopeFilter}
          onChange={(e) => setScopeFilter(e.target.value as "" | Scope)}
        >
          <option value="">all scopes</option>
          <option value="global">global</option>
          <option value="tenant">tenant</option>
          <option value="environment">environment</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          show archived
        </label>
        <span style={{ flex: 1 }} />
        {canAdmin && (
          <button className="primary" onClick={openNew} disabled={editing === "new"}>
            + New connection
          </button>
        )}
      </div>

      <table className="grid">
        <thead>
          <tr>
            <th>Slug</th>
            <th>Display name</th>
            <th>Kind</th>
            <th>Scope</th>
            <th>Tenant / Env</th>
            <th>Probe</th>
            <th>Updated</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={8} className="muted">
                {list.data ? "No connections match." : "Loading…"}
              </td>
            </tr>
          )}
          {rows.map((c) => (
            <tr
              key={c.id}
              style={c.archivedAt ? { opacity: 0.55 } : undefined}
            >
              <td>
                <code>{c.slug}</code>
              </td>
              <td>{c.displayName}</td>
              <td>
                <span className="status">{c.kind}</span>
              </td>
              <td>{c.scope}</td>
              <td>
                {c.scope === "global"
                  ? "—"
                  : `${tenantName.get(c.tenantId ?? "") ?? c.tenantId ?? "?"}${
                      c.environmentId ? ` / ${c.environmentId}` : ""
                    }`}
              </td>
              <td>
                <ProbeBadge
                  ok={c.lastProbeOk}
                  at={c.lastProbedAt}
                  error={c.lastProbeError}
                />
              </td>
              <td>{fmtTimestamp(c.updatedAt)}</td>
              <td style={{ whiteSpace: "nowrap" }}>
                {canAdmin && !c.archivedAt && (
                  <>
                    <button
                      className="link-btn"
                      onClick={() => openEdit(c)}
                      disabled={editing === c.id}
                    >
                      edit
                    </button>
                    {" · "}
                    <button
                      className="link-btn"
                      onClick={() => probe.mutate(c.id)}
                      disabled={probe.isPending}
                    >
                      probe
                    </button>
                    {" · "}
                    <button
                      className="link-btn error"
                      onClick={() => {
                        if (window.confirm(`Archive ${c.slug}?`)) archive.mutate(c.id);
                      }}
                    >
                      archive
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing && canAdmin && (
        <section
          className="exec-detail"
          style={{ marginTop: 16, padding: 16 }}
        >
          <h2>{editing === "new" ? "New connection" : `Edit ${draft.slug}`}</h2>
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }}>
            <label>
              <div className="muted">Scope</div>
              <select
                value={draft.scope}
                disabled={editing !== "new"}
                onChange={(e) =>
                  setDraft({ ...draft, scope: e.target.value as Scope })
                }
              >
                <option value="global">global</option>
                <option value="tenant">tenant</option>
                <option value="environment">environment</option>
              </select>
            </label>
            <label>
              <div className="muted">Kind</div>
              <input
                value={draft.kind}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
                placeholder="mongodb / clickhouse / …"
                list="ec-kinds"
              />
              <datalist id="ec-kinds">
                {knownKinds.map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
            </label>
            <label>
              <div className="muted">Slug</div>
              <input
                value={draft.slug}
                disabled={editing !== "new"}
                onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
                placeholder="acme-reporting"
              />
            </label>
            <label>
              <div className="muted">Display name</div>
              <input
                value={draft.displayName}
                onChange={(e) =>
                  setDraft({ ...draft, displayName: e.target.value })
                }
                placeholder="Acme Reporting Warehouse"
              />
            </label>
            {draft.scope !== "global" && (
              <label>
                <div className="muted">Tenant</div>
                <select
                  value={draft.tenantId}
                  disabled={editing !== "new"}
                  onChange={(e) => setDraft({ ...draft, tenantId: e.target.value })}
                >
                  <option value="">(select tenant)</option>
                  {(tenants.data?.tenants ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name ?? t.slug}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {draft.scope === "environment" && (
              <label>
                <div className="muted">Environment</div>
                <input
                  value={draft.environmentId}
                  disabled={editing !== "new"}
                  onChange={(e) =>
                    setDraft({ ...draft, environmentId: e.target.value })
                  }
                  placeholder="dev / prod"
                />
              </label>
            )}
            <label>
              <div className="muted">Secret ref id</div>
              <input
                value={draft.secretRefId}
                onChange={(e) =>
                  setDraft({ ...draft, secretRefId: e.target.value })
                }
                placeholder="(optional — uuid of a row in the secrets table)"
              />
            </label>
            <label style={{ gridColumn: "1 / -1" }}>
              <div className="muted">Description</div>
              <input
                value={draft.description}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
                placeholder="(optional)"
              />
            </label>
            <label style={{ gridColumn: "1 / -1" }}>
              <div className="muted">
                Options (JSON — per-kind config like{" "}
                <code>{`{"database": "..."}`}</code> for mongodb or{" "}
                <code>{`{"url": "...", "database": "..."}`}</code> for clickhouse)
              </div>
              <textarea
                rows={6}
                value={draft.optionsJson}
                onChange={(e) =>
                  setDraft({ ...draft, optionsJson: e.target.value })
                }
                style={{ width: "100%", fontFamily: "monospace" }}
              />
            </label>
          </div>
          {formError && <p className="error">{formError}</p>}
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button
              className="primary"
              onClick={submit}
              disabled={create.isPending || update.isPending}
            >
              {editing === "new" ? "Create" : "Save"}
            </button>
            <button onClick={closeEditor}>Cancel</button>
          </div>
        </section>
      )}
    </Screen>
  );
}
