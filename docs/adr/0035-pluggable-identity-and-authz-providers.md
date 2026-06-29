# ADR 0035 — Pluggable identity and authorization providers

## Status

Accepted

## Context

Authentication/SSO and authorization were effectively hard-coded:

- **Identity/SSO**: `apps/api/src/app.ts` built SSO handlers with a literal
  `if (kind === "oidc") new OidcProvider(...) else new SamlProvider(...)`, and
  the SSO routes branched on `instanceof OidcProvider`. Adding a new IdP kind
  (LDAP, a corporate IAM, a custom OAuth) meant editing core code.
- **Authorization**: the decision engine was chosen inline in `server.ts`
  (`createCasbinEngine()` else `BuiltinPolicyEngine`). The `PolicyEngine`
  interface already existed as a clean seam, but there was no way to supply a
  custom engine from outside the repo.

Operators need to swap either subsystem for a custom implementation shipped
from an external repository, while the current behaviour stays as the default.

## Decision

Both subsystems become **provider SPIs loaded once at boot from an
env-named module** (a published package or a module path). The external repo
ships a package exporting a provider; RAGdoll `import()`s it at startup. No
runtime code fetching — these are vetted, security-critical singletons.

### Identity (`packages/auth/src/identity-provider.ts`)

- `SsoProviderInstance` — a uniform live handler (`start` → redirect URL,
  `callback` → `SsoIdentity`) so the routes never branch on protocol.
- `IdentityProvider` — declares the `identity_providers.kind` value(s) it
  serves and `build`s an `SsoProviderInstance` from a row's config.
- `IdentityProviderRegistry` — `kind → provider` lookup; later registrations
  win (so a custom module can override a built-in).
- Built-in `oidcIdentityProvider` + `samlIdentityProvider` wrap the existing
  `OidcProvider`/`SamlProvider` unchanged; `defaultIdentityProviderRegistry()`
  registers both.
- `loadIdentityProviderModule(registry, RAGDOLL_IDENTITY_PROVIDER)` imports a
  custom module whose default export is an `IdentityProvider`, an array, or a
  registrar `(registry) => void`. It can ADD a kind or OVERRIDE oidc/saml.
- `apps/api/src/app.ts`'s `buildSsoProvider` now delegates to the registry;
  the SSO routes call `provider.start()` / `provider.callback()` with no
  `instanceof`.

### Authorization (`packages/authz`)

- The existing `PolicyEngine` (`prepare(grants, catalog) → ScopedDecider`)
  stays THE seam — the ~129 `enforce()` call sites are untouched.
- A boot loader resolves the engine from `RAGDOLL_AUTHZ_PROVIDER` (a custom
  module exporting a `PolicyEngine`); unset → the existing Casbin-then-builtin
  resolution. The custom engine plugs into the same `Authorizer`.

### Boot wiring (`apps/api/src/server.ts`)

Both providers load right after the authorizer is constructed. **Fail-closed**:
a configured-but-unloadable provider crashes boot rather than silently falling
back to the built-ins (a silent fallback on a security component is worse than
a crash). Unset env → built-ins, unchanged.

## Consequences

- Current OIDC/SAML + Casbin/builtin behaviour is the default — zero change
  for existing installs.
- A custom identity or authz provider is a separate package + one env var; no
  fork, no core edit. Swapping is config, not a rebuild.
- The SSO routes are protocol-agnostic, so a custom IdP kind needs no route
  changes.
- Security-critical code is import-vetted at boot, not cloned/executed at
  runtime (the deliberate trade-off vs the git-sourced RAG-plugin model).
- Tests stay offline: the registry, the built-in adapters' validation, and the
  loader (with an injected importer) are unit-tested without network or a real
  IdP.
