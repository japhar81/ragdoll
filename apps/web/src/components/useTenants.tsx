/**
 * Shared tenant-list hook + a tiny <TenantSelect>. Every screen that picks a
 * tenant (Builder, Tenants, Scheduler, Config, Secrets) reads the SAME
 * react-query cache key ["tenants"] so the option list is consistent and
 * fetched once. The selected value is always the tenant **id** (a UUID); the
 * visible label shows slug/name. Picking a tenant also pushes it into the
 * shared api client via api.setTenant(id) so subsequent requests carry the
 * x-tenant-id header.
 */
import React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import type { TenantRow } from "../lib/api.ts";
import { isUuid, pickDefaultTenant } from "../lib/tenantContext.ts";

export function useTenants() {
  const query = useQuery({
    queryKey: ["tenants"],
    queryFn: () => api.listTenants()
  });
  const tenants: TenantRow[] = query.data?.tenants ?? [];
  return { ...query, tenants };
}

/** Human label for an option: "slug — Name" (falls back gracefully). */
export function tenantLabel(t: TenantRow): string {
  if (t.slug && t.name && t.slug !== t.name) return `${t.slug} — ${t.name}`;
  return t.name || t.slug || t.id;
}

/**
 * Controlled tenant <select>. `value`/`onChange` deal in tenant **ids**.
 * Renders a disabled placeholder while the list is loading/empty so callers
 * never accidentally fire a request with no tenant context.
 */
export function TenantSelect(props: {
  tenants: TenantRow[];
  value: string;
  onChange: (id: string) => void;
  isLoading?: boolean;
  includeEmptyOption?: boolean;
  emptyLabel?: string;
}) {
  const { tenants, value, onChange } = props;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={props.isLoading || tenants.length === 0}
    >
      {(props.includeEmptyOption || tenants.length === 0) && (
        <option value="">
          {props.isLoading
            ? "loading tenants…"
            : tenants.length === 0
              ? "no tenants"
              : (props.emptyLabel ?? "tenant…")}
        </option>
      )}
      {tenants.map((t) => (
        <option key={t.id} value={t.id}>
          {tenantLabel(t)}
        </option>
      ))}
    </select>
  );
}

/**
 * Keep the shared api client's tenant scope in sync with the selected id, and
 * auto-select the demo default once tenants load. Returns the current
 * selected id plus a setter that also pushes into api.setTenant.
 *
 * `preferredSlug` defaults to `tenant-local` so the bundled Local Demo works
 * out of the box.
 */
export function useSelectedTenant(preferredSlug = "tenant-local") {
  const { tenants, isLoading, error } = useTenants();
  const [tenantId, setTenantIdState] = React.useState("");

  const setTenantId = React.useCallback((id: string) => {
    setTenantIdState(id);
    api.setTenant(id || undefined);
  }, []);

  // Once the list arrives (and nothing chosen yet), default to the demo
  // tenant so Run "just works"; also seed the api client.
  React.useEffect(() => {
    if (tenantId || tenants.length === 0) return;
    const def = pickDefaultTenant(tenants, preferredSlug);
    if (def) {
      setTenantIdState(def.id);
      api.setTenant(def.id);
    }
  }, [tenants, tenantId, preferredSlug]);

  // Keep the client in sync if a tenant is already selected on mount.
  React.useEffect(() => {
    if (tenantId) api.setTenant(tenantId);
  }, [tenantId]);

  const selected = tenants.find((t) => t.id === tenantId);
  return {
    tenants,
    isLoading,
    error,
    tenantId,
    setTenantId,
    selected,
    /**
     * True once we have a real tenant UUID to scope requests with — mirrors
     * exactly what buildAuthHeaders will actually send as x-tenant-id.
     */
    ready: isUuid(tenantId)
  };
}
