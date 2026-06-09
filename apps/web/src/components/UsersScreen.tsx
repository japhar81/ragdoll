import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.ts";
import type { AccountUser, GrantView, RoleView } from "../lib/api.ts";
import { Screen, Table } from "./Screen.tsx";
import { DataGrid, type DataGridColumn } from "./DataGrid.tsx";
import { useTenants } from "./useTenants.tsx";
import { useEnvironments, EnvironmentSelect } from "./useEnvironments.tsx";

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const b = e.body as { error?: string; message?: string } | undefined;
    return `HTTP ${e.status}: ${b?.message ?? b?.error ?? JSON.stringify(e.body)}`;
  }
  return e instanceof Error ? e.message : String(e);
}

function scopeLabel(g: GrantView): string {
  if (!g.tenantId) return "global";
  if (g.pipelineId) return `tenant ${g.tenantId.slice(0, 8)}… · pipeline ${g.pipelineId.slice(0, 8)}…`;
  if (g.environment) return `tenant ${g.tenantId.slice(0, 8)}… · env ${g.environment}`;
  return `tenant ${g.tenantId.slice(0, 8)}…`;
}

/** Grant editor: assign a role at global / tenant / env / pipeline scope. */
function GrantManager(props: { user: AccountUser; roles: RoleView[] }) {
  const qc = useQueryClient();
  const tenants = useTenants();
  const [role, setRole] = useState("viewer");
  const [level, setLevel] = useState<"global" | "tenant" | "environment" | "pipeline">(
    "tenant"
  );
  const [tenantId, setTenantId] = useState("");
  const [environment, setEnvironment] = useState("");
  const [pipelineId, setPipelineId] = useState("");

  // Catalog-backed pickers for env + pipeline, so a typo can't mint a
  // grant pointing at something that doesn't exist. Env list scopes to
  // the picked tenant; pipeline list is platform-wide (grants can pin
  // to any pipeline the operator can see).
  const { environments, isLoading: envsLoading } = useEnvironments(tenantId);
  const pipelines = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => api.listPipelines(),
    enabled: level === "pipeline"
  });

  const grants = useQuery({
    queryKey: ["grants", props.user.id],
    queryFn: () => api.listGrants(props.user.id)
  });

  const add = useMutation({
    mutationFn: () =>
      api.addGrant(props.user.id, {
        role,
        tenantId: level === "global" ? undefined : tenantId || undefined,
        environment: level === "environment" ? environment || undefined : undefined,
        pipelineId: level === "pipeline" ? pipelineId || undefined : undefined
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["grants", props.user.id] })
  });
  const remove = useMutation({
    mutationFn: (gid: string) => api.removeGrant(props.user.id, gid),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["grants", props.user.id] })
  });

  return (
    <div className="grant-mgr">
      <Table
        columns={["Role", "Scope", ""]}
        rows={(grants.data?.grants ?? []).map((g) => [
          <strong key="r">{g.role}</strong>,
          <span key="s" className="status">{scopeLabel(g)}</span>,
          <button
            key="x"
            className="link-btn"
            onClick={() => remove.mutate(g.id)}
            disabled={remove.isPending}
          >
            revoke
          </button>
        ])}
      />
      <form
        className="inline-form grant-form"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          {props.roles.map((r) => (
            <option key={r.name} value={r.name}>
              {r.name}
            </option>
          ))}
        </select>
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value as typeof level)}
        >
          <option value="global">global</option>
          <option value="tenant">tenant</option>
          <option value="environment">environment</option>
          <option value="pipeline">pipeline</option>
        </select>
        {level !== "global" && (
          <select
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            required
          >
            <option value="">— tenant —</option>
            {(tenants.tenants ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        {level === "environment" && (
          <EnvironmentSelect
            environments={environments}
            value={environment}
            onChange={setEnvironment}
            isLoading={envsLoading}
          />
        )}
        {level === "pipeline" && (
          <select
            value={pipelineId}
            onChange={(e) => setPipelineId(e.target.value)}
            required
            disabled={pipelines.isLoading}
          >
            <option value="">— pipeline —</option>
            {(pipelines.data?.pipelines ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.slug ?? p.id.slice(0, 8) + "…"})
              </option>
            ))}
          </select>
        )}
        <button type="submit" className="primary" disabled={add.isPending}>
          Grant
        </button>
        {add.isError && <span className="error">{errText(add.error)}</span>}
      </form>
    </div>
  );
}

export function UsersScreen() {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [open, setOpen] = useState<string | undefined>();

  const users = useQuery({ queryKey: ["users"], queryFn: () => api.listUsers() });
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.listRoles() });

  const create = useMutation({
    mutationFn: () =>
      api.createUser({
        email,
        password: password || undefined,
        displayName: displayName || undefined
      }),
    onSuccess: () => {
      setEmail("");
      setPassword("");
      setDisplayName("");
      qc.invalidateQueries({ queryKey: ["users"] });
    }
  });
  const toggle = useMutation({
    mutationFn: (u: AccountUser) =>
      api.updateUser(u.id, {
        status: u.status === "active" ? "disabled" : "active"
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] })
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteUser(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] })
  });

  return (
    <Screen title="Users" isLoading={users.isLoading} error={users.error}>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <input
          placeholder="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          placeholder="display name (optional)"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <input
          placeholder="password (blank = SSO only)"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" className="primary" disabled={create.isPending}>
          Add user
        </button>
        {create.isError && <span className="error">{errText(create.error)}</span>}
      </form>

      <DataGrid<AccountUser>
        columns={
          [
            { key: "email", header: "Email", accessor: (u) => u.email, width: "30%" },
            {
              key: "displayName",
              header: "Name",
              accessor: (u) => u.displayName ?? "",
              cell: (u) => u.displayName ?? "—",
              width: "20%"
            },
            {
              key: "auth",
              header: "Auth",
              accessor: (u) => (u.sso ? "SSO" : "password"),
              filter: "select",
              cell: (u) => (
                <span className="status">{u.sso ? "SSO" : "password"}</span>
              ),
              width: "10%"
            },
            {
              key: "status",
              header: "Status",
              accessor: (u) => u.status,
              filter: "select",
              cell: (u) => (
                <span
                  className={`status ${u.status === "active" ? "status-succeeded" : "status-failed"}`}
                >
                  {u.status}
                </span>
              ),
              width: "10%"
            },
            {
              key: "actions",
              header: "",
              accessor: () => "",
              filter: "none",
              sortable: false,
              width: "30%",
              cell: (u) => (
                <span className="row-actions">
                  <button className="link-btn" onClick={() => setOpen(u.id)}>
                    grants
                  </button>
                  <button className="link-btn" onClick={() => toggle.mutate(u)}>
                    {u.status === "active" ? "disable" : "enable"}
                  </button>
                  <button className="link-btn danger" onClick={() => del.mutate(u.id)}>
                    delete
                  </button>
                </span>
              )
            }
          ] satisfies DataGridColumn<AccountUser>[]
        }
        rows={users.data?.users ?? []}
        rowKey={(u) => u.id}
        emptyMessage="No users yet."
      />

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(undefined)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <header className="modal-head">
              <strong>
                Grants ·{" "}
                {users.data?.users.find((u) => u.id === open)?.email}
              </strong>
              <button className="link-btn" onClick={() => setOpen(undefined)}>
                close
              </button>
            </header>
            {(() => {
              const u = users.data?.users.find((x) => x.id === open);
              return u ? (
                <GrantManager user={u} roles={roles.data?.roles ?? []} />
              ) : null;
            })()}
          </div>
        </div>
      )}
    </Screen>
  );
}
