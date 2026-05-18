import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.ts";
import {
  activationVersionLabel,
  type ActivationLike
} from "../lib/orgtree.ts";
import { useTenants } from "./useTenants.tsx";
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
                  {selected === t.id ? "Hide pipelines" : "Pipelines"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {selected && <TenantPipelines tenantId={selected} />}
    </Screen>
  );
}

function TenantPipelines(props: { tenantId: string }) {
  const qc = useQueryClient();
  const { tenantId } = props;
  const [banner, setBanner] = useState<string | undefined>();
  const [addPipelineId, setAddPipelineId] = useState("");
  const [addEnv, setAddEnv] = useState("dev");

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
    mutationFn: (v: { pipelineId: string; enabled: boolean }) =>
      api.updateTenantPipeline(tenantId, v.pipelineId, { enabled: v.enabled }),
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
        <input
          value={addEnv}
          onChange={(e) => setAddEnv(e.target.value)}
          style={{ width: 90 }}
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
        <div key={tp.pipelineId} className="assoc-card">
          <div className="assoc-head">
            <strong>{pipeName(tp.pipelineId)}</strong>
            <span className="muted">{tp.pipelineId}</span>
            <label className="tree-tools">
              <input
                type="checkbox"
                checked={tp.enabled}
                onChange={(e) =>
                  setEnabled.mutate({
                    pipelineId: tp.pipelineId,
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
        <input
          placeholder="env"
          value={env}
          onChange={(e) => setEnv(e.target.value)}
          style={{ width: 80 }}
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
