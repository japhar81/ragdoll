import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.ts";
import type { IdentityProviderView } from "../lib/api.ts";
import { Screen, Table } from "./Screen.tsx";

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const b = e.body as { error?: string; message?: string } | undefined;
    return `HTTP ${e.status}: ${b?.message ?? b?.error ?? JSON.stringify(e.body)}`;
  }
  return e instanceof Error ? e.message : String(e);
}

const OIDC_FIELDS = ["issuer", "clientId", "clientSecret", "scopes"] as const;
const SAML_FIELDS = [
  "entryPoint",
  "issuer",
  "callbackUrl",
  "idpCert",
  "emailAttribute",
  "nameAttribute"
] as const;

export function IdentityProvidersScreen() {
  const qc = useQueryClient();
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [kind, setKind] = useState<"oidc" | "saml">("oidc");
  const [config, setConfig] = useState<Record<string, string>>({});

  const list = useQuery({
    queryKey: ["identity-providers"],
    queryFn: () => api.listIdentityProviders()
  });

  const fields = kind === "oidc" ? OIDC_FIELDS : SAML_FIELDS;

  const create = useMutation({
    mutationFn: () =>
      api.createIdentityProvider({
        slug,
        kind,
        displayName,
        config: Object.fromEntries(
          Object.entries(config).filter(([, v]) => v.trim() !== "")
        )
      }),
    onSuccess: () => {
      setSlug("");
      setDisplayName("");
      setConfig({});
      qc.invalidateQueries({ queryKey: ["identity-providers"] });
    }
  });
  const toggle = useMutation({
    mutationFn: (p: IdentityProviderView) =>
      api.updateIdentityProvider(p.id, { enabled: !p.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["identity-providers"] })
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteIdentityProvider(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["identity-providers"] })
  });

  return (
    <Screen
      title="Identity Providers"
      isLoading={list.isLoading}
      error={list.error}
    >
      <form
        className="idp-form"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="inline-form">
          <input
            placeholder="slug (e.g. okta)"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            required
          />
          <input
            placeholder="display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
          />
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "oidc" | "saml")}
          >
            <option value="oidc">OIDC</option>
            <option value="saml">SAML</option>
          </select>
        </div>
        <div className="idp-config">
          {fields.map((f) => (
            <label key={f} className="idp-field">
              <span>{f}</span>
              <input
                value={config[f] ?? ""}
                placeholder={f}
                type={/secret|cert|key/i.test(f) ? "password" : "text"}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, [f]: e.target.value }))
                }
              />
            </label>
          ))}
        </div>
        <button type="submit" className="primary" disabled={create.isPending}>
          Add provider
        </button>
        {create.isError && <span className="error">{errText(create.error)}</span>}
      </form>

      <Table
        columns={["Slug", "Name", "Kind", "Status", "Actions"]}
        rows={(list.data?.providers ?? []).map((p) => [
          <code key="s">{p.slug}</code>,
          p.displayName,
          <span key="k" className="status">{p.kind.toUpperCase()}</span>,
          <span
            key="e"
            className={`status ${p.enabled ? "status-succeeded" : "status-failed"}`}
          >
            {p.enabled ? "enabled" : "disabled"}
          </span>,
          <span key="a" className="row-actions">
            <button className="link-btn" onClick={() => toggle.mutate(p)}>
              {p.enabled ? "disable" : "enable"}
            </button>
            <button
              className="link-btn danger"
              onClick={() => del.mutate(p.id)}
            >
              delete
            </button>
          </span>
        ])}
      />
      <p className="muted">
        Client secrets / SP keys are write-only — shown as <code>REDACTED</code>{" "}
        and preserved unless you type a new value.
      </p>
    </Screen>
  );
}
