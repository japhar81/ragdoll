import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import type { DatasetView } from "../lib/api.ts";
import type { DatasetSlotRef } from "../lib/types.ts";

/**
 * Deploy / Run prerequisite modal. The builder operates on dataset slugs
 * only; this modal is where slugs get wired to concrete (scope, tenant?,
 * env?) dataset rows for the chosen target.
 *
 * For each slug referenced by the spec:
 *  - shows which scope variant would resolve at the chosen (tenant, env)
 *    (env > tenant > global walk, same as the runtime),
 *  - lets the operator pick a different variant, or
 *  - lets the operator create a new variant at global / tenant / env scope
 *    inline (without leaving the modal).
 *
 * On confirm the modal calls `onConfirm()`; the parent fires the actual
 * Run or Deploy with the same (tenant, env) the operator picked. The
 * runtime then re-resolves each slug → ResolvedDataset using exactly the
 * variants the modal showed.
 */
export interface DeployModalProps {
  open: boolean;
  mode: "run" | "deploy";
  tenantId: string | undefined;
  tenantSlug?: string;
  environment: string;
  pipelineSlug: string;
  slots: DatasetSlotRef[];
  onClose: () => void;
  onConfirm: () => void;
}

type Scope = "global" | "tenant" | "environment";

function variantLabel(d: DatasetView): string {
  if (d.scope === "global") return "global";
  if (d.scope === "tenant") return `tenant${d.tenantId ? ` ${d.tenantId.slice(0, 8)}…` : ""}`;
  return `env ${d.environmentId ?? ""}${d.tenantId ? ` · tenant ${d.tenantId.slice(0, 8)}…` : ""}`;
}

/** env > tenant > global walk, matching apps/worker/src/handlers.ts. */
function pickResolved(
  variants: DatasetView[],
  tenantId: string | undefined,
  environment: string
): DatasetView | undefined {
  return (
    variants.find(
      (d) => d.scope === "environment" && d.tenantId === tenantId && d.environmentId === environment
    ) ??
    variants.find((d) => d.scope === "tenant" && d.tenantId === tenantId) ??
    variants.find((d) => d.scope === "global")
  );
}

function SlotRow(props: {
  slot: DatasetSlotRef;
  variants: DatasetView[];
  tenantId: string | undefined;
  tenantSlug?: string;
  environment: string;
  override: string | undefined;
  onOverride: (variantId: string | undefined) => void;
  onCreated: () => void;
}) {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [createScope, setCreateScope] = useState<Scope>("global");
  const resolved = useMemo(
    () => pickResolved(props.variants, props.tenantId, props.environment),
    [props.variants, props.tenantId, props.environment]
  );
  const overrideRow = props.override
    ? props.variants.find((v) => v.id === props.override)
    : undefined;
  const effective = overrideRow ?? resolved;
  const create = useMutation({
    mutationFn: async () => {
      const res = await api.createDataset({
        slug: props.slot.slug,
        scope: createScope,
        tenantId: createScope === "global" ? undefined : props.tenantId,
        environmentId: createScope === "environment" ? props.environment : undefined,
        displayName: props.slot.slug,
        modalities: ["vector"]
      });
      return res.dataset;
    },
    onSuccess: (ds) => {
      qc.invalidateQueries({ queryKey: ["datasets-deploy"] });
      qc.invalidateQueries({ queryKey: ["datasets-slugs"] });
      qc.invalidateQueries({ queryKey: ["datasets"] });
      qc.invalidateQueries({ queryKey: ["datasets-all"] });
      setShowCreate(false);
      props.onOverride(ds.id);
      props.onCreated();
    }
  });
  return (
    <tr className={effective ? undefined : "deploy-slot-missing"}>
      <td>
        <code>{props.slot.slug}</code>
        <br />
        <span className="muted">
          node <code>{props.slot.nodeId}</code> · alias{" "}
          <code>{props.slot.alias}</code>
        </span>
      </td>
      <td>
        {effective ? (
          <span className="status status-succeeded" title={effective.id}>
            {variantLabel(effective)}
          </span>
        ) : (
          <span className="status status-failed">no variant — won't resolve</span>
        )}
      </td>
      <td>
        <select
          value={props.override ?? ""}
          onChange={(e) => props.onOverride(e.target.value || undefined)}
        >
          <option value="">
            (auto — env › tenant › global)
          </option>
          {props.variants.map((v) => (
            <option key={v.id} value={v.id}>
              {variantLabel(v)}
            </option>
          ))}
        </select>
      </td>
      <td>
        {!showCreate ? (
          <button className="link-btn" onClick={() => setShowCreate(true)}>
            + create variant
          </button>
        ) : (
          <span className="inline-form" style={{ gap: 6, flexWrap: "wrap" }}>
            <select
              value={createScope}
              onChange={(e) => setCreateScope(e.target.value as Scope)}
            >
              <option value="global">global</option>
              <option value="tenant" disabled={!props.tenantId}>
                tenant {props.tenantSlug ? `(${props.tenantSlug})` : ""}
              </option>
              <option
                value="environment"
                disabled={!props.tenantId || !props.environment}
              >
                env ({props.environment || "—"})
              </option>
            </select>
            <button
              className="primary"
              onClick={() => create.mutate()}
              disabled={create.isPending}
            >
              {create.isPending ? "Creating…" : "Create"}
            </button>
            <button className="link-btn" onClick={() => setShowCreate(false)}>
              cancel
            </button>
            {create.isError && (
              <span className="error">{String(create.error)}</span>
            )}
          </span>
        )}
      </td>
    </tr>
  );
}

export function DeployModal(props: DeployModalProps) {
  const [overrides, setOverrides] = useState<Record<string, string | undefined>>({});
  // Cross-scope dataset fetch — we need all variants of each referenced slug
  // to render the pick / create options.
  const datasets = useQuery({
    queryKey: ["datasets-deploy"],
    queryFn: () => api.listDatasets({}),
    enabled: props.open
  });
  const slugs = useMemo(() => {
    const out = new Set<string>();
    for (const s of props.slots) out.add(s.slug);
    return [...out];
  }, [props.slots]);
  const variantsBySlug = useMemo(() => {
    const map = new Map<string, DatasetView[]>();
    for (const d of datasets.data?.datasets ?? []) {
      if (!slugs.includes(d.slug)) continue;
      const list = map.get(d.slug) ?? [];
      list.push(d);
      map.set(d.slug, list);
    }
    return map;
  }, [datasets.data, slugs]);
  const unresolved = props.slots.filter(
    (s) =>
      !pickResolved(variantsBySlug.get(s.slug) ?? [], props.tenantId, props.environment) &&
      !overrides[s.nodeId]
  );
  const cannotConfirm = unresolved.length > 0 || datasets.isLoading;

  if (!props.open) return null;
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div
        className="modal deploy-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <strong>
            {props.mode === "run" ? "Run" : "Deploy"} ·{" "}
            <code>{props.pipelineSlug}</code>
          </strong>
          <button className="link-btn" onClick={props.onClose}>
            close
          </button>
        </header>
        <p className="muted">
          Target: tenant <code>{props.tenantSlug ?? props.tenantId ?? "—"}</code>
          {" · "}env <code>{props.environment}</code>. Each referenced dataset
          slug resolves to the closest variant for that target (env › tenant ›
          global). Pick a different variant or create one to fill any gap.
        </p>

        {props.slots.length === 0 ? (
          <p className="muted">No dataset slots in this pipeline.</p>
        ) : datasets.isLoading ? (
          <p className="muted">Loading dataset variants…</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Slug · node · alias</th>
                <th>Resolves to</th>
                <th>Override</th>
                <th>Create variant</th>
              </tr>
            </thead>
            <tbody>
              {props.slots.map((slot) => (
                <SlotRow
                  key={`${slot.nodeId}-${slot.slug}`}
                  slot={slot}
                  variants={variantsBySlug.get(slot.slug) ?? []}
                  tenantId={props.tenantId}
                  tenantSlug={props.tenantSlug}
                  environment={props.environment}
                  override={overrides[slot.nodeId]}
                  onOverride={(id) =>
                    setOverrides((o) => ({ ...o, [slot.nodeId]: id }))
                  }
                  onCreated={() => {
                    /* invalidation handled in mutation */
                  }}
                />
              ))}
            </tbody>
          </table>
        )}

        {unresolved.length > 0 && (
          <p className="error" style={{ marginTop: 8 }}>
            {unresolved.length} slot{unresolved.length === 1 ? "" : "s"} still
            have no variant at this target — create or override above.
          </p>
        )}

        <div
          className="inline-form"
          style={{ marginTop: 12, justifyContent: "flex-end" }}
        >
          <button className="link-btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={cannotConfirm}
            onClick={() => props.onConfirm()}
            title={
              cannotConfirm
                ? "Resolve every dataset slot first."
                : props.mode === "run"
                  ? "Start a run against this target"
                  : "Deploy this version to this target"
            }
          >
            {props.mode === "run" ? "Run" : "Deploy"}
          </button>
        </div>
      </div>
    </div>
  );
}
