/**
 * Pure projection helpers — turn internal DB rows / records into the
 * non-secret shape the wire returns. Used across multiple route
 * modules; no closure state, no side effects.
 */
import { scopeToString } from "../../../../packages/authz/src/index.ts";
import type {
  UserRow,
  IdentityProviderRow,
  PipelineActivationRow
} from "../../../../packages/db/src/index.ts";
import type { ApiKeyRecord } from "../../../../packages/auth/src/index.ts";
import { effectiveVersionId } from "../../../../packages/pipeline-spec/src/index.ts";
import type { AppRequest, AppResponse } from "./types.ts";
import { headerValue } from "./http-utils.ts";

export function publicUser(u: UserRow): Record<string, unknown> {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName ?? null,
    status: u.status,
    sso: !u.passwordHash,
    createdAt: u.createdAt
  };
}

/**
 * Non-secret view of an API key. The stored sha256 hash and the
 * one-time plaintext are NEVER part of this projection — only the
 * lookup `prefix`, which is not a credential on its own.
 */
export function publicApiKey(r: ApiKeyRecord): Record<string, unknown> {
  const expired =
    !!r.expiresAt && new Date(r.expiresAt).getTime() <= Date.now();
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    roles: r.roles,
    tenantId: r.tenantId ?? null,
    environmentId: r.environmentId ?? null,
    scope: scopeToString({
      tenantId: r.tenantId,
      environment: r.environmentId
    }),
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt ?? null,
    revokedAt: r.revokedAt ?? null,
    expiresAt: r.expiresAt ?? null,
    status: r.revokedAt ? "revoked" : expired ? "expired" : "active"
  };
}

/** Non-secret view of an IdP (client secrets / SP keys are write-only). */
export function publicIdp(p: IdentityProviderRow): Record<string, unknown> {
  const cfg = { ...(p.config as Record<string, unknown>) };
  for (const k of ["clientSecret", "spPrivateKey", "privateKey"]) {
    if (k in cfg) cfg[k] = "REDACTED";
  }
  return {
    id: p.id,
    slug: p.slug,
    kind: p.kind,
    displayName: p.displayName,
    enabled: p.enabled,
    config: cfg
  };
}

export function projectActivation(
  row: PipelineActivationRow,
  pipelineLatestVersionId: string | null
): Record<string, unknown> {
  let effective: string | null = null;
  try {
    effective = effectiveVersionId(
      { trackLatest: row.trackLatest, pipelineVersionId: row.pipelineVersionId ?? null },
      pipelineLatestVersionId
    );
  } catch {
    effective = null;
  }
  return {
    id: row.id,
    label: row.label,
    environment: row.environment,
    pipelineVersionId: row.pipelineVersionId ?? null,
    trackLatest: row.trackLatest,
    enabled: row.enabled,
    effectiveVersionId: effective
  };
}

export function requestOrigin(req: AppRequest): string {
  const proto = headerValue(req.headers, "x-forwarded-proto") ?? "http";
  const host =
    headerValue(req.headers, "x-forwarded-host") ??
    headerValue(req.headers, "host") ??
    "localhost:3001";
  return `${proto}://${host}`;
}

export function webRedirect(token: string): AppResponse {
  const base = process.env.WEB_BASE_URL ?? "/";
  const sep = base.includes("#") ? "&" : "#";
  return {
    status: 302,
    body: undefined,
    headers: {
      location: `${base}${sep}access_token=${encodeURIComponent(token)}`
    }
  };
}
