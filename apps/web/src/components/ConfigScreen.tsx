import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import { Screen, Table } from "./Screen.tsx";

/**
 * Config admin: lists definitions (GET /api/config/definitions) and values
 * (GET /api/config/values, values defensively redacted by the server) and
 * upserts a value via POST /api/config/values.
 */
export function ConfigScreen() {
  const qc = useQueryClient();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState("global");
  const [scopeId, setScopeId] = useState("");

  const definitions = useQuery({
    queryKey: ["config-definitions"],
    queryFn: () => api.listConfigDefinitions()
  });
  const values = useQuery({
    queryKey: ["config-values"],
    queryFn: () => api.listConfigValues()
  });

  const upsert = useMutation({
    mutationFn: () =>
      api.upsertConfigValue({
        key,
        value,
        scope,
        scopeId: scopeId || undefined
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
      isLoading={definitions.isLoading || values.isLoading}
      error={definitions.error ?? values.error}
    >
      <h2>Set a config value</h2>
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
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="global">global</option>
          <option value="environment">environment</option>
          <option value="pipeline">pipeline</option>
          <option value="tenant">tenant</option>
          <option value="tenant_pipeline">tenant_pipeline</option>
        </select>
        <input
          placeholder="scope id (optional)"
          value={scopeId}
          onChange={(e) => setScopeId(e.target.value)}
        />
        <button type="submit" disabled={upsert.isPending}>
          Upsert
        </button>
        {upsert.isError && <span className="error">{String(upsert.error)}</span>}
      </form>

      <h2>Definitions</h2>
      <Table
        columns={["Key", "Type", "Scopes", "Secret", "Required"]}
        rows={(definitions.data?.definitions ?? []).map((d) => [
          d.key,
          d.type,
          (d.allowedScopes ?? []).join(", "),
          d.secret ? "yes" : "no",
          d.required ? "yes" : "no"
        ])}
      />

      <h2>Values (sensitive values redacted by server)</h2>
      <Table
        columns={["Key", "Scope", "Scope ID", "Value", "Locked"]}
        rows={(values.data?.values ?? []).map((v) => [
          v.key,
          v.scope,
          v.scopeId ?? "-",
          String(v.value),
          v.locked ? "yes" : "no"
        ])}
      />
    </Screen>
  );
}
