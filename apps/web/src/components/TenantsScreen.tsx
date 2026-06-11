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
import { CascadeDeleteModal } from "./CascadeDeleteModal.tsx";
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
  // Cascade-delete target. Set when the operator clicks Delete on a
  // tenant card; the modal does the 409/force round-trip and the
  // success callback clears selection + invalidates the cache.
  const [deleteTenant, setDeleteTenant] = useState<
    { id: string; name: string; slug: string } | undefined
  >(undefined);

  const tenants = useTenants();

  const create = useMutation({
    mutationFn: () => api.createTenant({ slug, name }),
    onSuccess: () => {
      setSlug("");
      setName("");
      qc.invalidateQueries({ queryKey: ["tenants"] });
    }
  });

  const selectedTenant = selected
    ? tenants.data?.tenants.find((t) => t.id === selected)
    : undefined;

  return (
    <Screen title="Tenants" isLoading={tenants.isLoading} error={tenants.error}>
      {/* Create-tenant card. */}
      <section className="panel">
        <header className="panel-head">
          <h2>Create a tenant</h2>
          <span className="panel-sub">
            Slug is the URL-safe identifier; name is the display label.
          </span>
        </header>
        <div className="panel-body">
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
            style={{ marginBottom: 0 }}
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
            <button
              type="submit"
              className="primary"
              disabled={create.isPending}
            >
              Create tenant
            </button>
            {create.isError && (
              <span className="error">{String(create.error)}</span>
            )}
          </form>
        </div>
      </section>

      {/* Tenants grid. */}
      <section className="panel">
        <header className="panel-head">
          <h2>Tenants</h2>
          <span className="panel-sub">
            {tenants.data?.tenants.length ?? 0} configured
          </span>
        </header>
        <div className="panel-body">
          {(tenants.data?.tenants ?? []).length === 0 ? (
            <p className="muted">No tenants yet — create one above.</p>
          ) : (
            <div className="tenant-card-grid">
              {(tenants.data?.tenants ?? []).map((t) => {
                const isActive = selected === t.id;
                const storageMode =
                  (t as { storageMode?: string }).storageMode ?? "db";
                return (
                  <div
                    key={t.id}
                    className={"tenant-card" + (isActive ? " active" : "")}
                  >
                    <div className="tenant-card-head">
                      <span className="tenant-card-name">{t.name}</span>
                      <span
                        className={
                          "badge " +
                          (t.status === "active"
                            ? "badge-success"
                            : "badge-warn")
                        }
                      >
                        {t.status}
                      </span>
                    </div>
                    <div className="tenant-card-slug">{t.slug}</div>
                    <div className="tenant-card-meta">
                      <span
                        className={
                          "badge " +
                          (storageMode === "git" ? "badge-git" : "badge-db")
                        }
                      >
                        storage: {storageMode}
                      </span>
                      <span title={t.id}>id {t.id.slice(0, 8)}…</span>
                    </div>
                    <div className="tenant-card-actions">
                      <button
                        className="primary"
                        onClick={() => {
                          const next = isActive ? undefined : t.id;
                          setSelected(next);
                          // Scope subsequent tenant-pipeline/activation requests.
                          api.setTenant(next);
                        }}
                      >
                        {isActive ? "Hide details" : "Manage"}
                      </button>
                      <button
                        className="link-btn danger"
                        onClick={() =>
                          setDeleteTenant({ id: t.id, name: t.name, slug: t.slug })
                        }
                        title="Delete this tenant. Refuses if pipelines / datasets / connections / envs / grants reference it; force-delete cascades all of them."
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Per-tenant detail — three stacked section panels. */}
      {selected && (
        <>
          <section className="panel">
            <header className="panel-head">
              <h2>
                Environments
                {selectedTenant ? ` · ${selectedTenant.name}` : ""}
              </h2>
              <span className="panel-sub">
                Names this tenant can deploy / run / schedule against.
              </span>
            </header>
            <div className="panel-body">
              <TenantEnvironments tenantId={selected} />
            </div>
          </section>
          <section className="panel">
            <header className="panel-head">
              <h2>
                Storage
                {selectedTenant ? ` · ${selectedTenant.name}` : ""}
              </h2>
              <span className="panel-sub">
                DB-only or git-backed (GitOps mirror — see docs).
              </span>
            </header>
            <div className="panel-body">
              <TenantStorage tenantId={selected} />
            </div>
          </section>
          <section className="panel">
            <header className="panel-head">
              <h2>
                Pipelines
                {selectedTenant ? ` · ${selectedTenant.name}` : ""}
              </h2>
              <span className="panel-sub">
                Associations + per-env activations.
              </span>
            </header>
            <div className="panel-body">
              <TenantPipelines tenantId={selected} />
            </div>
          </section>
        </>
      )}
      <CascadeDeleteModal
        open={deleteTenant !== undefined}
        resourceLabel={
          deleteTenant ? `tenant "${deleteTenant.name}" (${deleteTenant.slug})` : ""
        }
        description="Deleting a tenant with pipelines, datasets, connections, environments, or tenant-scoped RBAC grants is rejected by default. Force-delete removes the tenant-scoped grants explicitly and lets the FK chain cascade audit_logs / usage / executions / secrets / schedules / environments / connections."
        doDelete={({ force }) =>
          deleteTenant ? api.deleteTenant(deleteTenant.id, { force }) : Promise.resolve()
        }
        onDeleted={() => {
          // If we were viewing this tenant's details, drop the selection
          // so the per-tenant panels disappear instead of pointing at a
          // 404'd id.
          if (deleteTenant && selected === deleteTenant.id) {
            setSelected(undefined);
            api.setTenant(undefined);
          }
          setDeleteTenant(undefined);
          qc.invalidateQueries({ queryKey: ["tenants"] });
        }}
        onClose={() => setDeleteTenant(undefined)}
      />
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
  // Tenant-scoped secret list (the api client is already pointed at the
  // selected tenant by the outer Manage button, so listSecrets returns
  // this tenant's secrets only).
  const secrets = useQuery({
    queryKey: ["secrets", tenantId],
    queryFn: () => api.listSecrets()
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

  const secretChoices = (secrets.data?.secrets ?? []).map((s) => {
    const ref = (s.ref ?? {}) as { key?: string; scope?: string };
    const label = [
      ref.key || "(no key)",
      ref.scope ? `· ${ref.scope}` : undefined,
      s.provider ? `· ${s.provider}` : undefined,
      `· ${s.id.slice(0, 8)}…`
    ]
      .filter(Boolean)
      .join(" ");
    return { id: s.id, label };
  });
  const selectedSecret = secretChoices.find((c) => c.id === authSecretId);

  return (
    <>
      {banner && <p className="error">{banner}</p>}
      <p className="muted" style={{ marginTop: 0 }}>
        Current mode:{" "}
        <span className={"badge " + (mode === "git" ? "badge-git" : "badge-db")}>
          {mode}
        </span>
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
      <div className="form-grid">
        <label htmlFor="git-remote">Remote URL</label>
        <input
          id="git-remote"
          placeholder="git@github.com:org/repo.git OR https://github.com/org/repo.git"
          value={remoteUrl}
          onChange={(e) => setRemoteUrl(e.target.value)}
        />

        <label htmlFor="git-branch">Branch</label>
        <input
          id="git-branch"
          placeholder="main"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        />

        <label htmlFor="git-prefix">Path prefix</label>
        <input
          id="git-prefix"
          placeholder="(optional — empty = repo root)"
          value={pathPrefix}
          onChange={(e) => setPathPrefix(e.target.value)}
        />

        <label htmlFor="git-auth-method">Auth method</label>
        <select
          id="git-auth-method"
          value={authMethod}
          onChange={(e) => setAuthMethod(e.target.value as "https" | "ssh")}
        >
          <option value="https">HTTPS (Personal Access Token)</option>
          <option value="ssh">SSH (private key)</option>
        </select>

        <label htmlFor="git-auth-secret">Auth secret</label>
        <select
          id="git-auth-secret"
          value={authSecretId}
          onChange={(e) => setAuthSecretId(e.target.value)}
        >
          <option value="">
            {secrets.isLoading
              ? "loading secrets…"
              : secretChoices.length === 0
                ? "no tenant secrets — create one on the Secrets screen"
                : "select a secret…"}
          </option>
          {/* Keep the persisted id visible even if it isn't in this
              tenant's secret list (e.g. it's a global secret the
              redacted /api/secrets call doesn't surface here). */}
          {authSecretId && !selectedSecret && (
            <option value={authSecretId}>{authSecretId}</option>
          )}
          {secretChoices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <span className="form-help">
          {authMethod === "https"
            ? "Stored value should be a Personal Access Token with repo scope."
            : "Stored value should be the PEM-encoded SSH private key (no passphrase)."}
        </span>

        <label htmlFor="git-poll">Poll interval (sec)</label>
        <input
          id="git-poll"
          type="number"
          min={10}
          max={3600}
          value={pollIntervalSec}
          onChange={(e) => setPollIntervalSec(Number(e.target.value))}
        />
      </div>
      <div className="form-row-actions">
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
      {/* Header lives on the wrapping `<section className="panel">` in
          the parent — keep the section body lean. */}
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
      {/* Header lives on the wrapping panel — see Pipelines section above. */}
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
