import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import { Screen, Table } from "./Screen.tsx";

/** Tenants admin: lists GET /api/tenants and creates via POST /api/tenants. */
export function TenantsScreen() {
  const qc = useQueryClient();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");

  const tenants = useQuery({
    queryKey: ["tenants"],
    queryFn: () => api.listTenants()
  });

  const create = useMutation({
    mutationFn: () => api.createTenant({ slug, name }),
    onSuccess: () => {
      setSlug("");
      setName("");
      qc.invalidateQueries({ queryKey: ["tenants"] });
    }
  });

  return (
    <Screen title="Tenants" isLoading={tenants.isLoading} error={tenants.error}>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <input
          placeholder="slug"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          required
        />
        <input
          placeholder="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button type="submit" disabled={create.isPending}>
          Create tenant
        </button>
        {create.isError && <span className="error">{String(create.error)}</span>}
      </form>
      <Table
        columns={["ID", "Slug", "Name", "Status"]}
        rows={(tenants.data?.tenants ?? []).map((t) => [
          t.id,
          t.slug,
          t.name,
          t.status
        ])}
      />
    </Screen>
  );
}
