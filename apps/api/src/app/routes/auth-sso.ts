/**
 * SSO entry points: enumerate enabled providers + start an OIDC/SAML
 * flow + GET/POST callback handlers. The OIDC/SAML provider machinery
 * is built per-request from the identity_providers row.
 *
 * Pending state (10-minute TTL — start → IdP → callback) goes through
 * the injected `ssoStates: SsoStateStore`. Server.ts wires the
 * Redis-backed implementation when REDIS_URL is set so a callback that
 * lands on a different api pod than the start still finds the entry;
 * single-pod / offline test paths use the in-memory store. ADR
 * 0005 has the full reasoning.
 */
import {
  OidcProvider,
  SamlProvider,
  randomToken,
  AccountDisabledError,
  InMemorySsoStateStore,
  type AccountService,
  type SsoIdentity,
  type SsoStateStore
} from "../../../../../packages/auth/src/index.ts";
import type {
  IdentityProviderRepository,
  IdentityProviderRow
} from "../../../../../packages/db/src/index.ts";
import { ok, error, isObject, clientIp } from "../http-utils.ts";
import { requestOrigin, webRedirect } from "../projections.ts";
import type { AppDeps, AppResponse } from "../types.ts";
import type { RouteRegistry } from "./types.ts";
import { ssoPerIpLimiter } from "../rate-limit.ts";

function ssoRateLimit(
  headers: Record<string, string | string[] | undefined>
): AppResponse | undefined {
  const ip = clientIp(headers) ?? "unknown";
  const decision = ssoPerIpLimiter.consume(`sso:${ip}`);
  if (decision.allowed) return undefined;
  return {
    status: 429,
    body: { error: "rate_limited", scope: "ip", retryAfterSec: decision.retryAfterSec },
    headers: { "retry-after": String(decision.retryAfterSec) }
  };
}

interface SsoServices {
  deps: AppDeps;
  accounts?: AccountService;
  identityProviders: IdentityProviderRepository;
  buildSsoProvider: (row: IdentityProviderRow) => OidcProvider | SamlProvider;
  /** Optional Redis-backed (or otherwise injected) store. When omitted,
   *  falls back to an InMemorySsoStateStore so single-pod / test paths
   *  keep working unchanged. */
  ssoStateStore?: SsoStateStore;
}

const SSO_STATE_TTL_MS = 10 * 60 * 1000;

export function registerAuthSsoRoutes(
  api: RouteRegistry,
  svc: SsoServices
): void {
  const { deps, accounts, identityProviders, buildSsoProvider } = svc;
  const ssoStates: SsoStateStore = svc.ssoStateStore ?? new InMemorySsoStateStore();

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
    const limited = ssoRateLimit(ctx.request.headers);
    if (limited) return limited;
    const row = await identityProviders.findBySlug(ctx.params.slug);
    if (!row || !row.enabled) return error(404, "provider_not_found");
    const provider = buildSsoProvider(row);
    const origin = requestOrigin(ctx.request);
    const redirectUri =
      String((row.config as Record<string, unknown>).callbackUrl ?? "") ||
      `${origin}/api/auth/sso/${row.slug}/callback`;
    const state = randomToken();
    const nonce = randomToken();
    await ssoStates.set(
      state,
      { slug: row.slug, nonce, redirectUri, at: Date.now() },
      SSO_STATE_TTL_MS
    );
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
    const pending = state ? await ssoStates.get(state) : undefined;
    // The Redis store enforces TTL server-side (`EX` seconds), so an
    // expired entry returns undefined. The in-memory store also expires
    // lazily on get. Keep the elapsed-time check as a defence-in-depth
    // for stores that don't enforce TTL themselves.
    if (!state || !pending || Date.now() - pending.at > SSO_STATE_TTL_MS) {
      return error(400, "sso_state_invalid");
    }
    await ssoStates.delete(state);
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

  api.route("GET", "/api/auth/sso/:slug/callback", async (ctx) => {
    const limited = ssoRateLimit(ctx.request.headers);
    if (limited) return limited;
    return completeSso(ctx.request.query.code, undefined, ctx.request.query.state);
  });

  api.route("POST", "/api/auth/sso/:slug/callback", async (ctx) => {
    const limited = ssoRateLimit(ctx.request.headers);
    if (limited) return limited;
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
