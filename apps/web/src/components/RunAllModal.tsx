/**
 * Multi-pipeline "Run all" modal.
 *
 * Used by the Pipelines screen at folder / global scope: takes a batch of
 * pipelines + each one's dataset slots and shows them grouped per pipeline.
 * The operator picks (or creates) a dataset variant per slot using the same
 * picker shape DeployModal uses, then fires `api.run` for every pipeline.
 *
 * Why not just loop DeployModal? Because confirming one pipeline at a time
 * defeats the point of "Run all" — the operator wants one decision per
 * (pipeline × slug), one button press, one dispatch.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import type { DatasetView } from "../lib/api.ts";
import type { DatasetSlotRef } from "../lib/types.ts";
import type { PipelineLike } from "../lib/orgtree.ts";

/** env > tenant > global walk — matches the runtime resolver. */
function pickResolved(
  variants: DatasetView[],
  tenantId: string | undefined,
  environment: string
): DatasetView | undefined {
  return (
    variants.find(
      (d) => d.scope === "environment" && d.environmentId === environment
    ) ??
    variants.find(
      (d) => d.scope === "tenant" && d.tenantId === tenantId
    ) ??
    variants.find((d) => d.scope === "global")
  );
}

function variantLabel(d: DatasetView): string {
  if (d.scope === "global") return "global";
  if (d.scope === "tenant")
    return `tenant${d.tenantId ? ` ${d.tenantId.slice(0, 8)}…` : ""}`;
  return `env ${d.environmentId ?? ""}${
    d.tenantId ? ` · tenant ${d.tenantId.slice(0, 8)}…` : ""
  }`;
}

export interface RunAllTarget {
  pipeline: PipelineLike;
  slots: DatasetSlotRef[];
}

export interface RunAllModalProps {
  open: boolean;
  scopeLabel: string; // "all pipelines", "folder Demo Pipelines", etc.
  tenantId: string | undefined;
  tenantSlug?: string;
  environment: string;
  targets: RunAllTarget[];
  onClose: () => void;
  /** Fired with per-pipeline overrides (nodeId → datasetId) keyed by
   *  pipelineId. The parent dispatches the actual /run requests. */
  onConfirm: (overrides: Map<string, Record<string, string>>) => void;
  /** Disables the confirm button while the parent is firing runs. */
  busy?: boolean;
}

export function RunAllModal(props: RunAllModalProps) {
  // Map pipelineId → (nodeId → variantId). Variant id "" / undefined means
  // "use the auto-resolved walk" (matches DeployModal semantics).
  const [overrides, setOverrides] = useState<
    Map<string, Record<string, string>>
  >(new Map());

  const datasets = useQuery({
    queryKey: ["datasets-run-all"],
    queryFn: () => api.listDatasets({}),
    enabled: props.open
  });

  const variantsBySlug = useMemo(() => {
    const map = new Map<string, DatasetView[]>();
    const all = datasets.data?.datasets ?? [];
    for (const d of all) {
      const list = map.get(d.slug) ?? [];
      list.push(d);
      map.set(d.slug, list);
    }
    return map;
  }, [datasets.data]);

  /** A pipeline is "ready" when every slot it references resolves either
   *  via the env>tenant>global walk or via an explicit override. */
  const readiness = useMemo(() => {
    const out = new Map<
      string,
      { ready: boolean; unresolved: DatasetSlotRef[] }
    >();
    for (const t of props.targets) {
      const ov = overrides.get(t.pipeline.id) ?? {};
      const unresolved = t.slots.filter(
        (s) =>
          !ov[s.nodeId] &&
          !pickResolved(
            variantsBySlug.get(s.slug) ?? [],
            props.tenantId,
            props.environment
          )
      );
      out.set(t.pipeline.id, {
        ready: unresolved.length === 0,
        unresolved
      });
    }
    return out;
  }, [props.targets, overrides, variantsBySlug, props.tenantId, props.environment]);

  const totalUnresolved = useMemo(
    () =>
      [...readiness.values()].reduce(
        (acc, r) => acc + r.unresolved.length,
        0
      ),
    [readiness]
  );

  if (!props.open) return null;

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div
        className="modal deploy-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 920 }}
      >
        <header className="modal-head">
          <strong>Run all · {props.scopeLabel}</strong>
          <button className="link-btn" onClick={props.onClose}>
            close
          </button>
        </header>
        <p className="muted">
          Target: tenant <code>{props.tenantSlug ?? props.tenantId ?? "—"}</code>
          {" · "}env <code>{props.environment}</code>. Each pipeline's
          dataset slugs resolve via env › tenant › global (same as the
          runtime). Override a slot only when the default isn't right.
        </p>

        {props.targets.length === 0 ? (
          <p className="muted">No runnable pipelines in this scope.</p>
        ) : datasets.isLoading ? (
          <p className="muted">Loading dataset variants…</p>
        ) : (
          <div style={{ maxHeight: 480, overflowY: "auto" }}>
            {props.targets.map((t) => {
              const ov = overrides.get(t.pipeline.id) ?? {};
              const setSlot = (nodeId: string, datasetId: string) =>
                setOverrides((prev) => {
                  const next = new Map(prev);
                  const cur = { ...(next.get(t.pipeline.id) ?? {}) };
                  if (datasetId) cur[nodeId] = datasetId;
                  else delete cur[nodeId];
                  next.set(t.pipeline.id, cur);
                  return next;
                });
              const r = readiness.get(t.pipeline.id);
              return (
                <section
                  key={t.pipeline.id}
                  className="exec-block"
                  style={{ marginBottom: 12 }}
                >
                  <header
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 6
                    }}
                  >
                    <strong>{t.pipeline.name}</strong>
                    <code className="muted">
                      {t.pipeline.slug ?? t.pipeline.id}
                    </code>
                    <span className="muted">
                      ·{" "}
                      {t.slots.length === 0
                        ? "no dataset slots"
                        : `${t.slots.length} slot${
                            t.slots.length === 1 ? "" : "s"
                          }`}
                    </span>
                    {r && !r.ready && (
                      <span
                        className="status status-failed"
                        style={{ marginLeft: "auto" }}
                      >
                        {r.unresolved.length} unresolved
                      </span>
                    )}
                  </header>
                  {t.slots.length > 0 && (
                    <table className="grid">
                      <thead>
                        <tr>
                          <th>Slug · node · alias</th>
                          <th>Resolves to</th>
                          <th>Override</th>
                        </tr>
                      </thead>
                      <tbody>
                        {t.slots.map((slot) => {
                          const variants = variantsBySlug.get(slot.slug) ?? [];
                          const auto = pickResolved(
                            variants,
                            props.tenantId,
                            props.environment
                          );
                          const overrideId = ov[slot.nodeId];
                          const override = overrideId
                            ? variants.find((v) => v.id === overrideId)
                            : undefined;
                          const effective = override ?? auto;
                          return (
                            <tr key={`${t.pipeline.id}-${slot.nodeId}`}>
                              <td>
                                <code>{slot.slug}</code>{" "}
                                <span className="muted">
                                  · {slot.nodeId} · {slot.alias}
                                </span>
                              </td>
                              <td>
                                {effective ? (
                                  <span>
                                    {variantLabel(effective)}{" "}
                                    {override && (
                                      <span className="muted">(override)</span>
                                    )}
                                  </span>
                                ) : (
                                  <span className="error">unresolved</span>
                                )}
                              </td>
                              <td>
                                <select
                                  value={overrideId ?? ""}
                                  onChange={(e) =>
                                    setSlot(slot.nodeId, e.target.value)
                                  }
                                >
                                  <option value="">
                                    {auto
                                      ? `auto (${variantLabel(auto)})`
                                      : "select…"}
                                  </option>
                                  {variants.map((v) => (
                                    <option key={v.id} value={v.id}>
                                      {variantLabel(v)}
                                    </option>
                                  ))}
                                </select>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </section>
              );
            })}
          </div>
        )}

        {totalUnresolved > 0 && (
          <p className="error" style={{ marginTop: 8 }}>
            {totalUnresolved} slot{totalUnresolved === 1 ? "" : "s"} across{" "}
            {[...readiness.values()].filter((r) => !r.ready).length} pipeline
            {[...readiness.values()].filter((r) => !r.ready).length === 1
              ? ""
              : "s"}{" "}
            need a variant at this target — create one in the Datasets
            screen or override above.
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
            disabled={
              props.busy ||
              datasets.isLoading ||
              props.targets.length === 0 ||
              totalUnresolved > 0
            }
            onClick={() => props.onConfirm(overrides)}
            title={
              totalUnresolved > 0
                ? "Resolve every dataset slot first."
                : `Start ${props.targets.length} run${
                    props.targets.length === 1 ? "" : "s"
                  } against this target`
            }
          >
            Run {props.targets.length} pipeline
            {props.targets.length === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}
