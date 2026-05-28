import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type PipelineRow, type TenantRow } from "./api.ts";

/**
 * Shared id → display-label resolver for activity tables (Executions /
 * Audit / Usage). Loads pipelines + tenants once per session (5-minute
 * cache via React Query); every consuming screen shares the same fetch
 * so the activity tabs don't fan out one /api/pipelines per tab open.
 *
 * Returns stable callables — `pipelineLabel(id)` etc. — so a React
 * column-render function can call them in a tight loop without
 * re-rendering the parent on every row.
 *
 * Fallback policy: when the id doesn't match anything (deleted,
 * tenant-scoped to a tenant the caller can't see, …) we return the
 * raw id so the table cell is still informative. Truncation is the
 * UI's concern, not the lookup's.
 */
export interface Lookups {
  /** Returns the pipeline's `name (slug)`, or the raw id when unknown. */
  pipelineLabel: (id: string | null | undefined) => string;
  /** Returns just the human name; useful when slug isn't wanted. */
  pipelineName: (id: string | null | undefined) => string;
  /** Returns the tenant's `name (slug)`, or the raw id when unknown. */
  tenantLabel: (id: string | null | undefined) => string;
  /** True until the underlying lookups resolve at least once. */
  isLoading: boolean;
}

const STALE_MINUTES = 5;

export function useLookups(): Lookups {
  const pipelines = useQuery({
    queryKey: ["lookups", "pipelines"],
    queryFn: () => api.listPipelines(),
    staleTime: STALE_MINUTES * 60_000
  });
  const tenants = useQuery({
    queryKey: ["lookups", "tenants"],
    queryFn: () => api.listTenants(),
    staleTime: STALE_MINUTES * 60_000
  });

  return useMemo<Lookups>(() => {
    const pipelinesById = new Map<string, PipelineRow>();
    for (const p of pipelines.data?.pipelines ?? []) pipelinesById.set(p.id, p);
    const tenantsById = new Map<string, TenantRow>();
    for (const t of tenants.data?.tenants ?? []) tenantsById.set(t.id, t);

    const pipelineLabel = (id: string | null | undefined): string => {
      if (!id) return "—";
      const row = pipelinesById.get(id);
      if (!row) return id;
      return row.slug ? `${row.name} (${row.slug})` : row.name;
    };
    const pipelineName = (id: string | null | undefined): string => {
      if (!id) return "—";
      return pipelinesById.get(id)?.name ?? id;
    };
    const tenantLabel = (id: string | null | undefined): string => {
      if (!id) return "—";
      const row = tenantsById.get(id);
      if (!row) return id;
      return row.slug ? `${row.name} (${row.slug})` : row.name;
    };

    return {
      pipelineLabel,
      pipelineName,
      tenantLabel,
      isLoading: pipelines.isLoading || tenants.isLoading
    };
  }, [pipelines.data, tenants.data, pipelines.isLoading, tenants.isLoading]);
}
