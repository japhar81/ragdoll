# ADR 0017: API Keys Scoped Per Tenant + Per Environment

## Status

Accepted (extends ADR 0011 + ADR 0005).

## Context

Before this refactor, an API key carried a tenant id and an explicit
`roles[]` array — both immutable at issue time. There was no env
scope, no expiration, and "roles" was a static snapshot: if the
owning user later lost a role, the key kept it. This contradicted the
defense-in-depth story for the rest of the platform (sessions
re-resolve grants on every request) and made it hard to mint short-
lived per-environment credentials (the de facto pattern for CI / cron
deploys).

We also accumulated a UX foot-gun: the Profile → API keys mint form
filtered the role/scope dropdown by the user's *direct* grants, so a
platform_admin sees only one option (platform-wide). The form was
trying to enforce issuer-cap in the UI; the server already does that.

## Decision

Extend `api_keys` with two optional columns:

  environment_id text NULL        free-text env name; null = "every env"
  expires_at     timestamptz NULL absolute expiration; null = "never"

Mint accepts both. Verify rejects an expired key with the same
constant-time error shape as a revoked one (no observable distinction).
The synthesized RBAC grants for an env-scoped key live at scope
`t/<tenant>/e/<env>` instead of `t/<tenant>`, so the existing
`scopeCovers` machinery enforces env scoping uniformly with every
other layer.

`Principal` gains an optional `environment` field. The Authorizer's
`synthesizeGrants` consults it. Route handlers pass `environment`
into `enforce(...)` where the scope is env-narrowed (config /
secret-values endpoints under a tenant + env).

Mint UX is rebuilt to surface every scope the issuer COULD assign:

  - Role dropdown: every role in `/api/roles`. The server walks the
    role's permissions and `enforce(...)`s at the picked scope; a
    user who can't actually grant a role gets a 403 inline.
  - Tenant dropdown: every tenant the user has any covering grant for.
    Platform-wide grants surface a "platform (global)" option;
    per-tenant grants don't.
  - Env dropdown: appears once a tenant is picked, lists the tenant's
    environments. "(none — all envs)" is the default.
  - Expiration: preset (1h / 24h / 7d / 30d / 90d / never).

CLI: `ragdoll keys mint --env <name> --expires <duration|iso>` mirrors
the form; durations like `7d` / `12h` / `45m` are resolved
client-side into an ISO timestamp.

## Consequences

- Real env scoping. An env-scoped key on `prod` can't be re-used to
  read `dev` configs or vice versa — the scope siblings under a
  tenant don't cover each other.
- Real expiration. CI deploy keys can be scoped to 90 days; rotation
  is a normal lifecycle event, not a special case.
- The mint form matches the principle "anything you can assign, you
  can mint" — the user-visible enumeration is the issuer's authority,
  not a subset of their direct grants.
- Format unchanged. We keep `rgd_<6-hex-prefix>_<24-hex-secret>`;
  embedding scope in the key prefix was explicitly rejected (leaks
  org structure if a key ever shows up in a log / screenshot).
- Permission intersection at request time was deliberately deferred.
  Today's snapshot-at-mint behaviour for the `roles[]` column is
  unchanged — losing a role on the owner doesn't auto-revoke the
  key's role permissions. That's a larger change to the
  `synthesizeGrants` path and lands alongside dataset-aware
  permissions in a future round.

## Alternatives considered

1. **Encode scope in the key prefix** (`rgd_<tenant_slug>_<env_slug>_<random>`).
   Tempting because then the auth middleware doesn't need a DB lookup
   to know the scope. Rejected — leaks tenant + env names everywhere
   a key shows up (Slack copy-paste, screenshots, logs without
   redaction). Stripe / GitHub use opaque prefixes for the same
   reason.
2. **Per-key permission allow-list (`permissions: string[]` column).**
   A future addition; for v1 we keep the `roles[]` model because the
   role catalog is what operators already think in.
3. **Move expiration handling into a separate `api_key_lifetimes`
   table.** Over-engineered for what is one nullable column.
