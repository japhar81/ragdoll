import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.ts";
import type { AuthSettings } from "../lib/api.ts";
import { Screen } from "./Screen.tsx";

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const b = e.body as { error?: string; message?: string } | undefined;
    return `HTTP ${e.status}: ${b?.message ?? b?.error ?? JSON.stringify(e.body)}`;
  }
  return e instanceof Error ? e.message : String(e);
}

const MODES: Array<{
  value: AuthSettings["signupMode"];
  title: string;
  blurb: string;
}> = [
  {
    value: "admin_only",
    title: "Admin-provisioned only",
    blurb:
      "No public signup. Admins create accounts. SSO users are auto-created with NO access until granted."
  },
  {
    value: "open_default_role",
    title: "Open signup + default role",
    blurb:
      "Anyone can register and is granted the default role at global scope."
  },
  {
    value: "open_no_access",
    title: "Open signup, zero access",
    blurb:
      "Anyone can register, but new accounts have NO permissions until an admin grants them."
  }
];

export function AuthSettingsScreen() {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ["auth-settings"],
    queryFn: () => api.getAuthSettings()
  });
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.listRoles() });

  const [mode, setMode] = useState<AuthSettings["signupMode"]>("admin_only");
  const [defaultRole, setDefaultRole] = useState<string>("viewer");

  useEffect(() => {
    if (settings.data) {
      setMode(settings.data.settings.signupMode);
      setDefaultRole(settings.data.settings.defaultRole ?? "viewer");
    }
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () =>
      api.updateAuthSettings({
        signupMode: mode,
        defaultRole: mode === "open_default_role" ? defaultRole : null
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth-settings"] })
  });

  return (
    <Screen
      title="Auth Settings"
      isLoading={settings.isLoading}
      error={settings.error}
    >
      <div className="settings-card">
        <h3>Signup mode</h3>
        <div className="mode-list">
          {MODES.map((m) => (
            <label
              key={m.value}
              className={`mode-item ${mode === m.value ? "selected" : ""}`}
            >
              <input
                type="radio"
                name="signup-mode"
                checked={mode === m.value}
                onChange={() => setMode(m.value)}
              />
              <div>
                <strong>{m.title}</strong>
                <div className="muted">{m.blurb}</div>
              </div>
            </label>
          ))}
        </div>

        {mode === "open_default_role" && (
          <label className="inline-form" style={{ marginTop: 12 }}>
            Default role:&nbsp;
            <select
              value={defaultRole}
              onChange={(e) => setDefaultRole(e.target.value)}
            >
              {(roles.data?.roles ?? []).map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <div style={{ marginTop: 16 }}>
          <button
            className="primary"
            onClick={() => save.mutate()}
            disabled={save.isPending}
          >
            {save.isPending ? "Saving…" : "Save settings"}
          </button>
          {save.isError && (
            <span className="error"> {errText(save.error)}</span>
          )}
          {save.isSuccess && (
            <span className="status status-succeeded"> saved</span>
          )}
        </div>
      </div>
    </Screen>
  );
}
