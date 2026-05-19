# ADR 0011: Login, SSO, and Casbin Scoped RBAC

## Status

Accepted (supersedes the "later" clause of ADR 0005).

## Context

ADR 0005 delivered machine/dev authentication and a flat, tenant-merged role
map, and explicitly deferred federated auth and finer authorization. We now
need: real interactive login (local + SSO), authorization that can restrict a
user *and the level they act at* (tenant / environment / pipeline), the whole
codebase covered by permissions, and a management UI — without breaking the
two hard constraints of this repo: the test runner is **install-free**
(`node --test`, empty `node_modules`) and the framework-agnostic app must stay
fast and synchronous at its ~65 `enforce(...)` call sites.

## Decision

**Authentication.** `SessionTokenService` (unchanged HMAC token) is now issued
by three sources: local password (`PasswordService`, `node:crypto` scrypt),
OIDC (dependency-free: discovery + JWKS RS256 verification with `fetch`), and
SAML (lazy `@node-saml/node-saml`). The token only identifies the user; grants
are resolved live. SSO connections and the signup-mode flag are runtime config
(`identity_providers`, `auth_settings`). The insecure dev provider is now
opt-in (`RAGDOLL_DEV_AUTH=1`, never in production) — the system is default-deny.

**Authorization.** RBAC becomes a Casbin policy: `g` = user→role@scope, `p` =
role→permission. Scope is the Casbin domain, hierarchical
(`*` ⊃ `t/T` ⊃ `t/T/e/E` | `t/T/p/P`); a custom domain-matching function
(`scopeCovers`) gives ancestor-covers-descendant inheritance. Casbin is lazily
imported and runs in the Docker image; a dependency-free `BuiltinPolicyEngine`
implements the identical model for the install-free runner and as a production
fallback. `packages/authz/test/casbin-conformance.test.ts` pins the two
engines to identical decisions.

To avoid making 65 call sites async, the `Authorizer` resolves a principal's
grants once per request and attaches a **synchronous** decision closure to the
principal; `enforce(principal, permission, resource)` keeps its signature and
falls back to the legacy flat map when no closure is attached (so existing
harnesses/tests are unchanged). The closure defaults the request's tenant from
`x-tenant-id`/principal — preserving the old tenant-merge semantics — while
adding hierarchy + default-deny, so the existing routes did not need editing.

API keys / dev principals authorize from their carried roles at their own
scope; session users carry no roles and have grants looked up from the store
(instant revocation, immediate role edits via `Authorizer.invalidate`).

## Consequences

- Same scoped RBAC path for humans (login/SSO) and machines (API keys); the
  whole `/api/*` surface is default-deny and scope-checked.
- Casbin satisfies the explicit requirement; the equivalent built-in engine
  preserves install-free tests and survives a missing/broken `casbin`.
- `user:manage` is checked against the *target* grant scope, structurally
  preventing privilege escalation by tenant admins.
- Stateless SSO state is in-process (10-min TTL); multi-replica SSO needs a
  shared state store (follow-up). Session tokens remain stateless: "logout" is
  client-side token discard.
- New schema in migration `005_rbac_identity`; the role catalog and a first
  admin are bootstrapped idempotently at startup.
