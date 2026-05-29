/**
 * Connections admin screen.
 *
 * A "connection" is the per-(tenant, env) host + credentials for a
 * backing store (OpenSearch / Qdrant / Dgraph / Postgres / Redis).
 * Datasets reference a connection by `name`; plugins read the
 * resolved connection through `dataset.backends[modality].connection`
 * — they never see the hostname or secret directly.
 *
 * Scope semantics surfaced here:
 *   - Tenant + Env picker controls which "view" of the cascade you see.
 *   - With an env selected, the list dedupes by name and shows the row
 *     the resolver WOULD pick at runtime (env-specific wins, otherwise
 *     the tenant-wide fallback row with env=null).
 *   - With env unset, every row in the tenant is shown.
 *
 * Read access is gated by `dataset:read`; mutations by `dataset:admin`.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type ConnectionView } from "../lib/api.ts";
import { Screen } from "./Screen.tsx";
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

const DATASOURCE_TYPES = [
  "opensearch",
  "qdrant",
  "dgraph",
  "pgvector",
  "postgres",
  "redis"
] as const;

export function ConnectionsScreen() {
  const auth = useAuth();
  const qc = useQueryClient();
  const tenants = useTenants();
  const tenantList = tenants.data?.tenants ?? [];
  const [tenantId, setTenantId] = useState<string>("");
  const [envId, setEnvId] = useState<string>(""); // "" → all envs in tenant
  const envs = useEnvironments(tenantId || undefined);
  const envList = envs.data?.environments ?? [];

  // Lazy-default to the first tenant for the picker; user can swap.
  const effectiveTenantId = tenantId || tenantList[0]?.id || "";

  const connections = useQuery({
    queryKey: ["connections", effectiveTenantId, envId],
    queryFn: () =>
      api.listConnections({
        tenantId: effectiveTenantId,
        environmentId: envId || undefined
      }),
    enabled: Boolean(effectiveTenantId)
  });

  // Back-reference: every dataset visible at (tenant, env), so we can
  // count how many of them pin each connection name. Lazy — only
  // fires when an env is selected (otherwise the dataset list is
  // ambiguous and the count would mix tenant-wide + env-specific).
  const datasets = useQuery({
    queryKey: ["datasets", effectiveTenantId, envId],
    queryFn: () =>
      api.listDatasets({
        tenantId: effectiveTenantId,
        environmentId: envId || undefined
      }),
    enabled: Boolean(effectiveTenantId)
  });
  const datasetsByConnectionName = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const ds of datasets.data?.datasets ?? []) {
      for (const [, backend] of Object.entries(ds.backends ?? {})) {
        const cn = (backend as { connectionName?: string })?.connectionName;
        if (typeof cn === "string") {
          (out[cn] ??= []).push(ds.slug);
        }
      }
    }
    return out;
  }, [datasets.data]);

  const canAdmin = auth.can("dataset:admin");

  const createMut = useMutation({
    mutationFn: (input: {
      name: string;
      datasourceType: string;
      environmentId: string | null;
      config: Record<string, unknown>;
    }) => api.createConnection(effectiveTenantId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["connections", effectiveTenantId] });
    }
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteConnection(id, effectiveTenantId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["connections", effectiveTenantId] });
    }
  });

  const columns: DataGridColumn<ConnectionView>[] = useMemo(
    () => [
      {
        key: "name",
        header: "Name",
        accessor: (r) => r.name,
        sortable: true
      },
      {
        key: "type",
        header: "Type",
        accessor: (r) => r.datasourceType,
        sortable: true,
        filter: "select"
      },
      {
        key: "env",
        header: "Env",
        // With an env selected, this column shows whether the row that
        // won the cascade was env-specific or the tenant-wide fallback.
        // Without an env selected, it just shows the row's declared scope.
        accessor: (r) => r.environmentId ?? "(tenant-wide)",
        sortable: true,
        filter: "select"
      },
      {
        key: "host",
        header: "Host",
        accessor: (r) => {
          const c = r.config as { host?: string; endpoint?: string; url?: string };
          return c.host ?? c.endpoint ?? c.url ?? "—";
        }
      },
      {
        key: "secret",
        header: "Secret",
        accessor: (r) => (r.secretRefId ? "✓" : "—")
      },
      {
        key: "datasets",
        header: "Datasets",
        // PR4 back-ref. Shows how many datasets in the active view
        // reference this connection by name, with a tooltip listing
        // their slugs — operators can spot "this connection is wired
        // to 3 datasets, deleting will orphan them" before clicking.
        accessor: (r) => (datasetsByConnectionName[r.name]?.length ?? 0).toString(),
        cell: (r) => {
          const refs = datasetsByConnectionName[r.name] ?? [];
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
        cell: (r) =>
          canAdmin ? (
            <button
              className="link-danger"
              onClick={() => {
                if (window.confirm(`Delete connection "${r.name}"?`)) {
                  deleteMut.mutate(r.id);
                }
              }}
              disabled={deleteMut.isPending}
            >
              Delete
            </button>
          ) : null
      }
    ],
    [canAdmin, deleteMut, datasetsByConnectionName]
  );

  return (
    <Screen title="Connections">
      <p className="muted">
        Per-tenant (and optional per-env) host + credentials for a backing
        store. Datasets reference these by name; plugins resolve them at
        runtime so plugin code never knows the hostname or secret.
      </p>
      <div className="filters">
        <label>
          Tenant{" "}
          <select
            value={effectiveTenantId}
            onChange={(e) => {
              setTenantId(e.target.value);
              setEnvId("");
            }}
          >
            {tenantList.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          View as env{" "}
          <select value={envId} onChange={(e) => setEnvId(e.target.value)}>
            <option value="">(all rows, no cascade)</option>
            {envList.map((e) => (
              <option key={e.id} value={e.name}>
                {e.name}
                {e.isProduction ? " (prod)" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>

      {connections.isLoading && <p className="muted">Loading…</p>}
      {connections.isError && (
        <p className="error">{errText(connections.error)}</p>
      )}
      {connections.data && (
        <DataGrid
          rows={connections.data.connections}
          columns={columns}
          rowKey={(r) => r.id}
          emptyMessage="No connections yet. Add one below to bind a backing store."
        />
      )}

      {canAdmin && effectiveTenantId && (
        <CreateConnectionForm
          tenantId={effectiveTenantId}
          envList={envList.map((e) => e.name)}
          onCreate={(input) => createMut.mutate(input)}
          isPending={createMut.isPending}
          error={createMut.isError ? errText(createMut.error) : null}
        />
      )}
    </Screen>
  );
}

function CreateConnectionForm(props: {
  tenantId: string;
  envList: string[];
  onCreate: (input: {
    name: string;
    datasourceType: string;
    environmentId: string | null;
    config: Record<string, unknown>;
  }) => void;
  isPending: boolean;
  error: string | null;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<typeof DATASOURCE_TYPES[number]>("opensearch");
  const [envId, setEnvId] = useState<string>("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState<string>("");
  const [extraJson, setExtraJson] = useState<string>("");
  const [parseErr, setParseErr] = useState<string | null>(null);

  function submit() {
    setParseErr(null);
    let extra: Record<string, unknown> = {};
    if (extraJson.trim()) {
      try {
        extra = JSON.parse(extraJson);
      } catch (e) {
        setParseErr(`Extra JSON is invalid: ${(e as Error).message}`);
        return;
      }
    }
    const config: Record<string, unknown> = { ...extra };
    if (host) config.host = host;
    if (port) config.port = Number(port);
    props.onCreate({
      name,
      datasourceType: type,
      environmentId: envId || null,
      config
    });
    setName("");
    setHost("");
    setPort("");
    setExtraJson("");
  }

  return (
    <section className="card" style={{ marginTop: 24 }}>
      <h3>New connection</h3>
      <p className="muted">
        Leave env blank for a tenant-wide row (applies to every env until an
        env-specific row overrides). Setting env scopes this row to that env
        only — the cascade picks env-specific over tenant-wide automatically.
      </p>
      <div className="form-row">
        <label>
          Name{" "}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="os-main"
            pattern="[a-z0-9][a-z0-9_-]{0,62}"
            required
          />
        </label>{" "}
        <label>
          Type{" "}
          <select
            value={type}
            onChange={(e) => setType(e.target.value as typeof type)}
          >
            {DATASOURCE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          Env{" "}
          <select value={envId} onChange={(e) => setEnvId(e.target.value)}>
            <option value="">(tenant-wide)</option>
            {props.envList.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-row">
        <label>
          Host{" "}
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="os.acme.example"
          />
        </label>{" "}
        <label>
          Port{" "}
          <input
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="9200"
            type="number"
            min={1}
          />
        </label>
      </div>
      <label style={{ display: "block" }}>
        Extra config (JSON){" "}
        <textarea
          value={extraJson}
          onChange={(e) => setExtraJson(e.target.value)}
          placeholder='{"scheme":"https","verifyTls":false}'
          rows={4}
        />
      </label>
      {parseErr && <p className="error">{parseErr}</p>}
      {props.error && <p className="error">{props.error}</p>}
      <button onClick={submit} disabled={props.isPending || !name}>
        {props.isPending ? "Creating…" : "Create connection"}
      </button>
    </section>
  );
}
