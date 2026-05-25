import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import type { SecretMeta } from "../lib/api.ts";
import { buildScopeTree, findScopeNode } from "../lib/orgtree.ts";
import { tenantIdFromScopeKey } from "../lib/tenantContext.ts";
import { useTenants } from "./useTenants.tsx";
import { Screen } from "./Screen.tsx";
import { DataGrid, type DataGridColumn } from "./DataGrid.tsx";
import { ScopeTree } from "./ConfigScreen.tsx";

/**
 * Secrets admin with the same Global -> Tenant -> Pipeline scope navigator as
 * Config. GET /api/secrets returns metadata only (value is always the literal
 * "REDACTED"); we never display plaintext. Creating a secret (POST
 * /api/secrets) is scoped by the selected node.
 *
 * Note: the secrets list endpoint returns all metadata; we filter the visible
 * rows to the selected scope client-side where the record carries scope info.
 */
export function SecretsScreen() {
  const qc = useQueryClient();
  const [selectedKey, setSelectedKey] = useState("global");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");

  const tenants = useTenants();
  const pipelines = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => api.listPipelines()
  });
  const secrets = useQuery({
    queryKey: ["secrets"],
    queryFn: () => api.listSecrets()
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
  // id (parsed from the scope key) so x-tenant-id rides every secret request.
  useEffect(() => {
    api.setTenant(tenantIdFromScopeKey(selectedKey));
  }, [selectedKey]);

  // Secrets are managed-secret references with scope metadata. Map the scope
  // navigator to the closest secret scope: tenant node -> tenant scope,
  // pipeline node -> tenant_provider/datasource not inferable, so default to
  // tenant; global -> global.
  const secretScope = node.scope === "global" ? "global" : "tenant";
  const secretTenantId = node.scope === "tenant" ? node.scopeId : undefined;

  const create = useMutation({
    mutationFn: () =>
      api.createSecret({
        key,
        value,
        scope: secretScope,
        tenantId: secretTenantId
      }),
    onSuccess: () => {
      setKey("");
      setValue("");
      qc.invalidateQueries({ queryKey: ["secrets"] });
    }
  });

  return (
    <Screen title="Secrets" isLoading={secrets.isLoading} error={secrets.error}>
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
            Create / rotate a secret ({secretScope}
            {secretTenantId ? ` · ${node.label}` : ""})
          </h2>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <input
              placeholder="key (e.g. llm.api_key)"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              required
            />
            <input
              placeholder="value (never displayed back)"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
            />
            <button type="submit" disabled={create.isPending}>
              Save secret
            </button>
            {create.isError && (
              <span className="error">{String(create.error)}</span>
            )}
          </form>

          <h2>Stored secrets (values never displayed)</h2>
          <DataGrid<SecretMeta>
            columns={
              [
                { key: "id", header: "ID", accessor: (s) => s.id, width: "30%" },
                {
                  key: "provider",
                  header: "Provider",
                  accessor: (s) => s.provider ?? "—",
                  filter: "select",
                  width: "16%"
                },
                {
                  key: "version",
                  header: "Version",
                  accessor: (s) => s.version ?? "",
                  cell: (s) => s.version ?? "—",
                  align: "right",
                  width: "10%"
                },
                {
                  key: "value",
                  header: "Value",
                  accessor: () => "REDACTED",
                  filter: "none",
                  sortable: false,
                  cell: () => <span className="muted">REDACTED</span>,
                  width: "14%"
                },
                {
                  key: "updatedAt",
                  header: "Updated",
                  accessor: (s) => s.updatedAt ?? "",
                  cell: (s) => (s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "—"),
                  width: "30%"
                }
              ] satisfies DataGridColumn<SecretMeta>[]
            }
            rows={secrets.data?.secrets ?? []}
            rowKey={(s) => s.id}
            emptyMessage="No secrets stored yet."
          />
        </div>
      </div>
    </Screen>
  );
}
