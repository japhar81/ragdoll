/**
 * Connections admin screen.
 *
 * Layout: Config-style scope tree on the left (Tenant → Env), a
 * connections table on the right at the selected scope, and an inline
 * editor that turns a JSON-Schema into a real form (no more "host /
 * port / extra JSON" textarea). Inheritance is visualised: at an env
 * node, env-specific rows are shown alongside the tenant-wide rows
 * they inherit from — inherited rows are dimmed with an "override
 * here" button that pre-fills a new env-specific row.
 *
 * Why scope tree + virtual inheritance: a connection at scope
 * (tenant T, env=null) applies to every env in T. Without showing it
 * under each env, an operator wouldn't realise their `dev` view is
 * using the tenant-wide row. Surfacing both gives a true "what would
 * the runtime pick" answer at every selected scope, which matches the
 * cascade resolver behind the scenes.
 *
 * Read access is gated by `dataset:read`; mutations by `dataset:admin`.
 */
import { useEffect, useMemo, useState } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient
} from "@tanstack/react-query";
import { api, ApiError, type ConnectionView } from "../lib/api.ts";
import type { JsonSchemaLike } from "../lib/api.ts";
import { Screen } from "./Screen.tsx";
import { DataGrid, type DataGridColumn } from "./DataGrid.tsx";
import { ConfigForm } from "./ConfigForm.tsx";
import { ScopeTree } from "./ConfigScreen.tsx";
import { useAuth } from "../auth/AuthContext.tsx";
import { useTenants } from "./useTenants.tsx";
import {
  buildScopeTree,
  findScopeNode,
  type ScopeNode
} from "../lib/orgtree.ts";

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const b = e.body as { error?: string; message?: string } | undefined;
    return `HTTP ${e.status}: ${b?.message ?? b?.error ?? JSON.stringify(e.body)}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Datasource types the API accepts. Keep in sync with ALLOWED_TYPES
 *  in apps/api/src/app/routes/connections.ts. */
const DATASOURCE_TYPES = [
  "opensearch",
  "qdrant",
  "dgraph",
  "pgvector",
  "postgres",
  "redis"
] as const;

/**
 * One JSON Schema per datasource type. ConfigForm renders these as a
 * real form — proper typed inputs, descriptions as helper text,
 * `required` marked, enums become dropdowns. Adding a new type means
 * adding a row here AND a matching plugin-side reader.
 *
 * Conservative property set: just host/port/scheme + the few common
 * knobs each backend has. Operators can still drop into the raw-JSON
 * escape hatch ConfigForm provides if they need an unlisted field.
 */
const CONNECTION_SCHEMAS: Record<string, JsonSchemaLike> = {
  opensearch: {
    type: "object",
    required: ["host"],
    properties: {
      host: { type: "string", description: "Hostname or IP" },
      port: { type: "integer", description: "Default 9200", default: 9200 },
      scheme: {
        type: "string",
        enum: ["http", "https"],
        default: "http",
        description: "Use https when the cluster terminates TLS itself"
      },
      verifyTls: {
        type: "boolean",
        default: true,
        description: "Disable only for self-signed dev clusters"
      }
    }
  },
  qdrant: {
    type: "object",
    required: ["host"],
    properties: {
      host: { type: "string", description: "Hostname or IP" },
      port: { type: "integer", description: "Default 6333 (HTTP)", default: 6333 },
      scheme: { type: "string", enum: ["http", "https"], default: "http" }
    }
  },
  dgraph: {
    type: "object",
    required: ["host"],
    properties: {
      host: { type: "string", description: "Hostname or IP" },
      port: { type: "integer", description: "Default 8080 (alpha HTTP)", default: 8080 },
      scheme: { type: "string", enum: ["http", "https"], default: "http" }
    }
  },
  pgvector: {
    type: "object",
    required: ["host", "database"],
    properties: {
      host: { type: "string", description: "Postgres host" },
      port: { type: "integer", default: 5432 },
      database: { type: "string", description: "Database name" },
      sslMode: {
        type: "string",
        enum: ["disable", "require", "verify-ca", "verify-full"],
        default: "disable"
      }
    }
  },
  postgres: {
    type: "object",
    required: ["host", "database"],
    properties: {
      host: { type: "string" },
      port: { type: "integer", default: 5432 },
      database: { type: "string" },
      sslMode: {
        type: "string",
        enum: ["disable", "require", "verify-ca", "verify-full"],
        default: "disable"
      }
    }
  },
  redis: {
    type: "object",
    required: ["host"],
    properties: {
      host: { type: "string" },
      port: { type: "integer", default: 6379 },
      tls: { type: "boolean", default: false },
      db: { type: "integer", description: "Logical DB number", default: 0 }
    }
  }
};

/**
 * The "view" surfaced in the right panel. When we're at an env node
 * we synthesise an inherited row from each tenant-wide connection
 * that doesn't have an env-specific override. The cascade reason
 * carries through so the cell renderer can dim inherited rows.
 */
interface RowView {
  conn: ConnectionView;
  source:
    | "env_specific"
    | "tenant_wide"
    | "global"
    | "inherited_from_tenant"
    | "inherited_from_global";
}

export function ConnectionsScreen() {
  const auth = useAuth();
  const qc = useQueryClient();
  const tenants = useTenants();
  const tenantRows = tenants.tenants;

  // One query per tenant to know its env list — same pattern as
  // ConfigScreen so the [env]+[tenant] caches dedupe.
  const envQueries = useQueries({
    queries: tenantRows.map((t) => ({
      queryKey: ["environments", t.id],
      queryFn: () => api.listEnvironments(t.id),
      enabled: !!t.id,
      staleTime: 30_000
    }))
  });
  const envsByTenant = useMemo<Record<string, string[]>>(() => {
    const out: Record<string, string[]> = {};
    tenantRows.forEach((t, i) => {
      const data = envQueries[i]?.data;
      if (data?.environments) out[t.id] = data.environments.map((e) => e.name);
    });
    return out;
  }, [tenantRows, envQueries]);

  // The scope tree: Global > Tenant > Env. We pass `[]` for pipelines
  // so the env nodes don't carry pipeline children — pipelines aren't
  // a meaningful scope for connections.
  const scopeRoot = useMemo(
    () => buildScopeTree(tenantRows, [], envsByTenant),
    [tenantRows, envsByTenant]
  );
  // Default to the Global root — PR2's whole point is that global is
  // now a real first-class scope, not the dead end it was before.
  const [selectedKey, setSelectedKey] = useState<string>("global");
  const node = findScopeNode(scopeRoot, selectedKey) ?? scopeRoot;

  // Resolve the (tenantId, envId) the right panel operates on.
  //   Global root  → no tenant scope (admin "global rows" view)
  //   Tenant root  → (T, null=tenant-wide rows)
  //   Env node     → (T, env)
  const ctx = useMemo<{ tenantId?: string; envId?: string; isGlobal: boolean }>(() => {
    if (node.scope === "global") return { isGlobal: true };
    if (node.scope === "tenant") return { tenantId: node.scopeId, isGlobal: false };
    if (node.scope === "environment") {
      // Walk up the key to find the tenant — key shape `tenant:T|env:E`.
      const m = node.key.match(/^tenant:([^|]+)\|env:(.+)$/);
      return { tenantId: m?.[1], envId: m?.[2], isGlobal: false };
    }
    return { isGlobal: false };
  }, [node]);

  // Always list every connection in scope (the list endpoint already
  // mixes globals in when a tenant is set).
  const connections = useQuery({
    queryKey: ["connections", ctx.tenantId ?? "global"],
    queryFn: () => api.listConnections({ tenantId: ctx.tenantId ?? "" })
  });

  // Back-ref data — every dataset in the tenant scope that pins a
  // connection by name. Used by the "Datasets using this" cell.
  const datasets = useQuery({
    queryKey: ["datasets", ctx.tenantId, ctx.envId ?? null],
    queryFn: () =>
      api.listDatasets({
        tenantId: ctx.tenantId!,
        environmentId: ctx.envId || undefined
      }),
    enabled: !!ctx.tenantId
  });
  const datasetsByConnectionName = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const ds of datasets.data?.datasets ?? []) {
      for (const [, b] of Object.entries(ds.backends ?? {})) {
        const cn = (b as { connectionName?: string })?.connectionName;
        if (typeof cn === "string") (out[cn] ??= []).push(ds.slug);
      }
    }
    return out;
  }, [datasets.data]);

  const rowViews = useMemo<RowView[]>(() => {
    const all = connections.data?.connections ?? [];
    // Global root: only show rows that are themselves global.
    if (ctx.isGlobal) {
      return all
        .filter((c) => !c.tenantId)
        .map<RowView>((c) => ({ conn: c, source: "global" }));
    }
    if (!ctx.tenantId) return [];
    if (!ctx.envId) {
      // Tenant root: show tenant-wide rows (env=null, tenant=T) and
      // inherited globals whose name isn't also defined at tenant scope.
      const tenantWide = all.filter((c) => c.tenantId === ctx.tenantId && !c.environmentId);
      const tenantNames = new Set(tenantWide.map((c) => c.name));
      const inheritedGlobals = all
        .filter((c) => !c.tenantId && !tenantNames.has(c.name))
        .map<RowView>((c) => ({ conn: c, source: "inherited_from_global" }));
      return [
        ...tenantWide.map<RowView>((c) => ({ conn: c, source: "tenant_wide" })),
        ...inheritedGlobals
      ];
    }
    // Env node: env-specific rows + inherited tenant-wide rows +
    // inherited globals, in cascade order. Inherited rows are filtered
    // so any name with a more-specific row doesn't double-render.
    const envRows = all.filter((c) => c.tenantId === ctx.tenantId && c.environmentId === ctx.envId);
    const envNames = new Set(envRows.map((c) => c.name));
    const tenantWide = all.filter(
      (c) => c.tenantId === ctx.tenantId && !c.environmentId && !envNames.has(c.name)
    );
    const tenantWideNames = new Set([...envNames, ...tenantWide.map((c) => c.name)]);
    const inheritedGlobals = all.filter((c) => !c.tenantId && !tenantWideNames.has(c.name));
    return [
      ...envRows.map<RowView>((c) => ({ conn: c, source: "env_specific" })),
      ...tenantWide.map<RowView>((c) => ({ conn: c, source: "inherited_from_tenant" })),
      ...inheritedGlobals.map<RowView>((c) => ({ conn: c, source: "inherited_from_global" }))
    ];
  }, [connections.data, ctx.tenantId, ctx.envId, ctx.isGlobal]);

  const canAdmin = auth.can("dataset:admin");
  const [editingId, setEditingId] = useState<string | null>(null);
  // Pre-fill state for "Override here" — a new env-specific row
  // pre-populated from the inherited tenant-wide one.
  const [prefill, setPrefill] = useState<Partial<ConnectionView> | null>(null);

  // When the selected scope changes, clear any open editor so we
  // don't leak edits across scopes.
  useEffect(() => {
    setEditingId(null);
    setPrefill(null);
  }, [selectedKey]);

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteConnection(id, ctx.tenantId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["connections", ctx.tenantId] })
  });

  return (
    <Screen title="Connections">
      <div className="scope-layout">
        <aside className="scope-tree">
          <h2>Scope</h2>
          <ScopeTree
            root={scopeRoot}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
          />
          <p className="muted" style={{ fontSize: "0.8em", marginTop: 12 }}>
            Pick a tenant for tenant-wide rows, or an environment to see the
            cascade (env-specific + inherited).
          </p>
        </aside>
        <div className="scope-body">
          <ScopeHeader node={node} />
          {!ctx.tenantId && (
            <p className="muted">Select a tenant or environment on the left to view connections.</p>
          )}
          {ctx.tenantId && connections.isLoading && <p className="muted">Loading…</p>}
          {ctx.tenantId && connections.isError && (
            <p className="error">{errText(connections.error)}</p>
          )}
          {ctx.tenantId && !connections.isLoading && (
            <ConnectionTable
              rows={rowViews}
              envId={ctx.envId}
              canAdmin={canAdmin}
              datasetsByName={datasetsByConnectionName}
              editingId={editingId}
              onEdit={(id) => {
                setPrefill(null);
                setEditingId((cur) => (cur === id ? null : id));
              }}
              onDelete={(id) => {
                if (window.confirm("Delete this connection?")) deleteMut.mutate(id);
              }}
              onOverrideHere={(row) => {
                setEditingId(null);
                // Pre-fill a NEW env-specific row from the inherited
                // tenant-wide row. The form opens at the bottom.
                setPrefill({
                  name: row.conn.name,
                  datasourceType: row.conn.datasourceType,
                  environmentId: ctx.envId,
                  config: row.conn.config,
                  secretRefId: row.conn.secretRefId
                });
              }}
            />
          )}

          {(ctx.tenantId || ctx.isGlobal) && canAdmin && (
            <ConnectionEditor
              tenantId={ctx.tenantId ?? null}
              envId={ctx.envId}
              editingConn={
                editingId
                  ? rowViews.find((r) => r.conn.id === editingId)?.conn ?? null
                  : null
              }
              prefill={prefill}
              onDone={() => {
                setEditingId(null);
                setPrefill(null);
                qc.invalidateQueries({ queryKey: ["connections"] });
              }}
            />
          )}
        </div>
      </div>
    </Screen>
  );
}

function ScopeHeader({ node }: { node: ScopeNode }) {
  if (node.scope === "global") {
    return (
      <h2>
        <strong>Global</strong> · cluster-wide defaults inherited by every tenant
      </h2>
    );
  }
  if (node.scope === "tenant") {
    return (
      <h2>
        Tenant <strong>{node.label}</strong> · tenant-wide connections + inherited globals
      </h2>
    );
  }
  if (node.scope === "environment") {
    return (
      <h2>
        Env <strong>{node.label}</strong> · effective (env-specific + inherited tenant + inherited global)
      </h2>
    );
  }
  return <h2>Connections</h2>;
}

function ConnectionTable(props: {
  rows: RowView[];
  envId?: string;
  canAdmin: boolean;
  datasetsByName: Record<string, string[]>;
  editingId: string | null;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onOverrideHere: (row: RowView) => void;
}) {
  const columns: DataGridColumn<RowView>[] = useMemo(
    () => [
      {
        key: "name",
        header: "Name",
        accessor: (r) => r.conn.name,
        sortable: true,
        cell: (r) => <code>{r.conn.name}</code>
      },
      {
        key: "type",
        header: "Type",
        accessor: (r) => r.conn.datasourceType,
        sortable: true,
        filter: "select"
      },
      {
        key: "host",
        header: "Host",
        accessor: (r) => {
          const c = r.conn.config as { host?: string; endpoint?: string; port?: number };
          const host = c.host ?? c.endpoint ?? "—";
          return c.port ? `${host}:${c.port}` : host;
        }
      },
      {
        key: "source",
        header: "Source",
        accessor: (r) => r.source,
        sortable: true,
        filter: "select",
        cell: (r) => <SourceBadge source={r.source} />
      },
      {
        key: "datasets",
        header: "Datasets",
        accessor: (r) => (props.datasetsByName[r.conn.name]?.length ?? 0).toString(),
        cell: (r) => {
          const refs = props.datasetsByName[r.conn.name] ?? [];
          if (refs.length === 0) return <span className="muted">—</span>;
          return (
            <span title={refs.join("\n")}>
              {refs.length} dataset{refs.length === 1 ? "" : "s"}
            </span>
          );
        }
      },
      {
        key: "actions",
        header: "",
        accessor: () => "",
        cell: (r) => {
          if (!props.canAdmin) return null;
          const inherited =
            r.source === "inherited_from_tenant" || r.source === "inherited_from_global";
          if (inherited) {
            return (
              <button
                className="link-btn"
                onClick={() => props.onOverrideHere(r)}
                title="Create a copy at this scope that overrides the inherited row."
              >
                Override here
              </button>
            );
          }
          return (
            <>
              <button className="link-btn" onClick={() => props.onEdit(r.conn.id)}>
                {props.editingId === r.conn.id ? "Cancel" : "Edit"}
              </button>{" "}
              <button className="link-danger" onClick={() => props.onDelete(r.conn.id)}>
                Delete
              </button>
            </>
          );
        }
      }
    ],
    [props]
  );
  return (
    <DataGrid
      columns={columns}
      rows={props.rows}
      rowKey={(r) => `${r.conn.id}:${r.source}`}
      rowClassName={(r) =>
        r.source === "inherited_from_tenant" || r.source === "inherited_from_global"
          ? "row-inherited"
          : undefined
      }
      emptyMessage="No connections here yet. Use the form below to add one."
    />
  );
}

function SourceBadge(props: { source: RowView["source"] }) {
  const map: Record<RowView["source"], { label: string; color: string }> = {
    env_specific: { label: "env-specific", color: "var(--status-succeeded)" },
    tenant_wide: { label: "tenant-wide", color: "var(--status-running)" },
    global: { label: "global", color: "var(--accent)" },
    inherited_from_tenant: {
      label: "inherited (tenant)",
      color: "var(--text-muted)"
    },
    inherited_from_global: {
      label: "inherited (global)",
      color: "var(--text-muted)"
    }
  };
  const { label, color } = map[props.source];
  return (
    <span
      style={{
        fontSize: "0.75em",
        padding: "2px 6px",
        borderRadius: 3,
        background: "rgba(0,0,0,0.1)",
        color
      }}
    >
      {label}
    </span>
  );
}

/**
 * Inline editor. Renders the per-type JSON Schema as a real form via
 * ConfigForm (same widget set the Builder uses for plugin config),
 * with secret-ref selection separated. Two modes:
 *   - editingConn set → PATCH that connection
 *   - editingConn null + prefill set → POST a new row pre-filled
 *     (used by "Override here" to copy a tenant-wide row into env)
 *   - both null → POST a blank new row
 */
function ConnectionEditor(props: {
  /** `null` → creating/editing a global connection (tenantId=null). */
  tenantId: string | null;
  envId?: string;
  editingConn: ConnectionView | null;
  prefill: Partial<ConnectionView> | null;
  onDone: () => void;
}) {
  const isEdit = !!props.editingConn;
  const seed = props.editingConn ?? props.prefill ?? null;

  const [name, setName] = useState(seed?.name ?? "");
  const [type, setType] = useState<string>(
    seed?.datasourceType ?? "opensearch"
  );
  const [config, setConfig] = useState<Record<string, unknown>>(
    (seed?.config as Record<string, unknown>) ?? {}
  );
  const [err, setErr] = useState<string | null>(null);

  // Re-seed when the editor target changes (different row / different
  // prefill arriving from "Override here").
  useEffect(() => {
    setName(seed?.name ?? "");
    setType(seed?.datasourceType ?? "opensearch");
    setConfig((seed?.config as Record<string, unknown>) ?? {});
    setErr(null);
  }, [props.editingConn?.id, props.prefill]);

  const schema = CONNECTION_SCHEMAS[type];

  const createMut = useMutation({
    mutationFn: () =>
      // tenantId === null → POST with `tenantId: null` so the API
      // creates a global row (admin-only path).
      api.createConnection(props.tenantId ?? "", {
        name,
        datasourceType: type,
        environmentId: props.envId ?? null,
        config,
        ...(props.tenantId === null ? { tenantId: null } : {})
      }),
    onSuccess: () => props.onDone(),
    onError: (e) => setErr(errText(e))
  });
  const updateMut = useMutation({
    mutationFn: () =>
      api.updateConnection(props.editingConn!.id, props.tenantId ?? "", {
        name,
        datasourceType: type,
        config
      }),
    onSuccess: () => props.onDone(),
    onError: (e) => setErr(errText(e))
  });

  return (
    <section className="card" style={{ marginTop: 24 }}>
      <h3>
        {isEdit
          ? `Editing connection "${props.editingConn!.name}"`
          : props.prefill
            ? `Overriding "${props.prefill.name}" for env ${props.envId}`
            : `New connection${
                props.tenantId === null
                  ? " (global)"
                  : props.envId
                    ? ` (env: ${props.envId})`
                    : " (tenant-wide)"
              }`}
      </h3>
      <div className="form-row">
        <label>
          Name{" "}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="os-main"
            pattern="[a-z0-9][a-z0-9_-]{0,62}"
            disabled={isEdit /* renaming changes identity — keep simple */}
            required
          />
        </label>{" "}
        <label>
          Type{" "}
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              // Reset config to type defaults so we don't carry stale
              // fields (e.g. an opensearch `verifyTls` into qdrant).
              setConfig({});
            }}
            disabled={isEdit}
          >
            {DATASOURCE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>
      {schema && (
        <ConfigForm
          value={config}
          schema={schema}
          onChange={setConfig}
        />
      )}
      {err && <p className="error">{err}</p>}
      <button
        onClick={() => (isEdit ? updateMut.mutate() : createMut.mutate())}
        disabled={!name || createMut.isPending || updateMut.isPending}
      >
        {isEdit ? "Save changes" : "Create"}
      </button>{" "}
      <button className="link-btn" onClick={() => props.onDone()}>
        Cancel
      </button>
    </section>
  );
}
