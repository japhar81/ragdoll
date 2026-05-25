import React, { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import type { ConfigDefinitionRow, ConfigValueRow } from "../lib/api.ts";
import {
  buildScopeTree,
  findScopeNode,
  type ScopeNode
} from "../lib/orgtree.ts";
import { tenantIdFromScopeKey } from "../lib/tenantContext.ts";
import { useTenants } from "./useTenants.tsx";
import { Screen } from "./Screen.tsx";
import { DataGrid, type DataGridColumn } from "./DataGrid.tsx";

/**
 * Config admin with a left Global -> Tenant -> Pipeline scope navigator.
 * Selecting a node drives GET /api/config/values?scope&scopeId and scopes the
 * upsert (POST /api/config/values). Definitions are listed for reference.
 */
export function ConfigScreen() {
  const qc = useQueryClient();
  const [selectedKey, setSelectedKey] = useState("global");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");

  const tenants = useTenants();
  const pipelines = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => api.listPipelines()
  });
  const definitions = useQuery({
    queryKey: ["config-definitions"],
    queryFn: () => api.listConfigDefinitions()
  });

  const scopeRoot = useMemo(
    () =>
      buildScopeTree(
        tenants.data?.tenants ?? [],
        pipelines.data?.pipelines ?? []
      ),
    [tenants.data, pipelines.data]
  );
  const node = findScopeNode(scopeRoot, selectedKey) ?? scopeRoot;

  // Tenant/pipeline scope nodes are tenant-scoped on the API; push the tenant
  // id (parsed from the scope key) so x-tenant-id rides every config request.
  useEffect(() => {
    api.setTenant(tenantIdFromScopeKey(selectedKey));
  }, [selectedKey]);

  const values = useQuery({
    queryKey: ["config-values", node.scope, node.scopeId],
    queryFn: () =>
      api.listConfigValues({ scope: node.scope, scope_id: node.scopeId })
  });

  const upsert = useMutation({
    mutationFn: () =>
      api.upsertConfigValue({
        key,
        value,
        scope: node.scope,
        scopeId: node.scopeId
      }),
    onSuccess: () => {
      setKey("");
      setValue("");
      qc.invalidateQueries({ queryKey: ["config-values"] });
    }
  });

  return (
    <Screen
      title="Config"
      isLoading={definitions.isLoading}
      error={definitions.error}
    >
      <div className="scope-layout">
        <aside className="scope-tree">
          <h2>Scope</h2>
          <ScopeTree
            root={scopeRoot}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
          />
        </aside>
        <div className="scope-body">
          <h2>
            {node.scope}
            {node.scopeId ? ` · ${node.label}` : ""} config values
          </h2>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              upsert.mutate();
            }}
          >
            <input
              placeholder="key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              required
            />
            <input
              placeholder="value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <button type="submit" disabled={upsert.isPending}>
              Upsert at {node.scope}
            </button>
            {upsert.isError && (
              <span className="error">{String(upsert.error)}</span>
            )}
          </form>

          {values.isLoading && <p className="muted">Loading values…</p>}
          {values.error && (
            <p className="error">{String(values.error)}</p>
          )}
          <DataGrid<ConfigValueRow>
            columns={
              [
                { key: "key", header: "Key", accessor: (v) => v.key, width: "26%" },
                {
                  key: "scope",
                  header: "Scope",
                  accessor: (v) => v.scope,
                  filter: "select",
                  width: "14%"
                },
                {
                  key: "scopeId",
                  header: "Scope ID",
                  accessor: (v) => v.scopeId ?? "",
                  cell: (v) => v.scopeId ?? "—",
                  width: "20%"
                },
                {
                  key: "value",
                  header: "Value",
                  accessor: (v) => String(v.value ?? ""),
                  width: "26%"
                },
                {
                  key: "locked",
                  header: "Locked",
                  accessor: (v) => (v.locked ? "yes" : "no"),
                  filter: "select",
                  width: "14%"
                }
              ] satisfies DataGridColumn<ConfigValueRow>[]
            }
            rows={values.data?.values ?? []}
            rowKey={(v) => v.id}
            emptyMessage="No config values at this scope."
          />

          <h2>Definitions</h2>
          <DataGrid<ConfigDefinitionRow>
            columns={
              [
                { key: "key", header: "Key", accessor: (d) => d.key, width: "26%" },
                {
                  key: "type",
                  header: "Type",
                  accessor: (d) => d.type,
                  filter: "select",
                  width: "14%"
                },
                {
                  key: "scopes",
                  header: "Scopes",
                  accessor: (d) => (d.allowedScopes ?? []).join(", "),
                  width: "30%"
                },
                {
                  key: "secret",
                  header: "Secret",
                  accessor: (d) => (d.secret ? "yes" : "no"),
                  filter: "select",
                  width: "14%"
                },
                {
                  key: "required",
                  header: "Required",
                  accessor: (d) => (d.required ? "yes" : "no"),
                  filter: "select",
                  width: "14%"
                }
              ] satisfies DataGridColumn<ConfigDefinitionRow>[]
            }
            rows={definitions.data?.definitions ?? []}
            rowKey={(d) => d.key}
            emptyMessage="No definitions registered."
          />
        </div>
      </div>
    </Screen>
  );
}

export function ScopeTree(props: {
  root: ScopeNode;
  selectedKey: string;
  onSelect: (key: string) => void;
}) {
  const render = (n: ScopeNode, depth: number): React.ReactNode => (
    <li key={n.key}>
      <a
        className={n.key === props.selectedKey ? "active" : undefined}
        style={{ paddingLeft: depth * 14 }}
        onClick={() => props.onSelect(n.key)}
      >
        {depth === 0 ? "\u{1F310} " : depth === 1 ? "\u{1F3E2} " : "\u{1F4C4} "}
        {n.label}
      </a>
      {n.children.length > 0 && (
        <ul className="tree-list">
          {n.children.map((c) => render(c, depth + 1))}
        </ul>
      )}
    </li>
  );
  return <ul className="tree-list">{render(props.root, 0)}</ul>;
}
