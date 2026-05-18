import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import { Screen, Table } from "./Screen.tsx";

/**
 * Secrets admin. GET /api/secrets returns metadata only; the value is always
 * the literal string "REDACTED" — we never display plaintext. Creating a
 * secret (POST /api/secrets) also returns a redacted record.
 */
export function SecretsScreen() {
  const qc = useQueryClient();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState("tenant");

  const secrets = useQuery({
    queryKey: ["secrets"],
    queryFn: () => api.listSecrets()
  });

  const create = useMutation({
    mutationFn: () => api.createSecret({ key, value, scope }),
    onSuccess: () => {
      setKey("");
      setValue("");
      qc.invalidateQueries({ queryKey: ["secrets"] });
    }
  });

  return (
    <Screen title="Secrets" isLoading={secrets.isLoading} error={secrets.error}>
      <h2>Create / rotate a secret</h2>
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
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="tenant">tenant</option>
          <option value="environment">environment</option>
          <option value="global">global</option>
          <option value="tenant_provider">tenant_provider</option>
          <option value="datasource">datasource</option>
        </select>
        <button type="submit" disabled={create.isPending}>
          Save secret
        </button>
        {create.isError && <span className="error">{String(create.error)}</span>}
      </form>

      <h2>Stored secrets (values REDACTED)</h2>
      <Table
        columns={["ID", "Provider", "Version", "Value", "Updated"]}
        rows={(secrets.data?.secrets ?? []).map((s) => [
          s.id,
          s.provider ?? "-",
          s.version ?? "-",
          s.value,
          s.updatedAt ?? "-"
        ])}
      />
    </Screen>
  );
}
