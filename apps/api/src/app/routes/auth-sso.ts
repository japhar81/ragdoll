/**
 * SSO entry points: enumerate enabled providers + start an OIDC/SAML
 * flow + GET/POST callback handlers. The OIDC/SAML provider machinery
 * is built per-request from the identity_providers row.
 *
 * The in-process `ssoStates` map is intentionally process-local: SSO
 * state TTL is 10 minutes, and a multi-replica deploy would need a
 * shared cache (Redis) to handle a callback landing on a different
 * pod than the start. For now the local map is good enough and the
 * worst-case is a re-auth.
 */
import {
  OidcProvider,
  SamlProvider,
  randomToken,
  AccountDisabledError,
  type AccountService,
  type SsoIdentity
} from "../../../../../packages/auth/src/index.ts";
import type {
  IdentityProviderRepository,
  IdentityProviderRow
} from "../../../../../packages/db/src/index.ts";
import { ok, error, isObject } from "../http-utils.ts";
import { requestOrigin, webRedirect } from "../projections.ts";
import type { AppDeps, AppResponse } from "../types.ts";
import type { RouteRegistry } from "./types.ts";

interface SsoServices {
  deps: AppDeps;
  accounts?: AccountService;
  identityProviders: IdentityProviderRepository;
  buildSsoProvider: (row: IdentityProviderRow) => OidcProvider | SamlProvider;
}

interface SsoPending {
  slug: string;
  nonce: string;
  redirectUri: string;
  at: number;
}

const SSO_STATE_TTL_MS = 10 * 60 * 1000;

export function registerAuthSsoRoutes(
  api: RouteRegistry,
  svc: SsoServices
): void {
  const { deps, accounts, identityProviders, buildSsoProvider } = svc;
  const ssoStates = new Map<string, SsoPending>();

  api.route("GET", "/api/auth/providers", async () => {
    const list = await identityProviders.listEnabled();
    return ok({
      providers: list.map((p) => ({
        slug: p.slug,
        kind: p.kind,
        displayName: p.displayName
      }))
    });
  });

  api.route("GET", "/api/auth/sso/:slug/start", async (ctx) => {
    const row = await identityProviders.findBySlug(ctx.params.slug);
    if (!row || !row.enabled) return error(404, "provider_not_found");
    const provider = buildSsoProvider(row);
    const origin = requestOrigin(ctx.request);
    const redirectUri =
      String((row.config as Record<string, unknown>).callbackUrl ?? "") ||
      `${origin}/api/auth/sso/${row.slug}/callback`;
    const state = randomToken();
    const nonce = randomToken();
    ssoStates.set(state, { slug: row.slug, nonce, redirectUri, at: Date.now() });
    if (provider instanceof OidcProvider) {
      const url = await provider.authorizationUrl({ redirectUri, state, nonce });
      return { status: 302, body: undefined, headers: { location: url } };
    }
    const url = await (provider as SamlProvider).loginRedirectUrl(state);
    return { status: 302, body: undefined, headers: { location: url } };
  });

  async function completeSso(
    code: string | undefined,
    samlBody: { SAMLResponse: string; RelayState?: string } | undefined,
    stateParam: string | undefined
  ): Promise<AppResponse> {
    if (!accounts) return error(501, "auth_not_configured");
    const state = stateParam ?? samlBody?.RelayState;
    const pending = state ? ssoStates.get(state) : undefined;
    if (!state || !pending || Date.now() - pending.at > SSO_STATE_TTL_MS) {
      return error(400, "sso_state_invalid");
    }
    ssoStates.delete(state);
    const row = await identityProviders.findBySlug(pending.slug);
    if (!row || !row.enabled) return error(404, "provider_not_found");
    const provider = buildSsoProvider(row);
    let identity: SsoIdentity;
    try {
      if (provider instanceof OidcProvider) {
        if (!code) return error(400, "missing_code");
        identity = await provider.handleCallback({
          code,
          redirectUri: pending.redirectUri,
          expectedNonce: pending.nonce
        });
      } else {
        if (!samlBody?.SAMLResponse) return error(400, "missing_saml_response");
        identity = await (provider as SamlProvider).validatePostResponse({
          SAMLResponse: samlBody.SAMLResponse
        });
      }
    } catch (e) {
      deps.logger.error("sso_validation_failed", {
        slug: pending.slug,
        error: e instanceof Error ? e.message : String(e)
      });
      return error(401, "sso_failed", { message: e instanceof Error ? e.message : "SSO failed" });
    }
    try {
      const out = await accounts.loginSso(pending.slug, identity);
      return webRedirect(out.token);
    } catch (e) {
      if (e instanceof AccountDisabledError) return error(403, "account_disabled");
      throw e;
    }
  }

  api.route("GET", "/api/auth/sso/:slug/callback", async (ctx) =>
    completeSso(ctx.request.query.code, undefined, ctx.request.query.state)
  );

  api.route("POST", "/api/auth/sso/:slug/callback", async (ctx) => {
    const body = isObject(ctx.request.body) ? ctx.request.body : {};
    return completeSso(
      typeof body.code === "string" ? body.code : ctx.request.query.code,
      typeof body.SAMLResponse === "string"
        ? {
            SAMLResponse: body.SAMLResponse,
            RelayState:
              typeof body.RelayState === "string" ? body.RelayState : undefined
          }
        : undefined,
      ctx.request.query.state
    );
  });
}
