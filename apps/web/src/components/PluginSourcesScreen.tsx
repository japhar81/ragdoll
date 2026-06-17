/**
 * PLUGIN-ARCH-1 close-out: Plugin Sources admin screen.
 *
 * Shape mirrors `ConnectionsScreen.tsx`:
 *
 *   - Top-level list of sources (built-in rows shown first, then the
 *     external git rows). Built-ins are read-only (they're the safety
 *     net; the API refuses CRUD on their reserved ids).
 *   - Right-side editor: name + git url + ref + subpath + enabled +
 *     signing fields. Same drawer-shape Connections uses.
 *   - Refresh button: calls `POST /api/plugins/refresh`, shows the
 *     returned `{added, removed, updated}` diff inline. This is the
 *     "add a source → refresh → see it appear in the palette"
 *     moment made visible.
 *   - Per-source status: stage + message rendered honestly so the
 *     operator diagnoses without logs.
 *
 * Auth: every mutating action calls a `plugin:manage`-gated endpoint;
 * a viewer without that permission gets the 403 surfaced from the
 * mutation hook.
 */
import type React from "react";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type PluginSourceView } from "../lib/api.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { Screen } from "./Screen.tsx";

interface Draft {
  id: string;
  gitUrl: string;
  ref: string;
  subpath: string;
  displayName: string;
  description: string;
  enabled: boolean;
  requireSignature: boolean;
  allowedSigners: string;
}

function emptyDraft(): Draft {
  return {
    id: "",
    gitUrl: "",
    ref: "main",
    subpath: "",
    displayName: "",
    description: "",
    enabled: true,
    requireSignature: false,
    allowedSigners: ""
  };
}

function fromSource(s: PluginSourceView): Draft {
  return {
    id: s.id,
    gitUrl: s.gitUrl ?? "",
    ref: s.ref ?? "main",
    subpath: s.subpath ?? "",
    displayName: s.displayName ?? "",
    description: s.description ?? "",
    enabled: s.enabled,
    requireSignature: false,
    allowedSigners: ""
  };
}

function statusBadge(s: PluginSourceView): { label: string; color: string } {
  if (s.builtin) return { label: "built-in", color: "#64748b" };
  switch (s.status) {
    case "loaded":
      return { label: `loaded (${s.pluginCount ?? 0})`, color: "#16a34a" };
    case "failed":
      return { label: `failed: ${s.errorStage ?? "?"}`, color: "#dc2626" };
    case "skipped":
      return { label: "skipped", color: "#94a3b8" };
    default:
      return { label: "not yet loaded", color: "#94a3b8" };
  }
}

function shortSha(sha?: string): string {
  return sha ? sha.slice(0, 7) : "—";
}

function fmtTimestamp(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

interface DiffReport {
  added: string[];
  removed: string[];
  updated: string[];
}

export function PluginSourcesScreen(): React.ReactElement {
  const { can } = useAuth();
  const canManage = can("plugin:manage");
  const qc = useQueryClient();
  const sourcesQ = useQuery({
    queryKey: ["plugin-sources"],
    queryFn: () => api.listPluginSources()
  });

  const [editing, setEditing] = useState<{
    mode: "create" | "update";
    draft: Draft;
    originalId?: string;
  } | null>(null);
  const [lastDiff, setLastDiff] = useState<DiffReport | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: (draft: Draft) =>
      api.createPluginSource({
        id: draft.id,
        gitUrl: draft.gitUrl,
        ref: draft.ref,
        subpath: draft.subpath || undefined,
        displayName: draft.displayName || undefined,
        description: draft.description || undefined,
        enabled: draft.enabled,
        requireSignature: draft.requireSignature,
        allowedSigners: draft.requireSignature
          ? draft.allowedSigners
          : undefined
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plugin-sources"] });
      setEditing(null);
    }
  });
  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Draft> }) =>
      api.updatePluginSource(id, {
        gitUrl: patch.gitUrl,
        ref: patch.ref,
        subpath: patch.subpath,
        displayName: patch.displayName,
        description: patch.description,
        enabled: patch.enabled,
        requireSignature: patch.requireSignature,
        ...(patch.requireSignature ? { allowedSigners: patch.allowedSigners } : {})
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plugin-sources"] });
      setEditing(null);
    }
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deletePluginSource(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["plugin-sources"] })
  });
  const refreshMut = useMutation({
    mutationFn: () => api.refreshPluginRegistry(),
    onMutate: () => {
      setRefreshError(null);
    },
    onSuccess: (report) => {
      setLastDiff(report.diff);
      qc.invalidateQueries({ queryKey: ["plugin-sources"] });
    },
    onError: (e) => {
      setRefreshError(e instanceof Error ? e.message : String(e));
    }
  });

  const sources = sourcesQ.data?.sources ?? [];

  return (
    <Screen title="Plugin sources">
      <div style={{ padding: 16, maxWidth: 1100 }}>
        <p style={{ color: "#475569", marginTop: 0 }}>
          External (internal/trusted) git repos that ship plugin code.
          Built-in rows are the safety net — they always load. Refresh
          rebuilds the registry from the source list and atomically
          swaps it (in-flight executions keep the prior snapshot).
        </p>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button
            disabled={!canManage}
            onClick={() =>
              setEditing({ mode: "create", draft: emptyDraft() })
            }
            style={{
              padding: "8px 12px",
              background: canManage ? "#0ea5e9" : "#cbd5e1",
              color: "white",
              border: "none",
              borderRadius: 4,
              cursor: canManage ? "pointer" : "not-allowed"
            }}
          >
            + New source
          </button>
          <button
            disabled={!canManage || refreshMut.isPending}
            onClick={() => refreshMut.mutate()}
            style={{
              padding: "8px 12px",
              background: canManage ? "#16a34a" : "#cbd5e1",
              color: "white",
              border: "none",
              borderRadius: 4,
              cursor: canManage ? "pointer" : "not-allowed"
            }}
          >
            {refreshMut.isPending ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {refreshError ? (
          <div
            style={{
              background: "#fee2e2",
              color: "#b91c1c",
              padding: 8,
              borderRadius: 4,
              marginBottom: 12
            }}
          >
            Refresh failed: {refreshError}
          </div>
        ) : null}

        {lastDiff ? (
          <div
            style={{
              background: "#f1f5f9",
              padding: 8,
              borderRadius: 4,
              marginBottom: 12
            }}
          >
            <strong>Last refresh diff:</strong>{" "}
            <span style={{ color: "#16a34a" }}>
              {lastDiff.added.length} added
            </span>
            ,{" "}
            <span style={{ color: "#0ea5e9" }}>
              {lastDiff.updated.length} updated
            </span>
            ,{" "}
            <span style={{ color: "#dc2626" }}>
              {lastDiff.removed.length} removed
            </span>
            {lastDiff.added.length +
              lastDiff.updated.length +
              lastDiff.removed.length >
            0 ? (
              <details style={{ marginTop: 4 }}>
                <summary>Details</summary>
                <pre style={{ fontSize: 11, margin: 0 }}>
                  {JSON.stringify(lastDiff, null, 2)}
                </pre>
              </details>
            ) : null}
          </div>
        ) : null}

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", background: "#f8fafc" }}>
              <th style={{ padding: 8, fontSize: 12 }}>id</th>
              <th style={{ padding: 8, fontSize: 12 }}>kind</th>
              <th style={{ padding: 8, fontSize: 12 }}>repo</th>
              <th style={{ padding: 8, fontSize: 12 }}>ref / sha</th>
              <th style={{ padding: 8, fontSize: 12 }}>last fetched</th>
              <th style={{ padding: 8, fontSize: 12 }}>status</th>
              <th style={{ padding: 8 }} />
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => {
              const badge = statusBadge(s);
              return (
                <tr key={s.id} style={{ borderBottom: "1px solid #e2e8f0" }}>
                  <td style={{ padding: 8, fontFamily: "monospace" }}>{s.id}</td>
                  <td style={{ padding: 8 }}>{s.kind}</td>
                  <td
                    style={{
                      padding: 8,
                      fontFamily: "monospace",
                      fontSize: 12,
                      color: "#475569"
                    }}
                  >
                    {s.gitUrl ?? "—"}
                  </td>
                  <td style={{ padding: 8, fontFamily: "monospace", fontSize: 12 }}>
                    {s.ref ?? "—"}
                    {s.lastCommitSha ? ` @ ${shortSha(s.lastCommitSha)}` : ""}
                  </td>
                  <td style={{ padding: 8, fontSize: 12 }}>
                    {fmtTimestamp(s.lastFetchedAt)}
                  </td>
                  <td style={{ padding: 8 }}>
                    <span
                      title={s.error ?? ""}
                      style={{
                        background: badge.color,
                        color: "white",
                        padding: "2px 6px",
                        borderRadius: 3,
                        fontSize: 11
                      }}
                    >
                      {badge.label}
                    </span>
                    {s.error ? (
                      <div
                        style={{
                          fontSize: 11,
                          color: "#b91c1c",
                          marginTop: 2
                        }}
                      >
                        {s.error}
                      </div>
                    ) : null}
                  </td>
                  <td style={{ padding: 8, textAlign: "right" }}>
                    {!s.builtin && canManage ? (
                      <>
                        <button
                          onClick={() =>
                            setEditing({
                              mode: "update",
                              draft: fromSource(s),
                              originalId: s.id
                            })
                          }
                          style={{ marginRight: 4 }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => {
                            if (
                              confirm(
                                `Delete plugin source "${s.id}"? Its plugins disappear on the next refresh.`
                              )
                            ) {
                              deleteMut.mutate(s.id);
                            }
                          }}
                          style={{ color: "#dc2626" }}
                        >
                          Delete
                        </button>
                      </>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {editing ? (
          <Drawer
            draft={editing.draft}
            mode={editing.mode}
            saving={createMut.isPending || updateMut.isPending}
            error={
              (createMut.error ?? updateMut.error) instanceof Error
                ? (createMut.error as Error)?.message ??
                  (updateMut.error as Error)?.message
                : null
            }
            onChange={(next) =>
              setEditing((s) => (s ? { ...s, draft: next } : s))
            }
            onSubmit={(d) => {
              if (editing.mode === "create") {
                createMut.mutate(d);
              } else if (editing.originalId) {
                updateMut.mutate({ id: editing.originalId, patch: d });
              }
            }}
            onCancel={() => setEditing(null)}
          />
        ) : null}
      </div>
    </Screen>
  );
}

function Drawer(props: {
  draft: Draft;
  mode: "create" | "update";
  saving: boolean;
  error: string | null;
  onChange: (next: Draft) => void;
  onSubmit: (draft: Draft) => void;
  onCancel: () => void;
}): React.ReactElement {
  const { draft, onChange, onSubmit, onCancel, mode, saving, error } = props;
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  return (
    <div
      style={{
        position: "fixed",
        right: 0,
        top: 0,
        bottom: 0,
        width: 480,
        background: "white",
        borderLeft: "1px solid #e2e8f0",
        padding: 16,
        boxShadow: "-2px 0 10px rgba(0,0,0,0.05)",
        overflow: "auto"
      }}
    >
      <h2 style={{ marginTop: 0 }}>
        {mode === "create" ? "New plugin source" : `Edit ${draft.id}`}
      </h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(draft);
        }}
      >
        <Field
          label="id"
          value={draft.id}
          disabled={mode === "update"}
          placeholder="ext-acme"
          onChange={(v) => set({ id: v })}
        />
        <Field
          label="display name"
          value={draft.displayName}
          placeholder="Acme plugins"
          onChange={(v) => set({ displayName: v })}
        />
        <Field
          label="git url"
          value={draft.gitUrl}
          placeholder="https://git.internal.example/plugins.git"
          onChange={(v) => set({ gitUrl: v })}
        />
        <Field
          label="ref (branch / tag / commit sha)"
          value={draft.ref}
          placeholder="main"
          onChange={(v) => set({ ref: v })}
        />
        <Field
          label="subpath inside the repo"
          value={draft.subpath}
          placeholder="src"
          onChange={(v) => set({ subpath: v })}
        />
        <Field
          label="description"
          value={draft.description}
          placeholder=""
          onChange={(v) => set({ description: v })}
        />
        <label style={{ display: "block", marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          enabled
        </label>
        <fieldset style={{ marginTop: 12, padding: 8 }}>
          <legend style={{ fontSize: 12, color: "#475569" }}>Signing (KISS)</legend>
          <label style={{ display: "block", marginBottom: 4 }}>
            <input
              type="checkbox"
              checked={draft.requireSignature}
              onChange={(e) => set({ requireSignature: e.target.checked })}
            />
            require git verify-commit to pass before load
          </label>
          {draft.requireSignature ? (
            <textarea
              value={draft.allowedSigners}
              placeholder="octocat namespaces=git ssh-ed25519 AAAA..."
              onChange={(e) => set({ allowedSigners: e.target.value })}
              rows={6}
              style={{ width: "100%", fontFamily: "monospace", fontSize: 11 }}
            />
          ) : null}
        </fieldset>
        {error ? (
          <div
            style={{
              color: "#b91c1c",
              background: "#fee2e2",
              padding: 8,
              borderRadius: 4,
              margin: "8px 0"
            }}
          >
            {error}
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function Field(props: {
  label: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}): React.ReactElement {
  return (
    <label style={{ display: "block", marginBottom: 8 }}>
      <div style={{ fontSize: 11, color: "#475569" }}>{props.label}</div>
      <input
        type="text"
        value={props.value}
        placeholder={props.placeholder ?? ""}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        style={{ width: "100%", padding: 6, fontSize: 13 }}
      />
    </label>
  );
}
