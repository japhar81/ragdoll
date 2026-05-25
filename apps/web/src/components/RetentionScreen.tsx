import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import type { RetentionSetting } from "../lib/api.ts";
import { Screen } from "./Screen.tsx";

/**
 * Retention settings — global caps on how much history we keep for each
 * activity-style resource (executions, usage, audit). Enforcement is in
 * the worker's `retention_sweep` system schedule (see migration 012);
 * editing the cadence happens on the Scheduler screen. This screen only
 * configures THE LIMITS.
 *
 * Each row supports two independent caps:
 *   * Max rows  — keep at most N most-recent (NULL = unbounded).
 *   * Max age   — drop rows older than N days       (NULL = unbounded).
 *
 * Setting both means EITHER cap can fire (whichever is tighter). Leaving
 * both blank disables retention for that resource.
 */
const RESOURCE_META: Array<{
  resource: RetentionSetting["resource"];
  label: string;
  description: string;
}> = [
  {
    resource: "executions",
    label: "Executions",
    description:
      "Pipeline runs + their per-node traces. The sweep also evicts the trace rows for any deleted execution."
  },
  {
    resource: "usage",
    label: "Usage records",
    description:
      "Per-(execution, provider, model) token / latency counters that feed the Usage screen."
  },
  {
    resource: "audit",
    label: "Audit log",
    description:
      "Redacted before/after pairs for every config / RBAC / deploy mutation. Tune this to your compliance posture."
  }
];

interface DraftRow {
  maxCount: string;
  maxAgeDays: string;
}

function settingToDraft(s: RetentionSetting | undefined): DraftRow {
  return {
    maxCount: s?.maxCount !== null && s?.maxCount !== undefined ? String(s.maxCount) : "",
    maxAgeDays:
      s?.maxAgeDays !== null && s?.maxAgeDays !== undefined
        ? String(s.maxAgeDays)
        : ""
  };
}

function parseDraftField(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function RetentionScreen() {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ["retention"],
    queryFn: () => api.listRetention()
  });
  const [drafts, setDrafts] = useState<
    Partial<Record<RetentionSetting["resource"], DraftRow>>
  >({});

  // Seed drafts from server state once loaded so the inputs render with
  // the current limits instead of blank. Re-applying on every refetch
  // would clobber user keystrokes — only seed for resources that don't
  // already have a draft.
  useEffect(() => {
    if (!settings.data) return;
    setDrafts((prev) => {
      const next = { ...prev };
      for (const row of settings.data.settings) {
        if (!next[row.resource]) next[row.resource] = settingToDraft(row);
      }
      return next;
    });
  }, [settings.data]);

  const save = useMutation({
    mutationFn: (input: {
      resource: RetentionSetting["resource"];
      maxCount: number | null;
      maxAgeDays: number | null;
    }) =>
      api.updateRetention(input.resource, {
        maxCount: input.maxCount,
        maxAgeDays: input.maxAgeDays
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["retention"] });
    }
  });

  return (
    <Screen
      title="Retention"
      isLoading={settings.isLoading}
      error={settings.error}
    >
      <p className="muted">
        Global caps on how long we keep activity history. The worker's{" "}
        <code>retention_sweep</code> system schedule applies these on cadence
        (default hourly — edit from <a href="/scheduler">Scheduler</a>). Set
        either field; leave both blank to keep forever.
      </p>
      <div className="settings-card" style={{ padding: 0, overflow: "hidden" }}>
        <table className="grid">
          <thead>
            <tr>
              <th style={{ width: "22%" }}>Resource</th>
              <th>Description</th>
              <th style={{ width: "14%" }}>Max rows</th>
              <th style={{ width: "14%" }}>Max age (days)</th>
              <th style={{ width: "14%" }}>Updated</th>
              <th style={{ width: "10%" }}></th>
            </tr>
          </thead>
          <tbody>
            {RESOURCE_META.map((meta) => {
              const existing = settings.data?.settings.find(
                (s) => s.resource === meta.resource
              );
              const draft = drafts[meta.resource] ?? settingToDraft(existing);
              const dirty =
                existing === undefined
                  ? draft.maxCount !== "" || draft.maxAgeDays !== ""
                  : draft.maxCount !==
                      (existing.maxCount !== null ? String(existing.maxCount) : "") ||
                    draft.maxAgeDays !==
                      (existing.maxAgeDays !== null
                        ? String(existing.maxAgeDays)
                        : "");
              return (
                <tr key={meta.resource}>
                  <td>
                    <strong>{meta.label}</strong>
                  </td>
                  <td className="muted">{meta.description}</td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      placeholder="∞"
                      value={draft.maxCount}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [meta.resource]: { ...draft, maxCount: e.target.value }
                        }))
                      }
                      style={{ width: "100%" }}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      placeholder="∞"
                      value={draft.maxAgeDays}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [meta.resource]: { ...draft, maxAgeDays: e.target.value }
                        }))
                      }
                      style={{ width: "100%" }}
                    />
                  </td>
                  <td className="muted">
                    {existing?.updatedAt
                      ? new Date(existing.updatedAt).toLocaleString()
                      : "—"}
                  </td>
                  <td>
                    <button
                      className="primary"
                      disabled={!dirty || save.isPending}
                      onClick={() =>
                        save.mutate({
                          resource: meta.resource,
                          maxCount: parseDraftField(draft.maxCount),
                          maxAgeDays: parseDraftField(draft.maxAgeDays)
                        })
                      }
                    >
                      {save.isPending && save.variables?.resource === meta.resource
                        ? "Saving…"
                        : "Save"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {save.isError && (
        <p className="error">{String(save.error)}</p>
      )}
    </Screen>
  );
}
