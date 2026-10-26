/**
 * ADR-0039: the sidecar → core credential-refresh endpoint.
 *
 * - POST /api/internal/connection-credentials/refresh  (public — the grant
 *   token IS the auth, exactly like the webhook-trigger route)
 *
 * A sidecar plugin received an inline credential in its execute request plus a
 * revocable refresh grant. When that credential nears expiry it POSTs
 * `{ "token": "<grant>" }` here and gets `{ "credential": { ... } }` back —
 * core re-resolves the connection and re-runs the driver's materialise hook, so
 * the sidecar never re-implements the driver's identity logic and a long crawl
 * never dies on an expired token.
 *
 * The grant is the whole authorisation: minted only after `connection:use` was
 * enforced at dispatch, scoped to one (execution, node, connection), revocable,
 * and expiring with the run. This handler therefore does NOT call `enforce` —
 * the request principal is anonymous (the path is on the public allowlist).
 */
import {
  ExternalConnectionResolver,
  redeemConnectionCredentialGrant,
  CONNECTION_CREDENTIAL_REFRESH_PATH
} from "../../../../../packages/external-connections/src/index.ts";
import type { ConnectionCredentialGrantRepository } from "../../../../../packages/db/src/index.ts";
import { ok, error, isObject, clientIp } from "../http-utils.ts";
import { RateLimiter } from "../rate-limit.ts";
import type { AppDeps } from "../types.ts";
import type { RouteRegistry, AuditWriter } from "./types.ts";

interface ConnectionCredentialServices {
  deps: AppDeps;
  audit: AuditWriter;
  grants: ConnectionCredentialGrantRepository;
}

// Dedicated limiters so credential refreshes never share a budget with webhook
// deliveries. A long crawl refreshes a handful of times per run; a flood of
// bad tokens from one source is what we clamp.
const perIpLimiter = new RateLimiter({ capacity: 60, refillPerSec: 1 });
const perTokenLimiter = new RateLimiter({ capacity: 30, refillPerSec: 0.5 });

export function registerConnectionCredentialRoutes(
  api: RouteRegistry,
  services: ConnectionCredentialServices
): void {
  const { deps, audit, grants } = services;

  api.route("POST", CONNECTION_CREDENTIAL_REFRESH_PATH, async (ctx) => {
    const ip = clientIp(ctx.request.headers) ?? "unknown";
    const ipDecision = perIpLimiter.consume(`ip:${ip}`);
    if (!ipDecision.allowed) {
      return {
        status: 429,
        body: { error: "rate_limited", scope: "ip", retryAfterSec: ipDecision.retryAfterSec },
        headers: { "retry-after": String(ipDecision.retryAfterSec) }
      };
    }

    const body = ctx.request.body;
    const token =
      isObject(body) && typeof body.token === "string" ? body.token : undefined;
    if (!token) {
      return error(400, "invalid_request", { message: "body.token is required" });
    }

    // Per-token-prefix limiter — opaque to an attacker who can't precompute the
    // prefix without already holding a valid token, bounded for one legit token.
    const tokDecision = perTokenLimiter.consume(`tok:${token.slice(0, 12)}`);
    if (!tokDecision.allowed) {
      return {
        status: 429,
        body: { error: "rate_limited", scope: "token", retryAfterSec: tokDecision.retryAfterSec },
        headers: { "retry-after": String(tokDecision.retryAfterSec) }
      };
    }

    const resolver = new ExternalConnectionResolver(
      deps.connections,
      deps.secretProvider
    );
    const result = await redeemConnectionCredentialGrant({ token, grants, resolver });

    switch (result.status) {
      case "unknown_token":
        return error(401, "invalid_grant", { message: "unknown grant token" });
      case "expired":
        return error(401, "grant_expired", { message: "grant has expired" });
      case "revoked":
        return error(403, "grant_revoked", { message: "grant was revoked" });
      case "no_connection":
        return error(404, "connection_not_found", {
          message: "the grant's connection no longer resolves"
        });
      case "not_materializable":
        return error(409, "not_materializable", {
          message: "the connection driver no longer exposes an external credential"
        });
      case "ok": {
        const grant = result.grant!;
        // Audit the issuance at the grant's own tenant scope (the principal is
        // anonymous here). Never record the credential itself.
        await audit(
          ctx,
          "connection_credential.refresh",
          "connection",
          grant.connectionSlug,
          null,
          {
            executionId: grant.executionId,
            nodeId: grant.nodeId,
            redeemCount: grant.redeemCount + 1,
            expiresAt: result.credential?.expiresAt ?? null
          },
          grant.tenantId
        );
        return ok({ credential: result.credential });
      }
      default:
        return error(500, "internal_error");
    }
  });
}
