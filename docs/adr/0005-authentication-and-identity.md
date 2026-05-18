# ADR 0005: Authentication and Identity Model

## Status

Accepted

## Context

The control plane needs identity for humans and machines, must be testable
offline, and must never let a development convenience weaken a production
deployment. Authorization (roles and tenant scoping) already exists in
`@ragdoll/authz`; authentication had to bridge into it.

## Decision

`@ragdoll/auth` resolves a `Principal` from request headers with fixed
precedence:

1. `Authorization: Bearer <token>` -> `SessionTokenService` (compact
   HMAC-SHA256 token, custom `typ: "RGD"`, `iat`/`exp`, constant-time verify).
2. `Authorization: ApiKey <key>` or `x-api-key` -> `ApiKeyService` (`rgd_`
   keys; only a sha256 hash plus a lookup prefix are stored; constant-time
   compare; revocable).
3. `DevAuthProvider` — trusts `x-actor-id` / `x-tenant-id` / `x-roles`
   verbatim. It is insecure and the API rejects its `dev-user` fallback when
   `RAGDOLL_ENV=production`.

`enforce(principal, permission, resource)` wraps `requirePermission` from
`@ragdoll/authz`, merging the principal's tenant into the resource so cross-
tenant access is denied unless the principal is `platform_admin`. Postgres
repositories back keys and sessions (migration `002_auth`); in-memory
repositories back tests.

## Consequences

- Machine (API key) and interactive (session token) auth share one RBAC path.
- No plaintext key or session secret is persisted.
- The dev provider keeps offline tests trivial but cannot leak into
  production because the API disables its fallback there.
- Federated/OIDC auth can be added later as another `AuthResolver` source
  without changing route handlers.
