import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.ts";
import {
  activationVersionLabel,
  type ActivationLike
} from "../lib/orgtree.ts";
import { useTenants } from "./useTenants.tsx";
import { useEnvironments, EnvironmentSelect } from "./useEnvironments.tsx";
import { Screen } from "./Screen.tsx";
import type { ActivationRow, PipelineVersionRow } from "../lib/api.ts";

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { error?: string; message?: string } | undefined;
    return `HTTP ${e.status}: ${body?.message ?? body?.error ?? JSON.stringify(e.body)}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Tenants: create tenants, then per tenant manage its pipeline associations
 * and the activations under each (label, environment, pin-version vs
 * track-latest, enabled, effective version). Multiple concurrent activations
 * per pipeline are visible and individually editable.
 */
export function TenantsScreen() {
  const qc = useQueryClient();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string | undefined>();

  const tenants = useTenants();

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

      <table className="grid">
        <thead>
          <tr>
            <th>ID</th>
            <th>Slug</th>
            <th>Name</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(tenants.data?.tenants ?? []).length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No tenants.
              </td>
            </tr>
          )}
          {(tenants.data?.tenants ?? []).map((t) => (
            <tr key={t.id}>
              <td>{t.id}</td>
              <td>{t.slug}</td>
              <td>{t.name}</td>
              <td>{t.status}</td>
              <td>
                <button
                  className="link-btn"
                  onClick={() => {
                    const next = selected === t.id ? undefined : t.id;
                    setSelected(next);
                    // Scope subsequent tenant-pipeline/activation requests.
                    api.setTenant(next);
                  }}
                >
                  {selected === t.id ? "Hide" : "Manage"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {selected && (
        <>
          <TenantEnvironments tenantId={selected} />
          <TenantStorage tenantId={selected} />
          <TenantPipelines tenantId={selected} />
        </>
      )}
    </Screen>
  );
}

/**
 * Per-tenant storage backend. Default "db" stores pipelines / configs /
 * secrets in Postgres only. "git" mirrors all of them to a tenant Git
 * repo (see docs/admin/git-backed-tenants.md). The form here writes the
 * git config; the worker's poller does the heavy reconcile in the
 * background. "Sync now" flips `last_synced_at` to the epoch so the
 * next poller tick treats this tenant as immediately due.
 */
function TenantStorage(props: { tenantId: string }) {
  const qc = useQueryClient();
  const { tenantId } = props;
  const cfg = useQuery({
    queryKey: ["tenant-storage", tenantId],
    queryFn: () => api.getTenantStorage(tenantId)
  });
  const [remoteUrl, setRemoteUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [pathPrefix, setPathPrefix] = useState("");
  const [authMethod, setAuthMethod] = useState<"https" | "ssh">("https");
  const [authSecretId, setAuthSecretId] = useState("");
  const [pollIntervalSec, setPollIntervalSec] = useState(60);
  const [banner, setBanner] = useState<string | undefined>();

  // Seed the form from the persisted config so an operator opening the
  // section sees what's actually in place.
  React.useEffect(() => {
    if (cfg.data?.git) {
      setRemoteUrl(cfg.data.git.remoteUrl);
      setBranch(cfg.data.git.branch);
      setPathPrefix(cfg.data.git.pathPrefix);
      setAuthMethod(cfg.data.git.authMethod);
      setAuthSecretId(cfg.data.git.authSecretId);
      setPollIntervalSec(cfg.data.git.pollIntervalSec);
    }
  }, [cfg.data?.git?.tenantId]);

  const save = useMutation({
    mutationFn: () =>
      api.putTenantStorage(tenantId, {
        remoteUrl,
        branch,
        pathPrefix,
        authMethod,
        authSecretId,
        pollIntervalSec
      }),
    onSuccess: () => {
      setBanner(undefined);
      qc.invalidateQueries({ queryKey: ["tenant-storage", tenantId] });
    },
    onError: (e) => setBanner(errText(e))
  });
  const disable = useMutation({
    mutationFn: () => api.deleteTenantStorage(tenantId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tenant-storage", tenantId] })
  });
  const syncNow = useMutation({
    mutationFn: () => api.syncTenantStorage(tenantId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tenant-storage", tenantId] })
  });

  const mode = cfg.data?.storageMode ?? "db";

  return (
    <>
      <h2>Storage for {tenantId}</h2>
      {banner && <p className="error">{banner}</p>}
      <p className="muted">
        Current mode: <strong>{mode}</strong>
        {mode === "git" && cfg.data?.git && (
          <>
            {" "}
            · last sync{" "}
            {cfg.data.git.lastSyncedAt ? cfg.data.git.lastSyncedAt : "never"}
            {cfg.data.git.lastSyncError ? (
              <span className="error"> ({cfg.data.git.lastSyncError})</span>
            ) : null}
          </>
        )}
      </p>
      <div className="inline-form">
        <input
          placeholder="git@github.com:org/repo.git OR https://github.com/org/repo.git"
          value={remoteUrl}
          onChange={(e) => setRemoteUrl(e.target.value)}
          style={{ width: 360 }}
        />
        <input
          placeholder="branch"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          style={{ width: 100 }}
        />
        <input
          placeholder="path prefix (optional)"
          value={pathPrefix}
          onChange={(e) => setPathPrefix(e.target.value)}
          style={{ width: 160 }}
        />
        <select
          value={authMethod}
          onChange={(e) => setAuthMethod(e.target.value as "https" | "ssh")}
        >
          <option value="https">HTTPS (PAT)</option>
          <option value="ssh">SSH (key)</option>
        </select>
        <input
          placeholder="auth secret UUID"
          value={authSecretId}
          onChange={(e) => setAuthSecretId(e.target.value)}
          style={{ width: 240 }}
        />
        <input
          type="number"
          min={10}
          max={3600}
          value={pollIntervalSec}
          onChange={(e) => setPollIntervalSec(Number(e.target.value))}
          style={{ width: 80 }}
          title="poll interval (seconds)"
        />
        <button
          className="primary"
          disabled={save.isPending || !remoteUrl || !authSecretId}
          onClick={() => save.mutate()}
        >
          {mode === "git" ? "Save" : "Enable git mode"}
        </button>
        {mode === "git" && (
          <>
            <button
              disabled={syncNow.isPending}
              onClick={() => syncNow.mutate()}
            >
              Sync now
            </button>
            <button
              className="link-btn danger"
              disabled={disable.isPending}
              onClick={() => {
                if (window.confirm("Revert this tenant to DB-only storage?")) {
                  disable.mutate();
                }
              }}
            >
              Disable git mode
            </button>
          </>
        )}
      </div>
    </>
  );
}

/**
 * Per-tenant environment catalog: create/list/delete the environment names
 * this tenant can deploy/run/schedule against. Names are not unique (the
 * table is keyed by id) so duplicates are allowed if the user really wants.
 */
function TenantEnvironments(props: { tenantId: string }) {
  const qc = useQueryClient();
  const { tenantId } = props;
  const { environments, isLoading, error } = useEnvironments(tenantId);
  const [banner, setBanner] = useState<string | undefined>();
  const [envName, setEnvName] = useState("");
  const [envDesc, setEnvDesc] = useState("");
  const [isProd, setIsProd] = useState(false);

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["environments", tenantId] });
  }

  const createEnv = useMutation({
    mutationFn: () =>
      api.createEnvironment(tenantId, {
        name: envName.trim(),
        description: envDesc.trim() || undefined,
        isProduction: isProd
      }),
    onSuccess: () => {
      setBanner(undefined);
      setEnvName("");
      setEnvDesc("");
      setIsProd(false);
      invalidate();
    },
    onError: (e) => setBanner(errText(e))
  });
  const delEnv = useMutation({
    mutationFn: (id: string) => api.deleteEnvironment(tenantId, id),
    onSuccess: () => invalidate(),
    onError: (e) => setBanner(errText(e))
  });

  return (
    <>
      <h2>Environments for {tenantId}</h2>
      {banner && <p className="error">{banner}</p>}
      {error && <p className="error">{errText(error)}</p>}
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (envName.trim()) createEnv.mutate();
        }}
      >
        <input
          placeholder="name (e.g. staging)"
          value={envName}
          onChange={(e) => setEnvName(e.target.value)}
          required
        />
        <input
          placeholder="description (optional)"
          value={envDesc}
          onChange={(e) => setEnvDesc(e.target.value)}
          style={{ width: 200 }}
        />
        <label>
          production
          <input
            type="checkbox"
            checked={isProd}
            onChange={(e) => setIsProd(e.target.checked)}
          />
        </label>
        <button
          type="submit"
          disabled={!envName.trim() || createEnv.isPending}
        >
          Add environment
        </button>
      </form>

      {isLoading && <p className="muted">Loading environments…</p>}
      {!isLoading && environments.length === 0 && (
        <p className="muted">No environments yet.</p>
      )}
      {environments.length > 0 && (
        <table className="grid">
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th>Production</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {environments.map((env) => (
              <tr key={env.id}>
                <td>{env.name}</td>
                <td className="muted">{env.description ?? "—"}</td>
                <td>{env.isProduction ? "yes" : "no"}</td>
                <td>
                  <button
                    className="link-btn"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete environment "${env.name}"? Existing deployments/schedules that reference it by name are unaffected.`
                        )
                      ) {
                        delEnv.mutate(env.id);
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
      )}
    </>
  );
}

function TenantPipelines(props: { tenantId: string }) {
  const qc = useQueryClient();
  const { tenantId } = props;
  const [banner, setBanner] = useState<string | undefined>();
  const [addPipelineId, setAddPipelineId] = useState("");
  const [addEnv, setAddEnv] = useState("dev");
  const envs = useEnvironments(tenantId);

  const allPipelines = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => api.listPipelines()
  });
  const assoc = useQuery({
    queryKey: ["tenant-pipelines", tenantId],
    queryFn: () => api.listTenantPipelines(tenantId)
  });

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["tenant-pipelines", tenantId] });
  }

  const associate = useMutation({
    mutationFn: () =>
      api.associatePipeline(tenantId, {
        pipelineId: addPipelineId,
        environment: addEnv
      }),
    onSuccess: () => {
      setBanner(undefined);
      setAddPipelineId("");
      invalidate();
    },
    onError: (e) => setBanner(errText(e))
  });
  const setEnabled = useMutation({
    mutationFn: (v: { pipelineId: string; environment: string; enabled: boolean }) =>
      api.updateTenantPipeline(tenantId, v.pipelineId, {
        enabled: v.enabled,
        environment: v.environment
      }),
    onSuccess: () => invalidate(),
    onError: (e) => setBanner(errText(e))
  });

  const pipeName = (id: string) =>
    allPipelines.data?.pipelines.find((p) => p.id === id)?.name ?? id;

  return (
    <>
      <h2>Pipelines for {tenantId}</h2>
      {banner && <p className="error">{banner}</p>}
      <div className="inline-form">
        <select
          value={addPipelineId}
          onChange={(e) => setAddPipelineId(e.target.value)}
        >
          <option value="">associate a pipeline…</option>
          {(allPipelines.data?.pipelines ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <EnvironmentSelect
          environments={envs.environments}
          value={addEnv}
          onChange={setAddEnv}
          isLoading={envs.isLoading}
        />
        <button
          disabled={!addPipelineId || associate.isPending}
          onClick={() => associate.mutate()}
        >
          Associate
        </button>
      </div>

      {assoc.isLoading && <p className="muted">Loading associations…</p>}
      {assoc.error && <p className="error">{errText(assoc.error)}</p>}

      {(assoc.data?.pipelines ?? []).length === 0 && !assoc.isLoading && (
        <p className="muted">No associated pipelines.</p>
      )}
      {(assoc.data?.pipelines ?? []).map((tp) => (
        <div key={`${tp.pipelineId}:${tp.environment}`} className="assoc-card">
          <div className="assoc-head">
            <strong>{pipeName(tp.pipelineId)}</strong>
            <span className="status">{tp.environment}</span>
            <span className="muted">{tp.pipelineId}</span>
            <label className="tree-tools">
              <input
                type="checkbox"
                checked={tp.enabled}
                onChange={(e) =>
                  setEnabled.mutate({
                    pipelineId: tp.pipelineId,
                    environment: tp.environment,
                    enabled: e.target.checked
                  })
                }
              />
              association enabled
            </label>
          </div>
          <ActivationsPanel
            tenantId={tenantId}
            pipelineId={tp.pipelineId}
            activations={tp.activations}
            onChanged={invalidate}
          />
        </div>
      ))}
    </>
  );
}

function ActivationsPanel(props: {
  tenantId: string;
  pipelineId: string;
  activations: ActivationRow[];
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const { tenantId, pipelineId } = props;
  const [banner, setBanner] = useState<string | undefined>();
  const [label, setLabel] = useState("default");
  const [env, setEnv] = useState("dev");
  const envs = useEnvironments(tenantId);
  const [trackLatest, setTrackLatest] = useState(true);
  const [pinVersionId, setPinVersionId] = useState("");

  const versions = useQuery({
    queryKey: ["versions", pipelineId],
    queryFn: () => api.listVersions(pipelineId)
  });
  const versionRows: PipelineVersionRow[] = versions.data?.versions ?? [];
  const versionLabel = (id: string) =>
    versionRows.find((v) => v.id === id)?.version;

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["tenant-pipelines", tenantId] });
    props.onChanged();
  }

  const createAct = useMutation({
    mutationFn: () =>
      api.createActivation(tenantId, pipelineId, {
        label,
        environment: env,
        trackLatest,
        pipelineVersionId: trackLatest ? undefined : pinVersionId || undefined,
        enabled: true
      }),
    onSuccess: () => {
      setBanner(undefined);
      invalidate();
    },
    onError: (e) =>
      setBanner(
        e instanceof ApiError && e.status === 409
          ? `Duplicate activation label "${label}" for this env.`
          : errText(e)
      )
  });
  const patchAct = useMutation({
    mutationFn: (v: {
      id: string;
      patch: {
        enabled?: boolean;
        trackLatest?: boolean;
        pipelineVersionId?: string | null;
      };
    }) => api.updateActivation(tenantId, pipelineId, v.id, v.patch),
    onSuccess: () => invalidate(),
    onError: (e) => setBanner(errText(e))
  });
  const delAct = useMutation({
    mutationFn: (id: string) =>
      api.deleteActivation(tenantId, pipelineId, id),
    onSuccess: () => invalidate(),
    onError: (e) => setBanner(errText(e))
  });

  return (
    <div className="activations">
      {banner && <p className="error">{banner}</p>}
      <table className="grid">
        <thead>
          <tr>
            <th>Label</th>
            <th>Env</th>
            <th>Mode</th>
            <th>Version</th>
            <th>Effective</th>
            <th>Enabled</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {props.activations.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                No activations.
              </td>
            </tr>
          )}
          {props.activations.map((a) => (
            <tr key={a.id}>
              <td>{a.label}</td>
              <td>{a.environment}</td>
              <td>
                <button
                  className="link-btn"
                  onClick={() =>
                    patchAct.mutate({
                      id: a.id,
                      patch: {
                        trackLatest: !a.trackLatest,
                        pipelineVersionId: a.trackLatest
                          ? versionRows[versionRows.length - 1]?.id ?? null
                          : null
                      }
                    })
                  }
                >
                  {a.trackLatest ? "track-latest" : "pinned"}
                </button>
              </td>
              <td>
                {a.trackLatest ? (
                  <span className="muted">—</span>
                ) : (
                  <select
                    value={a.pipelineVersionId ?? ""}
                    onChange={(e) =>
                      patchAct.mutate({
                        id: a.id,
                        patch: { pipelineVersionId: e.target.value || null }
                      })
                    }
                  >
                    <option value="">(unset)</option>
                    {versionRows.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.version}
                      </option>
                    ))}
                  </select>
                )}
              </td>
              <td className="muted">
                {activationVersionLabel(a as ActivationLike, versionLabel)}
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={a.enabled}
                  onChange={(e) =>
                    patchAct.mutate({
                      id: a.id,
                      patch: { enabled: e.target.checked }
                    })
                  }
                />
              </td>
              <td>
                <button
                  className="link-btn"
                  onClick={() => {
                    if (window.confirm(`Delete activation "${a.label}"?`)) {
                      delAct.mutate(a.id);
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

      <div className="inline-form">
        <input
          placeholder="label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          style={{ width: 110 }}
        />
        <EnvironmentSelect
          environments={envs.environments}
          value={env}
          onChange={setEnv}
          isLoading={envs.isLoading}
        />
        <label>
          track latest
          <input
            type="checkbox"
            checked={trackLatest}
            onChange={(e) => setTrackLatest(e.target.checked)}
          />
        </label>
        {!trackLatest && (
          <select
            value={pinVersionId}
            onChange={(e) => setPinVersionId(e.target.value)}
          >
            <option value="">pin version…</option>
            {versionRows.map((v) => (
              <option key={v.id} value={v.id}>
                {v.version}
              </option>
            ))}
          </select>
        )}
        <button
          disabled={createAct.isPending || !label}
          onClick={() => createAct.mutate()}
        >
          Add activation
        </button>
      </div>
    </div>
  );
}
