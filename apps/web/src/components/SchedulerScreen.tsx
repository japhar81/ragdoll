import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.ts";
import {
  CRON_PRESETS,
  composeCron,
  describeCron,
  parseCron,
  validateCron,
  type CronParts
} from "../lib/cron.ts";
import { useTenants } from "./useTenants.tsx";
import { Screen } from "./Screen.tsx";

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as
      | { error?: string; message?: string; issues?: unknown }
      | undefined;
    return `HTTP ${e.status}: ${
      body?.message ?? body?.error ?? JSON.stringify(e.body)
    }`;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Scheduler: lists schedules (filterable by tenant/pipeline), creates new
 * ones with a small visual cron builder (5 field inputs + raw string + a few
 * presets), and supports enable/disable/delete. Server 422 cron errors are
 * surfaced inline.
 */
export function SchedulerScreen() {
  const qc = useQueryClient();
  const [filterTenant, setFilterTenant] = useState("");
  const [filterPipeline, setFilterPipeline] = useState("");

  // create form
  const [tenantId, setTenantId] = useState("");
  const [pipelineId, setPipelineId] = useState("");
  const [environment, setEnvironment] = useState("dev");
  const [activationLabel, setActivationLabel] = useState("");
  const [parts, setParts] = useState<CronParts>({
    minute: "0",
    hour: "2",
    dom: "*",
    month: "*",
    dow: "*"
  });
  const [rawCron, setRawCron] = useState("0 2 * * *");
  const [timezone, setTimezone] = useState("UTC");
  const [inputJson, setInputJson] = useState("{}");
  const [enabled, setEnabled] = useState(true);
  const [formError, setFormError] = useState<string | undefined>();

  const tenants = useTenants();
  const pipelines = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => api.listPipelines()
  });
  const schedules = useQuery({
    queryKey: ["schedules", filterTenant, filterPipeline],
    queryFn: () =>
      api.listSchedules({
        tenant: filterTenant || undefined,
        pipeline: filterPipeline || undefined
      })
  });

  const cronCheck = useMemo(() => validateCron(rawCron), [rawCron]);

  function setPart(field: keyof CronParts, value: string) {
    const next = { ...parts, [field]: value };
    setParts(next);
    setRawCron(composeCron(next));
  }
  function setRaw(value: string) {
    setRawCron(value);
    setParts(parseCron(value));
  }
  function applyPreset(cron: string) {
    setRawCron(cron);
    setParts(parseCron(cron));
  }

  const create = useMutation({
    mutationFn: () => {
      let input: unknown = {};
      if (inputJson.trim()) {
        try {
          input = JSON.parse(inputJson);
        } catch {
          throw new Error("Input is not valid JSON.");
        }
      }
      return api.createSchedule({
        tenantId,
        pipelineId,
        environment,
        activationLabel: activationLabel || undefined,
        cron: rawCron,
        timezone: timezone || "UTC",
        input,
        enabled
      });
    },
    onSuccess: () => {
      setFormError(undefined);
      qc.invalidateQueries({ queryKey: ["schedules"] });
    },
    onError: (e) => setFormError(errText(e))
  });

  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) =>
      api.toggleSchedule(v.id, v.enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] })
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] })
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const local = validateCron(rawCron);
    if (!local.valid) {
      setFormError(local.errors.join(" "));
      return;
    }
    create.mutate();
  }

  const rows = schedules.data?.schedules ?? [];

  return (
    <Screen
      title="Scheduler"
      isLoading={schedules.isLoading}
      error={schedules.error}
    >
      <h2>Create schedule</h2>
      <form className="inline-form" onSubmit={submit}>
        <select
          value={tenantId}
          onChange={(e) => {
            setTenantId(e.target.value);
            // Scope POST /api/schedules to the chosen tenant.
            api.setTenant(e.target.value || undefined);
          }}
          required
        >
          <option value="">tenant…</option>
          {(tenants.data?.tenants ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.slug ? `${t.slug} — ${t.name}` : t.name}
            </option>
          ))}
        </select>
        <select
          value={pipelineId}
          onChange={(e) => setPipelineId(e.target.value)}
          required
        >
          <option value="">pipeline…</option>
          {(pipelines.data?.pipelines ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          placeholder="environment"
          value={environment}
          onChange={(e) => setEnvironment(e.target.value)}
          required
          style={{ width: 110 }}
        />
        <input
          placeholder="activation label (optional)"
          value={activationLabel}
          onChange={(e) => setActivationLabel(e.target.value)}
          style={{ width: 160 }}
        />
        <input
          placeholder="timezone"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          style={{ width: 90 }}
        />
        <label>
          enabled
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
        </label>
      </form>

      <div className="cron-builder">
        {(["minute", "hour", "dom", "month", "dow"] as const).map((f) => (
          <label key={f}>
            {f}
            <input
              value={parts[f]}
              onChange={(e) => setPart(f, e.target.value)}
              style={{ width: 64 }}
            />
          </label>
        ))}
        <label>
          raw cron
          <input
            value={rawCron}
            onChange={(e) => setRaw(e.target.value)}
            style={{ width: 160, fontFamily: "ui-monospace, Menlo, monospace" }}
          />
        </label>
        <span className={cronCheck.valid ? "muted" : "error"}>
          {cronCheck.valid ? describeCron(rawCron) : cronCheck.errors.join(" ")}
        </span>
      </div>
      <div className="inline-form">
        {CRON_PRESETS.map((p) => (
          <button
            key={p.cron}
            type="button"
            onClick={() => applyPreset(p.cron)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="inline-form">
        <label style={{ flexDirection: "column", alignItems: "flex-start" }}>
          input JSON
          <textarea
            value={inputJson}
            onChange={(e) => setInputJson(e.target.value)}
            style={{ minHeight: 60, width: 320 }}
          />
        </label>
        <button
          type="button"
          disabled={create.isPending || !tenantId || !pipelineId}
          onClick={submit}
        >
          Create schedule
        </button>
      </div>
      {formError && <p className="error">{formError}</p>}

      <h2>Schedules</h2>
      <div className="inline-form">
        <input
          placeholder="filter tenant id"
          value={filterTenant}
          onChange={(e) => setFilterTenant(e.target.value)}
        />
        <input
          placeholder="filter pipeline id"
          value={filterPipeline}
          onChange={(e) => setFilterPipeline(e.target.value)}
        />
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Tenant</th>
            <th>Pipeline</th>
            <th>Env</th>
            <th>Activation</th>
            <th>Cron</th>
            <th>TZ</th>
            <th>Enabled</th>
            <th>Next run</th>
            <th>Last run</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={10} className="muted">
                No schedules.
              </td>
            </tr>
          )}
          {rows.map((s) => (
            <tr key={s.id}>
              <td>{s.tenantId}</td>
              <td>{s.pipelineId}</td>
              <td>{s.environment}</td>
              <td>{s.activationLabel ?? "-"}</td>
              <td style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>
                {s.cron}
              </td>
              <td>{s.timezone}</td>
              <td>{s.enabled ? "yes" : "no"}</td>
              <td className="muted">{s.nextRunAt ?? "-"}</td>
              <td className="muted">{s.lastRunAt ?? "-"}</td>
              <td>
                <button
                  className="link-btn"
                  onClick={() =>
                    toggle.mutate({ id: s.id, enabled: !s.enabled })
                  }
                >
                  {s.enabled ? "Disable" : "Enable"}
                </button>{" "}
                <button
                  className="link-btn"
                  onClick={() => {
                    if (window.confirm("Delete this schedule?")) {
                      remove.mutate(s.id);
                    }
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Screen>
  );
}
