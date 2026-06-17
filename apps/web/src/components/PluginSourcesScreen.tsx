/**
 * PLUGIN-ARCH-1 close-out: Plugin Sources admin screen.
 *
 * Visual shape mirrors `ConnectionsScreen` so the operator's mental
 * model carries over: `Screen` wrapper, `table.grid` list, `.primary`
 * action + `.link-btn` row actions, `.exec-detail` in-page editor
 * (NOT a fixed drawer), `.status` chips for load state. All styling
 * comes from `styles.css` — no inline aesthetic overrides except the
 * narrow layout/grid sizing that matches the existing screens.
 *
 * Behaviour:
 *
 *   - List rows (id, kind, git url + ref + short sha, last-fetched,
 *     status chip, plugin count). Built-in rows surface read-only.
 *   - In-page editor with two-column grid (mirrors Connections) for
 *     create / update.
 *   - Refresh button calls POST /api/plugins/refresh, shows the
 *     returned diff (added / removed / updated) inline.
 *   - Per-source failure surfaces its STAGE (resolve / clone / install
 *     / verify / import / scan / register) + message so the operator
 *     diagnoses without logs.
 *
 * Auth: `plugin:manage` gates every mutating control client-side AND
 * server-side; the table renders for any viewer-level user.
 */
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
    // The list endpoint doesn't echo the signing material back (the
    // catalog view elides it); operators re-supply the textarea on
    // edit. A blank `allowedSigners` with `requireSignature: true`
    // is refused server-side as a loud misconfig.
    requireSignature: false,
    allowedSigners: ""
  };
}

function shortSha(sha?: string): string {
  return sha ? sha.slice(0, 7) : "—";
}

function fmtTimestamp(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

/** Map a source's load status onto the design system's status chip
 *  classes — same chips Executions / Connections use, so the colour
 *  language carries over. */
function statusChip(s: PluginSourceView): {
  cls: string;
  label: string;
  title?: string;
} {
  if (s.builtin) {
    return { cls: "status", label: "built-in" };
  }
  switch (s.status) {
    case "loaded":
      return {
        cls: "status status-succeeded",
        label: `loaded · ${s.pluginCount ?? 0}`,
        title: `${s.pluginCount ?? 0} plugin${s.pluginCount === 1 ? "" : "s"} registered from this source`
      };
    case "failed":
      return {
        cls: "status status-failed",
        label: `failed · ${s.errorStage ?? "?"}`,
        title: s.error ?? "failed"
      };
    case "skipped":
      return { cls: "status status-skipped", label: "skipped" };
    default:
      return { cls: "status", label: "not loaded" };
  }
}

interface DiffReport {
  added: string[];
  removed: string[];
  updated: string[];
}

export function PluginSourcesScreen() {
  const { can } = useAuth();
  const canManage = can("plugin:manage");
  const qc = useQueryClient();
  const sourcesQ = useQuery({
    queryKey: ["plugin-sources"],
    queryFn: () => api.listPluginSources()
  });

  type EditMode = "new" | string | null;
  const [editing, setEditing] = useState<EditMode>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [lastDiff, setLastDiff] = useState<DiffReport | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const openNew = () => {
    setDraft(emptyDraft());
    setEditing("new");
  };
  const openEdit = (s: PluginSourceView) => {
    setDraft(fromSource(s));
    setEditing(s.id);
  };
  const closeEditor = () => setEditing(null);

  const createMut = useMutation({
    mutationFn: () =>
      api.createPluginSource({
        id: draft.id,
        gitUrl: draft.gitUrl,
        ref: draft.ref,
        subpath: draft.subpath || undefined,
        displayName: draft.displayName || undefined,
        description: draft.description || undefined,
        enabled: draft.enabled,
        requireSignature: draft.requireSignature,
        allowedSigners: draft.requireSignature ? draft.allowedSigners : undefined
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plugin-sources"] });
      closeEditor();
    }
  });
  const updateMut = useMutation({
    mutationFn: () =>
      api.updatePluginSource(editing as string, {
        gitUrl: draft.gitUrl,
        ref: draft.ref,
        subpath: draft.subpath,
        displayName: draft.displayName,
        description: draft.description,
        enabled: draft.enabled,
        requireSignature: draft.requireSignature,
        // Only ship `allowedSigners` when the operator typed
        // something in this edit — keeps the audit log free of
        // empty-string overwrites every time someone toggles
        // enabled. The server preserves the existing value when the
        // field is omitted.
        ...(draft.requireSignature && draft.allowedSigners
          ? { allowedSigners: draft.allowedSigners }
          : {})
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plugin-sources"] });
      closeEditor();
    }
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deletePluginSource(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["plugin-sources"] })
  });
  const refreshMut = useMutation({
    mutationFn: () => api.refreshPluginRegistry(),
    onMutate: () => setRefreshError(null),
    onSuccess: (report) => {
      setLastDiff(report.diff);
      qc.invalidateQueries({ queryKey: ["plugin-sources"] });
    },
    onError: (e) =>
      setRefreshError(e instanceof Error ? e.message : String(e))
  });

  const sources = sourcesQ.data?.sources ?? [];

  const formError =
    (createMut.error ?? updateMut.error) instanceof Error
      ? ((createMut.error as Error)?.message ??
        (updateMut.error as Error)?.message ??
        null)
      : null;

  const diffEmpty =
    !!lastDiff &&
    lastDiff.added.length + lastDiff.removed.length + lastDiff.updated.length ===
      0;

  return (
    <Screen
      title="Plugin sources"
      isLoading={sourcesQ.isLoading}
      error={sourcesQ.error}
    >
      <p className="muted">
        External (internal/trusted) git repos that ship plugin code.
        Built-in rows are the safety net — they always load. Refresh
        rebuilds the registry from the source list and atomically
        swaps it; in-flight executions keep their prior snapshot.
      </p>

      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: 12
        }}
      >
        {canManage && (
          <>
            <button
              className="primary"
              onClick={openNew}
              disabled={editing === "new"}
            >
              + New source
            </button>
            <button
              onClick={() => refreshMut.mutate()}
              disabled={refreshMut.isPending}
              title="Rebuild the plugin registry from every enabled source. In-flight executions keep their snapshot; new requests see the new registry."
            >
              {refreshMut.isPending ? "Refreshing…" : "Refresh"}
            </button>
          </>
        )}
        <span style={{ flex: 1 }} />
      </div>

      {refreshError && (
        <p className="error">Refresh failed: {refreshError}</p>
      )}

      {lastDiff && (
        <div className="exec-detail" style={{ marginBottom: 12, padding: 12 }}>
          <strong>Last refresh</strong>{" "}
          {diffEmpty ? (
            <span className="muted">
              — no plugin set changes (caches up-to-date).
            </span>
          ) : (
            <>
              <span className="status status-succeeded" style={{ marginLeft: 6 }}>
                +{lastDiff.added.length} added
              </span>{" "}
              <span className="status status-running">
                ~{lastDiff.updated.length} updated
              </span>{" "}
              <span className="status status-failed">
                −{lastDiff.removed.length} removed
              </span>
              {(lastDiff.added.length ||
                lastDiff.updated.length ||
                lastDiff.removed.length) > 0 && (
                <details style={{ marginTop: 6 }}>
                  <summary className="muted">Plugin keys</summary>
                  <ul style={{ margin: "4px 0 0 18px", fontSize: 12 }}>
                    {lastDiff.added.map((k) => (
                      <li key={`a-${k}`}>
                        <code>+ {k}</code>
                      </li>
                    ))}
                    {lastDiff.updated.map((k) => (
                      <li key={`u-${k}`}>
                        <code>~ {k}</code>
                      </li>
                    ))}
                    {lastDiff.removed.map((k) => (
                      <li key={`r-${k}`}>
                        <code>− {k}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>
      )}

      <table className="grid">
        <thead>
          <tr>
            <th>Id</th>
            <th>Kind</th>
            <th>Repo</th>
            <th>Ref · sha</th>
            <th>Last fetched</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sources.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                {sourcesQ.data ? "No plugin sources." : "Loading…"}
              </td>
            </tr>
          )}
          {sources.map((s) => {
            const isOpen = editing === s.id;
            const chip = statusChip(s);
            const dim = !s.enabled ? { opacity: 0.55 } : undefined;
            return (
              <tr
                key={s.id}
                className={isOpen ? "row-selected" : undefined}
              >
                <td style={dim}>
                  <code>{s.id}</code>
                  {!s.enabled && (
                    <span
                      className="muted"
                      style={{ marginLeft: 6, fontSize: "0.8em" }}
                      title="disabled — loader skips this source on refresh"
                    >
                      (disabled)
                    </span>
                  )}
                </td>
                <td style={dim}>{s.kind}</td>
                <td style={dim}>
                  {s.gitUrl ? (
                    <code style={{ fontSize: 11 }}>{s.gitUrl}</code>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td style={dim}>
                  {s.ref ? <code>{s.ref}</code> : <span className="muted">—</span>}
                  {s.lastCommitSha && (
                    <>
                      {" · "}
                      <code
                        className="muted"
                        title={s.lastCommitSha}
                        style={{ fontSize: 11 }}
                      >
                        {shortSha(s.lastCommitSha)}
                      </code>
                    </>
                  )}
                </td>
                <td style={dim} className="muted">
                  {fmtTimestamp(s.lastFetchedAt)}
                </td>
                <td style={dim}>
                  <span className={chip.cls} title={chip.title}>
                    {chip.label}
                  </span>
                  {s.status === "failed" && s.error && (
                    <div
                      className="error"
                      style={{ marginTop: 4, fontSize: 11, whiteSpace: "pre-wrap" }}
                    >
                      {s.error}
                    </div>
                  )}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {canManage && !s.builtin && (
                    <>
                      <button
                        className="link-btn"
                        onClick={() => openEdit(s)}
                        disabled={editing === s.id}
                      >
                        edit
                      </button>
                      {" · "}
                      <button
                        className="link-btn danger"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete plugin source "${s.id}"? Its plugins disappear on the next refresh.`
                            )
                          ) {
                            deleteMut.mutate(s.id);
                          }
                        }}
                      >
                        delete
                      </button>
                    </>
                  )}
                  {s.builtin && (
                    <span className="muted" style={{ fontSize: 11 }}>
                      built-in
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {editing !== null && canManage && (
        <section className="exec-detail" style={{ marginTop: 16, padding: 16 }}>
          <h2>
            {editing === "new" ? "New plugin source" : `Edit ${draft.id}`}
          </h2>
          <div
            style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }}
          >
            <label>
              <div className="muted">Id</div>
              <input
                value={draft.id}
                disabled={editing !== "new"}
                onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                placeholder="ext-acme"
              />
            </label>
            <label>
              <div className="muted">Display name</div>
              <input
                value={draft.displayName}
                onChange={(e) =>
                  setDraft({ ...draft, displayName: e.target.value })
                }
                placeholder="Acme plugins"
              />
            </label>
            <label style={{ gridColumn: "1 / -1" }}>
              <div className="muted">Git URL</div>
              <input
                value={draft.gitUrl}
                onChange={(e) =>
                  setDraft({ ...draft, gitUrl: e.target.value })
                }
                placeholder="https://git.internal.example/plugins.git"
              />
            </label>
            <label>
              <div className="muted">Ref (branch / tag / commit sha)</div>
              <input
                value={draft.ref}
                onChange={(e) => setDraft({ ...draft, ref: e.target.value })}
                placeholder="main"
              />
            </label>
            <label>
              <div className="muted">Subpath inside the repo</div>
              <input
                value={draft.subpath}
                onChange={(e) =>
                  setDraft({ ...draft, subpath: e.target.value })
                }
                placeholder="src"
              />
            </label>
            <label style={{ gridColumn: "1 / -1" }}>
              <div className="muted">Description</div>
              <input
                value={draft.description}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
                placeholder="(optional)"
              />
            </label>
            <label
              style={{ display: "flex", alignItems: "center", gap: 6 }}
            >
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) =>
                  setDraft({ ...draft, enabled: e.target.checked })
                }
              />
              enabled
            </label>
            <label
              style={{ display: "flex", alignItems: "center", gap: 6 }}
              title="When set, the loader runs `git verify-commit` against the allowed-signers below before importing this source. A bad/missing/untrusted signature blocks load — install never runs on an untrusted source."
            >
              <input
                type="checkbox"
                checked={draft.requireSignature}
                onChange={(e) =>
                  setDraft({ ...draft, requireSignature: e.target.checked })
                }
              />
              require git signature (KISS)
            </label>
            {draft.requireSignature && (
              <label style={{ gridColumn: "1 / -1" }}>
                <div className="muted">
                  Allowed signers (SSH allowed-signers file content)
                </div>
                <textarea
                  value={draft.allowedSigners}
                  onChange={(e) =>
                    setDraft({ ...draft, allowedSigners: e.target.value })
                  }
                  placeholder={`octocat namespaces=git ssh-ed25519 AAAA...`}
                  rows={5}
                  style={{
                    width: "100%",
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, monospace",
                    fontSize: 12,
                    border: "1px solid #cbd5e1",
                    borderRadius: 6,
                    padding: "6px 8px"
                  }}
                />
                <p className="muted field-help" style={{ fontSize: 11 }}>
                  Reused on every verify; format is the SSH allowed-signers
                  file (one entry per line). Leave empty + uncheck the box
                  to disable signing for this source.
                </p>
              </label>
            )}
          </div>

          {formError && <p className="error">{formError}</p>}

          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button
              className="primary"
              onClick={() =>
                editing === "new" ? createMut.mutate() : updateMut.mutate()
              }
              disabled={createMut.isPending || updateMut.isPending}
            >
              {editing === "new" ? "Create" : "Save"}
            </button>
            <button onClick={closeEditor}>Cancel</button>
          </div>
        </section>
      )}
    </Screen>
  );
}
