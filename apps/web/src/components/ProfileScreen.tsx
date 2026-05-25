import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.ts";
import type { ApiKeyView, GrantView } from "../lib/api.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { Screen, Table } from "./Screen.tsx";

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const b = e.body as { error?: string; message?: string } | undefined;
    return `HTTP ${e.status}: ${b?.message ?? b?.error ?? JSON.stringify(e.body)}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Human label for a grant's scope, mirroring the Users screen. */
function scopeLabel(g: GrantView): string {
  return g.tenantId ? `tenant ${g.tenantId.slice(0, 8)}…` : "global";
}

/** Edit the signed-in user's display name. */
function ProfileCard() {
  const auth = useAuth();
  const [displayName, setDisplayName] = useState(auth.user?.displayName ?? "");

  const save = useMutation({
    mutationFn: () =>
      api.updateProfile({ displayName: displayName.trim() || null }),
    onSuccess: () => auth.refresh()
  });

  const u = auth.user;
  return (
    <div className="settings-card">
      <h3>Account</h3>
      <Table
        columns={["Field", "Value"]}
        rows={[
          ["Email", u?.email ?? "—"],
          [
            "Sign-in",
            <span key="a" className="status">
              {u?.sso ? "SSO / federated" : "local password"}
            </span>
          ],
          [
            "Status",
            <span
              key="s"
              className={`status ${
                u?.status === "active" ? "status-succeeded" : "status-failed"
              }`}
            >
              {u?.status ?? "—"}
            </span>
          ],
          [
            "Roles",
            auth.grants.length
              ? auth.grants
                  .map((g) => `${g.role} (${scopeLabel(g)})`)
                  .join(", ")
              : "none"
          ]
        ]}
      />
      <form
        className="inline-form"
        style={{ marginTop: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <label>
          Display name:&nbsp;
          <input
            placeholder="display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
        <button type="submit" className="primary" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {save.isError && <span className="error">{errText(save.error)}</span>}
        {save.isSuccess && (
          <span className="status status-succeeded">saved</span>
        )}
      </form>
    </div>
  );
}

/** Change (or, for an SSO-only account, set) the signed-in user's password. */
function PasswordCard() {
  const auth = useAuth();
  const ssoOnly = auth.user?.sso ?? false;
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");

  const mismatch = confirm.length > 0 && next !== confirm;
  const tooShort = next.length > 0 && next.length < 8;

  const save = useMutation({
    mutationFn: () =>
      api.changePassword({
        currentPassword: ssoOnly ? undefined : current,
        newPassword: next
      }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirm("");
      // The display reflects whether a local password exists.
      auth.refresh();
    }
  });

  return (
    <div className="settings-card">
      <h3>{ssoOnly ? "Set a password" : "Change password"}</h3>
      <p className="muted">
        {ssoOnly
          ? "Your account signs in via SSO. Setting a password also enables local sign-in."
          : "Choose a new password (at least 8 characters)."}
      </p>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (mismatch || tooShort) return;
          save.mutate();
        }}
      >
        {!ssoOnly && (
          <input
            type="password"
            placeholder="current password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        )}
        <input
          type="password"
          placeholder="new password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="confirm new password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
        <button
          type="submit"
          className="primary"
          disabled={save.isPending || mismatch || tooShort || next.length === 0}
        >
          {save.isPending ? "Saving…" : "Update password"}
        </button>
        {tooShort && (
          <span className="error">at least 8 characters</span>
        )}
        {mismatch && <span className="error">passwords do not match</span>}
        {save.isError && <span className="error">{errText(save.error)}</span>}
        {save.isSuccess && (
          <span className="status status-succeeded">updated</span>
        )}
      </form>
    </div>
  );
}

/** The one-time plaintext of a freshly minted key. */
function NewKeyBanner(props: { plaintext: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="settings-card" style={{ borderColor: "var(--accent, #4b8)" }}>
      <h3>Copy your new API key</h3>
      <p className="muted">
        This is the only time the key is shown — store it now. Send it as{" "}
        <code>Authorization: ApiKey &lt;key&gt;</code> or an{" "}
        <code>x-api-key</code> header.
      </p>
      <pre className="field-json" style={{ userSelect: "all" }}>
        {props.plaintext}
      </pre>
      <div className="inline-form" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="primary"
          onClick={() => {
            navigator.clipboard?.writeText(props.plaintext).then(
              () => setCopied(true),
              () => setCopied(false)
            );
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className="link-btn" onClick={props.onDismiss}>
          done
        </button>
      </div>
    </div>
  );
}

/** Issue, list, and revoke the signed-in user's API keys. */
function ApiKeysCard() {
  const auth = useAuth();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [grantIdx, setGrantIdx] = useState(0);
  const [environmentId, setEnvironmentId] = useState<string>("");
  const [expiresPreset, setExpiresPreset] = useState<string>("never");
  const [issued, setIssued] = useState<{ key: ApiKeyView; plaintext: string } | null>(
    null
  );

  // A key cannot exceed its issuer, and an API key is scoped globally or to a
  // whole tenant — so only the user's global / tenant-level grants are
  // delegable. Environment- and pipeline-scoped grants are excluded; an env
  // scope, when wanted, is set on the key itself via the picker below.
  const eligible = useMemo(
    () => auth.grants.filter((g) => !g.environment && !g.pipelineId),
    [auth.grants]
  );

  const selectedGrant = eligible[grantIdx];
  const selectedTenantId = selectedGrant?.tenantId;

  // Tenant environments only matter when a tenant grant is selected.
  // Platform-wide grants (tenantId === undefined) can't carry an env scope.
  const envs = useQuery({
    queryKey: ["tenant-environments", selectedTenantId ?? "none"],
    queryFn: () =>
      selectedTenantId
        ? api.listEnvironments(selectedTenantId)
        : Promise.resolve({ environments: [] }),
    enabled: Boolean(selectedTenantId)
  });

  const keys = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => api.listApiKeys()
  });

  function resolveExpiresAt(): string | undefined {
    if (expiresPreset === "never") return undefined;
    const m = /^(\d+)([dhm])$/.exec(expiresPreset);
    if (!m) return undefined;
    const n = Number(m[1]);
    const ms =
      m[2] === "d" ? n * 86_400_000 : m[2] === "h" ? n * 3_600_000 : n * 60_000;
    return new Date(Date.now() + ms).toISOString();
  }

  const create = useMutation({
    mutationFn: () => {
      const g = eligible[grantIdx];
      return api.createApiKey({
        name: name.trim(),
        role: g.role,
        tenantId: g.tenantId,
        environmentId: environmentId || undefined,
        expiresAt: resolveExpiresAt()
      });
    },
    onSuccess: (res) => {
      setName("");
      setEnvironmentId("");
      setExpiresPreset("never");
      setIssued({ key: res.apiKey, plaintext: res.plaintext });
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    }
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeApiKey(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] })
  });

  return (
    <>
      {issued && (
        <NewKeyBanner
          plaintext={issued.plaintext}
          onDismiss={() => setIssued(null)}
        />
      )}
      <div className="settings-card">
        <h3>API keys</h3>
        <p className="muted">
          A key authenticates non-interactive clients (the MCP server, CLI,
          scripts). It carries one role you already hold; revoke it anytime.
        </p>

        {eligible.length === 0 ? (
          <p className="error">
            You hold no global or tenant-level role, so there is nothing an API
            key could be scoped to. Ask an administrator for a grant.
          </p>
        ) : (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <input
              placeholder="key name (e.g. local MCP)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <select
              value={grantIdx}
              onChange={(e) => {
                setGrantIdx(Number(e.target.value));
                // Selecting a new grant clears the env — environments are
                // tenant-scoped, so the choice may not be valid anymore.
                setEnvironmentId("");
              }}
            >
              {eligible.map((g, i) => (
                <option key={g.id} value={i}>
                  {g.role} · {scopeLabel(g)}
                </option>
              ))}
            </select>
            {selectedTenantId && (envs.data?.environments ?? []).length > 0 && (
              <select
                value={environmentId}
                onChange={(e) => setEnvironmentId(e.target.value)}
                title="Restrict the key to a single environment"
              >
                <option value="">all envs</option>
                {(envs.data?.environments ?? []).map((env) => (
                  <option key={env.id} value={env.name}>
                    env · {env.name}
                  </option>
                ))}
              </select>
            )}
            <select
              value={expiresPreset}
              onChange={(e) => setExpiresPreset(e.target.value)}
              title="Optional expiration"
            >
              <option value="never">no expiration</option>
              <option value="1h">expires in 1 hour</option>
              <option value="24h">expires in 24 hours</option>
              <option value="7d">expires in 7 days</option>
              <option value="30d">expires in 30 days</option>
              <option value="90d">expires in 90 days</option>
            </select>
            <button
              type="submit"
              className="primary"
              disabled={create.isPending}
            >
              {create.isPending ? "Creating…" : "Create key"}
            </button>
            {create.isError && (
              <span className="error">{errText(create.error)}</span>
            )}
          </form>
        )}

        <Table
          columns={[
            "Name",
            "Prefix",
            "Role",
            "Scope",
            "Last used",
            "Expires",
            "Status",
            ""
          ]}
          rows={(keys.data?.apiKeys ?? []).map((k) => [
            k.name,
            <code key="p">rgd_{k.prefix}_…</code>,
            k.roles.join(", ") || "—",
            <span key="sc" className="status">
              {k.scope === "*"
                ? "global"
                : k.environmentId
                  ? `tenant ${k.tenantId?.slice(0, 8)}… · ${k.environmentId}`
                  : `tenant ${k.tenantId?.slice(0, 8)}…`}
            </span>,
            k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "never",
            k.expiresAt ? new Date(k.expiresAt).toLocaleString() : "—",
            <span
              key="st"
              className={`status ${
                k.status === "active"
                  ? "status-succeeded"
                  : k.status === "expired"
                    ? "status-cancelled"
                    : "status-failed"
              }`}
            >
              {k.status}
            </span>,
            k.status === "active" ? (
              <button
                key="x"
                className="link-btn danger"
                onClick={() => revoke.mutate(k.id)}
                disabled={revoke.isPending}
              >
                revoke
              </button>
            ) : (
              <span key="x" className="muted">
                —
              </span>
            )
          ])}
        />
        {keys.isError && <p className="error">{errText(keys.error)}</p>}
      </div>
    </>
  );
}

/**
 * Self-service account screen: every signed-in user can edit their own
 * profile, change their password, and manage personal API keys here. No
 * special permission is required — the principal is the resource.
 */
export function ProfileScreen() {
  const auth = useAuth();
  return (
    <Screen title={`Profile · ${auth.user?.email ?? ""}`}>
      <ProfileCard />
      <PasswordCard />
      <ApiKeysCard />
    </Screen>
  );
}
