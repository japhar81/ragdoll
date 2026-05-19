/**
 * Shared per-tenant environment hook + a tiny <EnvironmentSelect>. Every
 * screen that picks an environment (Builder, Scheduler, Tenants) reads the
 * SAME react-query cache key ["environments", tenantId] so the option list
 * is consistent and fetched once per tenant.
 *
 * The rest of the stack treats `environment` as a free-text NAME (it flows
 * into executions/config-scope/collection names), so the select deals in
 * environment **names**, not ids. The per-tenant catalog (managed from the
 * Tenants screen) just constrains which names are offered.
 */
import React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import type { EnvironmentRow } from "../lib/api.ts";
import { isUuid } from "../lib/tenantContext.ts";

export function useEnvironments(tenantId: string | undefined) {
  const enabled = !!tenantId && isUuid(tenantId);
  const query = useQuery({
    queryKey: ["environments", tenantId],
    queryFn: () => api.listEnvironments(tenantId as string),
    enabled
  });
  const environments: EnvironmentRow[] = query.data?.environments ?? [];
  return { ...query, environments };
}

export function environmentLabel(e: EnvironmentRow): string {
  return e.isProduction ? `${e.name} (prod)` : e.name;
}

/**
 * Controlled environment <select>. `value`/`onChange` deal in environment
 * **names**. Shows a disabled placeholder while loading, and falls back to a
 * free-text input when the tenant has no environments yet so callers are
 * never wedged before the catalog is populated.
 */
export function EnvironmentSelect(props: {
  environments: EnvironmentRow[];
  value: string;
  onChange: (name: string) => void;
  isLoading?: boolean;
}) {
  const { environments, value, onChange } = props;

  if (!props.isLoading && environments.length === 0) {
    return (
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="no environments — type one"
        title="This tenant has no environments yet. Add some on the Tenants screen."
        style={{ width: 140 }}
      />
    );
  }

  // If the current value isn't in the catalog (e.g. legacy "dev"), keep it
  // selectable so we never silently change a pipeline's target environment.
  const known = environments.some((e) => e.name === value);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={props.isLoading}
    >
      {props.isLoading && <option value="">loading…</option>}
      {!props.isLoading && value && !known && (
        <option value={value}>{value} (not in catalog)</option>
      )}
      {environments.map((e) => (
        <option key={e.id} value={e.name}>
          {environmentLabel(e)}
        </option>
      ))}
    </select>
  );
}
