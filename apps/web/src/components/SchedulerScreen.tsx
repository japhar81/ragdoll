import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.ts";
import {
  CRON_PRESETS,
  composeCron,
  describeCron,
  parseCron,
  previewNextRuns,
  validateCron,
  type CronParts
} from "../lib/cron.ts";
import { useTenants } from "./useTenants.tsx";
import { useEnvironments, EnvironmentSelect } from "./useEnvironments.tsx";
import { Screen } from "./Screen.tsx";
import { EmptyState } from "./help/EmptyState.tsx";
import { FieldHelp } from "./help/FieldHelp.tsx";

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

/** Compact UUID for the table: first 8 chars + ellipsis, full id on hover. */
function shortId(id: string | undefined | null): string {
  if (!id) return "—";
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/** "in 3m", "in 2h 14m", "in 6d", "just now", "5m ago" — readable next-run. */
function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const delta = t - now;
  const abs = Math.abs(delta);
  const sec = Math.round(abs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.floor(min / 60);
  const rem = min % 60;
  let body: string;
  if (sec < 30) body = "just now";
  else if (min < 60) body = `${min}m`;
  else if (hr < 48) body = rem > 0 ? `${hr}h ${rem}m` : `${hr}h`;
  else body = `${Math.round(hr / 24)}d`;
  if (body === "just now") return body;
  return delta > 0 ? `in ${body}` : `${body} ago`;
}

/**
 * Scheduler: a two-column layout — the create form on the left, a live
 * next-runs preview on the right (powered by croner so it matches what the
 * server will compute), and a clean schedules table below.
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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [formError, setFormError] = useState<string | undefined>();

  const tenants = useTenants();
  const envs = useEnvironments(tenantId);
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
  const upcoming = useMemo(
    () =>
      cronCheck.valid
        ? previewNextRuns(rawCron, 5, timezone || "UTC")
        : undefined,
    [rawCron, timezone, cronCheck.valid]
  );

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
      <form className="sched-create" onSubmit={submit}>
        <div className="sched-grid">
          <section className="card">
            <header className="card-head">
              <strong>Target</strong>
              <span className="muted">where this schedule fires</span>
            </header>
            <div className="field">
              <label>Tenant</label>
              <select
                value={tenantId}
                onChange={(e) => {
                  setTenantId(e.target.value);
                  // Scope POST /api/schedules to the chosen tenant.
                  api.setTenant(e.target.value || undefined);
                }}
                required
              >
                <option value="">Select a tenant…</option>
                {(tenants.data?.tenants ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.slug ? `${t.slug} — ${t.name}` : t.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Pipeline</label>
              <select
                value={pipelineId}
                onChange={(e) => setPipelineId(e.target.value)}
                required
              >
                <option value="">Select a pipeline…</option>
                {(pipelines.data?.pipelines ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Environment</label>
                <EnvironmentSelect
                  environments={envs.environments}
                  value={environment}
                  onChange={setEnvironment}
                  isLoading={envs.isLoading}
                />
              </div>
              <div className="field">
                <label>Activation label</label>
                <input
                  placeholder="optional"
                  value={activationLabel}
                  onChange={(e) => setActivationLabel(e.target.value)}
                />
              </div>
            </div>
          </section>

          <section className="card">
            <header className="card-head">
              <strong>Schedule</strong>
              <span className="muted">{describeCron(rawCron)}</span>
            </header>
            <div className="field">
              <label>
                Cron expression
                <FieldHelp ariaLabel="About cron expressions">
                  <p>
                    Five-field crontab: <code>minute hour dom month dow</code>.
                    Server-side parsing uses{" "}
                    <code>croner</code> so a 6-field "seconds" expression also
                    works. Pair it with the Timezone field below for DST-safe
                    schedules.
                  </p>
                </FieldHelp>
              </label>
              <input
                value={rawCron}
                onChange={(e) => setRaw(e.target.value)}
                className="cron-input"
                spellCheck={false}
                aria-invalid={!cronCheck.valid}
              />
              {!cronCheck.valid && (
                <div className="error small">{cronCheck.errors.join(" ")}</div>
              )}
            </div>
            <div className="preset-chips">
              {CRON_PRESETS.map((p) => (
                <button
                  key={p.cron}
                  type="button"
                  className={
                    "chip" + (rawCron === p.cron ? " chip-selected" : "")
                  }
                  onClick={() => applyPreset(p.cron)}
                  title={p.cron}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="field-row">
              <div className="field">
                <label>Timezone (IANA)</label>
                <input
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  placeholder="UTC"
                />
              </div>
              <div className="field check-field">
                <label>
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setEnabled(e.target.checked)}
                  />
                  Enabled on create
                </label>
              </div>
            </div>
            <button
              type="button"
              className="link-btn"
              onClick={() => setShowAdvanced((s) => !s)}
            >
              {showAdvanced ? "Hide field-by-field editor" : "Advanced: edit fields"}
            </button>
            {showAdvanced && (
              <div className="cron-fields">
                {(["minute", "hour", "dom", "month", "dow"] as const).map((f) => (
                  <label key={f}>
                    <span>{f}</span>
                    <input
                      value={parts[f]}
                      onChange={(e) => setPart(f, e.target.value)}
                    />
                  </label>
                ))}
              </div>
            )}
          </section>

          <section className="card preview-card">
            <header className="card-head">
              <strong>Next runs</strong>
              <span className="muted">{timezone || "UTC"}</span>
            </header>
            {upcoming && upcoming.length > 0 ? (
              <ol className="preview-list">
                {upcoming.map((d) => (
                  <li key={d.toISOString()}>
                    <code>{d.toISOString().replace(/\.\d+Z$/, "Z")}</code>
                    <span className="muted small">
                      {relativeTime(d.toISOString())}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">
                {cronCheck.valid
                  ? "No upcoming runs match this expression."
                  : "Fix the cron expression to see a preview."}
              </p>
            )}
          </section>

          <section className="card">
            <header className="card-head">
              <strong>Input</strong>
              <span className="muted">JSON passed to every run</span>
            </header>
            <textarea
              value={inputJson}
              onChange={(e) => setInputJson(e.target.value)}
              className="json-input"
              spellCheck={false}
            />
          </section>
        </div>

        <div className="sched-actions">
          <button
            type="submit"
            className="primary"
            disabled={
              create.isPending || !tenantId || !pipelineId || !cronCheck.valid
            }
          >
            {create.isPending ? "Creating…" : "Create schedule"}
          </button>
          {formError && <span className="error">{formError}</span>}
        </div>
      </form>

      <header className="section-head">
        <h2>Schedules</h2>
        <div className="filters">
          <input
            placeholder="filter by tenant id"
            value={filterTenant}
            onChange={(e) => setFilterTenant(e.target.value)}
          />
          <input
            placeholder="filter by pipeline id"
            value={filterPipeline}
            onChange={(e) => setFilterPipeline(e.target.value)}
          />
        </div>
      </header>

      {rows.length === 0 ? (
        <EmptyState
          icon="⏰"
          title="No schedules yet"
          body={
            <>
              Schedules fire a pipeline on a cron expression — useful for
              recurring ingestion or warm-up jobs. Pick a tenant, pipeline,
              and environment above, then choose a preset (or write your own
              cron) and click <strong>Create schedule</strong>.
            </>
          }
          action={{
            label: "Create your first schedule",
            onClick: () => {
              const el = document.querySelector<HTMLSelectElement>(
                ".sched-create select"
              );
              el?.focus();
            }
          }}
        />
      ) : (
        <table className="grid sched-grid-table">
          <thead>
            <tr>
              <th>Pipeline</th>
              <th>Env</th>
              <th>Cron</th>
              <th>TZ</th>
              <th>Next run</th>
              <th>Last run</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
          {rows.map((s) => (
            <tr key={s.id} className={s.system ? "row-system" : undefined}>
              <td>
                <div className="cell-stack">
                  {s.system ? (
                    <>
                      <strong>{s.name ?? s.jobType ?? "system schedule"}</strong>
                      <span className="muted small">
                        platform · <code>{s.jobType}</code>
                      </span>
                    </>
                  ) : (
                    <>
                      <code title={s.pipelineId ?? ""}>
                        {shortId(s.pipelineId ?? "—")}
                      </code>
                      <span className="muted small" title={s.tenantId ?? ""}>
                        tenant {shortId(s.tenantId ?? "—")}
                      </span>
                    </>
                  )}
                </div>
              </td>
              <td>{s.environment ?? "—"}</td>
              <td>
                <code className="mono">{s.cron}</code>
                {s.activationLabel && (
                  <div className="muted small">@{s.activationLabel}</div>
                )}
              </td>
              <td>{s.timezone}</td>
              <td title={s.nextRunAt ?? ""}>{relativeTime(s.nextRunAt)}</td>
              <td title={s.lastRunAt ?? ""}>{relativeTime(s.lastRunAt)}</td>
              <td>
                <span
                  className={
                    "status " +
                    (s.enabled ? "status-succeeded" : "status-cancelled")
                  }
                >
                  {s.enabled ? "enabled" : "paused"}
                </span>
              </td>
              <td>
                <div className="row-actions">
                  <button
                    className="link-btn"
                    onClick={() =>
                      toggle.mutate({ id: s.id, enabled: !s.enabled })
                    }
                  >
                    {s.enabled ? "Pause" : "Enable"}
                  </button>
                  {!s.system && (
                    <button
                      className="link-btn danger"
                      onClick={() => {
                        if (window.confirm("Delete this schedule?")) {
                          remove.mutate(s.id);
                        }
                      }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
          </tbody>
        </table>
      )}
    </Screen>
  );
}
