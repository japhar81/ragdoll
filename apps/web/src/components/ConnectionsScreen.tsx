/**
 * Connections admin (ADR-0023).
 *
 * Single screen for the unified `connections` table. Supersedes the
 * per-tenant datasource-connections UI (ADR-0020) AND the parallel
 * "Ext. Connections" screen (ADR-0021). One mental model: a connection
 * is a named DB pointer with creds, scope (global/tenant/env), and a
 * health badge.
 *
 * Layout:
 *  - Scope tree on the left (Global / Tenant / Env). Same widget the
 *    Secrets and Config screens use; sticky-positioned per the earlier
 *    UX fix.
 *  - Right pane: flat list of connections visible at the selected scope
 *    + the inheritance cascade (globals show up under tenants, tenant
 *    rows show up under their envs). Search + kind filter narrow.
 *  - "+ New connection" opens a side editor with a schema-driven form
 *    rendered from /api/connection-kinds. Authors pick a Type, the
 *    form materialises from the driver plugin's configSchema (ADR-0024
 *    — no per-kind hand-rolled TSX).
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type ConnectionView,
  type ConnectionKindInfo
} from "../lib/api.ts";
import type { JsonSchemaLike } from "../lib/api.ts";
import { buildScopeTree, findScopeNode, type ScopeNode } from "../lib/orgtree.ts";
import { tenantIdFromScopeKey } from "../lib/tenantContext.ts";
import { useTenants } from "./useTenants.tsx";
import { useEnvironments, EnvironmentSelect } from "./useEnvironments.tsx";
import { useAuth } from "../auth/AuthContext.tsx";
import { Screen } from "./Screen.tsx";
import { ScopeTree } from "./ConfigScreen.tsx";

type Scope = "global" | "tenant" | "environment";

interface Draft {
  scope: Scope;
  slug: string;
  displayName: string;
  description: string;
  kind: string;
  tenantId: string;
  environmentId: string;
  secretRefId: string;
  config: Record<string, unknown>;
}

function emptyDraft(): Draft {
  return {
    scope: "global",
    slug: "",
    displayName: "",
    description: "",
    kind: "",
    tenantId: "",
    environmentId: "",
    secretRefId: "",
    config: {}
  };
}

function fromConnection(c: ConnectionView): Draft {
  return {
    scope: c.scope,
    slug: c.slug,
    displayName: c.displayName,
    description: c.description ?? "",
    kind: c.kind,
    tenantId: c.tenantId ?? "",
    environmentId: c.environmentId ?? "",
    secretRefId: c.secretRefId ?? "",
    config: c.config ?? {}
  };
}

function fmtTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

/**
 * Per-tenant environment dropdown for the "New connection" form.
 * Wraps the shared <EnvironmentSelect>: when the user hasn't picked a
 * tenant yet, render a disabled placeholder; once the tenant is
 * chosen, fetch its environments and hand them to the select. Same
 * shape as Datasets / Builder / Scheduler — operators don't have to
 * remember per-tenant env names.
 */
function DraftEnvironmentSelect(props: {
  tenantId: string;
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
}) {
  const { environments, isLoading } = useEnvironments(props.tenantId);
  if (!props.tenantId) {
    return (
      <select value="" disabled>
        <option value="">— pick a tenant first —</option>
      </select>
    );
  }
  if (props.disabled) {
    return (
      <input
        value={props.value}
        disabled
        title="environment is pinned at create time and cannot be changed"
      />
    );
  }
  return (
    <EnvironmentSelect
      environments={environments}
      value={props.value}
      onChange={props.onChange}
      isLoading={isLoading}
    />
  );
}

function ProbeBadge(props: {
  ok: boolean | null;
  at: string | null;
  error: string | null;
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
    <span className="status status-failed" title={props.error ?? "probe failed"}>
      down
    </span>
  );
}

/**
 * Render a single field from a driver plugin's configSchema. Stays
 * deliberately simple — types we know about (string / integer /
 * number / boolean) get the right input; everything else gets a JSON
 * textarea. Future enhancement: hand off to the shared schemaForm
 * utility once that file gains support for the kinds we need.
 */
function SchemaField(props: {
  name: string;
  schema: JsonSchemaLike;
  value: unknown;
  onChange: (next: unknown) => void;
  required: boolean;
}) {
  const { name, schema, value, onChange, required } = props;
  const type = schema.type ?? "string";
  const label = (
    <div className="muted" style={{ fontSize: "0.85em" }}>
      {name}
      {required && <span className="error"> *</span>}
      {schema.description && <> — {schema.description}</>}
    </div>
  );
  if (type === "boolean") {
    return (
      <label style={{ display: "block", marginBottom: 8 }}>
        {label}
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
      </label>
    );
  }
  if (type === "integer" || type === "number") {
    return (
      <label style={{ display: "block", marginBottom: 8 }}>
        {label}
        <input
          type="number"
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          style={{ width: "100%" }}
        />
      </label>
    );
  }
  // string + default
  return (
    <label style={{ display: "block", marginBottom: 8 }}>
      {label}
      <input
        type="text"
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        placeholder={
          schema.default !== undefined ? String(schema.default) : undefined
        }
        style={{ width: "100%" }}
      />
    </label>
  );
}

function SchemaForm(props: {
  schema: JsonSchemaLike | undefined;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const { schema, value, onChange } = props;
  if (!schema || !schema.properties) {
    return (
      <p className="muted" style={{ fontSize: "0.85em" }}>
        This connection kind declares no configurable fields.
      </p>
    );
  }
  const required = new Set(schema.required ?? []);
  return (
    <div>
      {Object.entries(schema.properties).map(([name, child]) => (
        <SchemaField
          key={name}
          name={name}
          schema={child as JsonSchemaLike}
          value={value[name]}
          onChange={(next) => {
            const merged = { ...value };
            if (next === undefined) delete merged[name];
            else merged[name] = next;
            onChange(merged);
          }}
          required={required.has(name)}
        />
      ))}
    </div>
  );
}

export function ConnectionsScreen() {
  const qc = useQueryClient();
  const auth = useAuth();
  const canAdmin = auth.can("connection:admin");
  const tenants = useTenants();
  const [selectedKey, setSelectedKey] = useState("global");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [formError, setFormError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  // Resolve the (tenantId, envId) the right panel scopes to from the
  // selected ScopeTree node. Mirrors the pattern Secrets / Config use.
  const ctx = useMemo<{
    tenantId?: string;
    envId?: string;
    isGlobal: boolean;
  }>(() => {
    if (selectedKey === "global") return { isGlobal: true };
    const m = selectedKey.match(/^tenant:([^|]+)(?:\|env:(.+))?$/);
    if (m) return { tenantId: m[1], envId: m[2], isGlobal: false };
    return { isGlobal: false };
  }, [selectedKey]);

  useEffect(() => {
    // Keep the API client's x-tenant-id in sync with the selected scope.
    api.setTenant(tenantIdFromScopeKey(selectedKey));
  }, [selectedKey]);

  // Connections visible at this scope (cascade: globals + tenant +
  // env-scoped per the API's listVisibleAt rule).
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
  const kindByName = useMemo(() => {
    const m = new Map<string, ConnectionKindInfo>();
    for (const k of kinds.data?.kinds ?? []) m.set(k.kind, k);
    return m;
  }, [kinds.data]);

  // Pipeline / dataset cross-refs (the "Used by" column ADR-0023 calls
  // out). Cheap: same /api/datasets the screen already hits.
  const datasets = useQuery({
    queryKey: ["datasets-all"],
    queryFn: () => api.listDatasets()
  });
  const usedBy = useMemo(() => {
    // ADR-0023: walks dataset.bindings.<name>.connection (the slug
    // pointing at a connection row). Replaces the modality-keyed
    // backends.<m>.connectionName walk the old DatasetView shape used.
    const out = new Map<string, string[]>(); // connection slug -> [dataset slug, ...]
    for (const ds of datasets.data?.datasets ?? []) {
      for (const [, b] of Object.entries(ds.bindings ?? {})) {
        const cn = b?.connection;
        if (typeof cn === "string") {
          (out.get(cn) ?? out.set(cn, []).get(cn)!).push(ds.slug);
        }
      }
    }
    return out;
  }, [datasets.data]);

  const rows = useMemo(() => {
    const all = connections.data?.connections ?? [];
    const q = filter.trim().toLowerCase();
    return all.filter((c) => {
      if (!showArchived && c.archivedAt) return false;
      if (kindFilter && c.kind !== kindFilter) return false;
      if (!q) return true;
      return (
        c.slug.toLowerCase().includes(q) ||
        c.displayName.toLowerCase().includes(q) ||
        c.kind.toLowerCase().includes(q)
      );
    });
  }, [connections.data, filter, kindFilter, showArchived]);

  function openNew(): void {
    const d = emptyDraft();
    d.scope = ctx.isGlobal
      ? "global"
      : ctx.envId
        ? "environment"
        : "tenant";
    if (ctx.tenantId) d.tenantId = ctx.tenantId;
    if (ctx.envId) d.environmentId = ctx.envId;
    setDraft(d);
    setFormError(null);
    setEditing("new");
  }

  function openEdit(c: ConnectionView): void {
    setDraft(fromConnection(c));
    setFormError(null);
    setEditing(c.id);
  }

  function closeEditor(): void {
    setEditing(null);
    setFormError(null);
  }

  const create = useMutation({
    mutationFn: () =>
      api.createConnection({
        scope: draft.scope,
        slug: draft.slug,
        displayName: draft.displayName,
        description: draft.description || undefined,
        kind: draft.kind,
        tenantId: draft.scope === "global" ? undefined : draft.tenantId,
        environmentId:
          draft.scope === "environment" ? draft.environmentId : undefined,
        secretRefId: draft.secretRefId || undefined,
        config: draft.config
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["connections"] });
      closeEditor();
    },
    onError: (e) =>
      setFormError(e instanceof ApiError ? e.message : String(e))
  });
  const update = useMutation({
    mutationFn: (id: string) =>
      api.updateConnection(id, {
        displayName: draft.displayName,
        description: draft.description || null,
        kind: draft.kind,
        secretRefId: draft.secretRefId || null,
        config: draft.config
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["connections"] });
      closeEditor();
    },
    onError: (e) =>
      setFormError(e instanceof ApiError ? e.message : String(e))
  });
  const archive = useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["connections"] })
  });
  const probe = useMutation({
    mutationFn: (id: string) => api.probeConnection(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["connections"] })
  });

  function submit(): void {
    setFormError(null);
    if (!draft.slug.trim() || !draft.displayName.trim() || !draft.kind.trim()) {
      setFormError("slug, displayName, and kind are required");
      return;
    }
    if (editing === "new") create.mutate();
    else if (editing) update.mutate(editing);
  }

  const scopeRoot = useMemo<ScopeNode>(
    () => buildScopeTree(tenants.data?.tenants ?? [], []),
    [tenants.data]
  );
  const node = findScopeNode(scopeRoot, selectedKey) ?? scopeRoot;

  const selectedKindInfo = kindByName.get(draft.kind);

  return (
    <Screen
      title="Connections"
      isLoading={connections.isLoading}
      error={connections.error}
    >
      <div className="scope-layout">
        <aside className="scope-tree">
          <h2>Scope</h2>
          <ScopeTree
            root={scopeRoot}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
          />
          <p className="muted" style={{ fontSize: "0.8em", marginTop: 12 }}>
            Pick a scope to filter the list; cascade still surfaces inherited
            rows (a Tenant view shows the tenant's rows + globals).
          </p>
        </aside>
        <div className="scope-body">
          <h2>
            {node.scope === "global"
              ? "Global · cluster-wide defaults inherited by every tenant"
              : node.scope === "tenant"
                ? `Tenant ${node.label} · tenant rows + inherited globals`
                : `Env ${node.label} · env rows + inherited tenant + global`}
          </h2>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <input
              placeholder="filter slug / name / kind…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ minWidth: 240 }}
            />
            <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
              <option value="">all kinds</option>
              {(kinds.data?.kinds ?? []).map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.displayName} ({k.kind})
                </option>
              ))}
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
                <th>Type</th>
                <th>Scope</th>
                <th>Probe</th>
                <th>Used by</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    {connections.data ? "No connections match." : "Loading…"}
                  </td>
                </tr>
              )}
              {rows.map((c) => {
                const refs = usedBy.get(c.slug) ?? [];
                const info = kindByName.get(c.kind);
                const isOpen = editing === c.id;
                return (
                  <tr
                    key={c.id}
                    className={isOpen ? "row-selected" : undefined}
                    style={c.archivedAt ? { opacity: 0.55 } : undefined}
                  >
                    <td>
                      <code>{c.slug}</code>
                    </td>
                    <td>{c.displayName}</td>
                    <td>
                      <span title={info?.description ?? c.kind}>
                        {info?.displayName ?? c.kind}
                      </span>
                    </td>
                    <td>
                      {c.scope === "global"
                        ? "global"
                        : c.scope === "tenant"
                          ? `tenant`
                          : `env: ${c.environmentId}`}
                    </td>
                    <td>
                      <ProbeBadge ok={c.lastProbeOk} at={c.lastProbedAt} error={c.lastProbeError} />
                    </td>
                    <td title={refs.join(", ")}>
                      {refs.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        <>
                          {refs.length} dataset{refs.length === 1 ? "" : "s"}
                        </>
                      )}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {canAdmin && !c.archivedAt && (
                        <>
                          <button className="link-btn" onClick={() => openEdit(c)} disabled={editing === c.id}>
                            edit
                          </button>
                          {" · "}
                          <button className="link-btn" onClick={() => probe.mutate(c.id)} disabled={probe.isPending}>
                            test
                          </button>
                          {" · "}
                          <button
                            className="link-btn error"
                            onClick={() => {
                              if (window.confirm(`Archive ${c.slug}?`))
                                archive.mutate(c.id);
                            }}
                          >
                            archive
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {editing && canAdmin && (
            <section className="exec-detail" style={{ marginTop: 16, padding: 16 }}>
              <h2>{editing === "new" ? "New connection" : `Edit ${draft.slug}`}</h2>
              <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }}>
                <label>
                  <div className="muted">Scope</div>
                  <select
                    value={draft.scope}
                    disabled={editing !== "new"}
                    onChange={(e) => setDraft({ ...draft, scope: e.target.value as Scope })}
                  >
                    <option value="global">global</option>
                    <option value="tenant">tenant</option>
                    <option value="environment">environment</option>
                  </select>
                </label>
                <label>
                  <div className="muted">Type</div>
                  <select
                    value={draft.kind}
                    disabled={editing !== "new"}
                    onChange={(e) => setDraft({ ...draft, kind: e.target.value, config: {} })}
                  >
                    <option value="">(pick a type)</option>
                    {(kinds.data?.kinds ?? []).map((k) => (
                      <option key={k.kind} value={k.kind}>
                        {k.displayName}
                      </option>
                    ))}
                  </select>
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
                    onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
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
                    <DraftEnvironmentSelect
                      tenantId={draft.tenantId}
                      value={draft.environmentId}
                      onChange={(v) =>
                        setDraft({ ...draft, environmentId: v })
                      }
                      disabled={editing !== "new"}
                    />
                  </label>
                )}
                <label>
                  <div className="muted">Secret ref id</div>
                  <input
                    value={draft.secretRefId}
                    onChange={(e) => setDraft({ ...draft, secretRefId: e.target.value })}
                    placeholder="(uuid of a row in the secrets table)"
                  />
                </label>
                <label style={{ gridColumn: "1 / -1" }}>
                  <div className="muted">Description</div>
                  <input
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    placeholder="(optional)"
                  />
                </label>
                <div style={{ gridColumn: "1 / -1" }}>
                  <div className="muted" style={{ marginBottom: 6 }}>
                    Per-kind config ({selectedKindInfo?.displayName ?? "—"})
                  </div>
                  <SchemaForm
                    schema={selectedKindInfo?.configSchema}
                    value={draft.config}
                    onChange={(next) => setDraft({ ...draft, config: next })}
                  />
                </div>
              </div>
              {formError && <p className="error">{formError}</p>}
              <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                <button className="primary" onClick={submit} disabled={create.isPending || update.isPending}>
                  {editing === "new" ? "Create" : "Save"}
                </button>
                <button onClick={closeEditor}>Cancel</button>
              </div>
            </section>
          )}
        </div>
      </div>
    </Screen>
  );
}
