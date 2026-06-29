# Custom identity & authorization providers

RAGdoll's authentication/SSO and authorization are pluggable: ship a custom
implementation from a **separate repository**, point one env var at it, and
RAGdoll loads it at boot. The built-in behaviour (OIDC/SAML + Casbin/builtin
RBAC) is the default when the env var is unset. See [ADR 0035](../adr/0035-pluggable-identity-and-authz-providers.md).

Loading is **module import at boot** — your provider is a published package
(or a module path mounted into the image), imported once at startup. It is
never cloned or fetched at runtime. Both loaders are **fail-closed**: a
configured-but-unloadable provider crashes boot rather than silently using a
different engine.

---

## Custom identity provider (`RAGDOLL_IDENTITY_PROVIDER`)

Implement the `IdentityProvider` SPI from `@ragdoll/auth`. A provider declares
which `identity_providers.kind` value(s) it serves and builds a uniform
`SsoProviderInstance` (`start` → IdP redirect URL, `callback` → `SsoIdentity`).

```ts
// my-ldap-identity/src/index.ts
import type {
  IdentityProvider,
  SsoProviderInstance
} from "@ragdoll/auth";

const ldap: IdentityProvider = {
  kinds: ["ldap"], // a NEW kind — or ["oidc"] to OVERRIDE the built-in
  build({ config }): SsoProviderInstance {
    return {
      async start({ redirectUri, state, nonce }) {
        return buildLdapRedirect(config, redirectUri, state);
      },
      async callback({ code, redirectUri, expectedNonce, samlResponse }) {
        const profile = await verifyWithIdp(config, code);
        // Map the external identity onto RAGdoll's shape. RAGdoll handles
        // user linking + session issuance from here (consistent across IdPs).
        return { subject: profile.id, email: profile.mail, name: profile.cn };
      }
    };
  }
};

// Default-export an IdentityProvider, an IdentityProvider[], or a registrar
// function (registry) => void for full control.
export default ldap;
```

Point RAGdoll at it:

```bash
RAGDOLL_IDENTITY_PROVIDER=@acme/ragdoll-ldap-identity   # package name
# or a mounted path:
RAGDOLL_IDENTITY_PROVIDER=/opt/providers/ldap-identity.js
```

An admin then creates an `identity_providers` row with `kind: "ldap"` (via the
Identity Providers screen / API) and the `config` your provider reads. The SSO
routes (`/api/auth/sso/:slug/start` + `/callback`) work unchanged — they never
branch on protocol.

**Override a built-in:** register a provider whose `kinds` includes `"oidc"` or
`"saml"`; the last registration for a kind wins.

---

## Custom authorization provider (`RAGDOLL_AUTHZ_PROVIDER`)

Implement the `PolicyEngine` interface from `@ragdoll/authz`. The engine
compiles a principal's grants + the role→permission catalog into a synchronous
decider (kept off the hot path of the ~129 `enforce()` call sites). RAGdoll's
scope hierarchy (`*` ⊃ `t/<tenant>` ⊃ `t/<tenant>/e/<env>` | `/p/<pipeline>`)
is passed through as the `requestScope` string.

```ts
// my-opa-authz/src/index.ts
import type {
  PolicyEngine,
  ScopedDecider,
  Grant,
  RoleCatalog
} from "@ragdoll/authz";

const engine: PolicyEngine = {
  async prepare(grants: Grant[], catalog: RoleCatalog): Promise<ScopedDecider> {
    // Build whatever you need here (load OPA policy, compile rules, …) —
    // this is async + off the request hot path.
    return (permission: string, requestScope: string): boolean => {
      return evaluateAgainstOpa(grants, catalog, permission, requestScope);
    };
  }
};

// Default-export a PolicyEngine, or a (sync/async) factory returning one.
export default engine;
```

Point RAGdoll at it:

```bash
RAGDOLL_AUTHZ_PROVIDER=@acme/ragdoll-opa-authz
```

When set, your engine replaces the Casbin/builtin resolution entirely; the
`enforce(principal, permission, resource)` contract and every call site are
unchanged. When unset, RAGdoll uses Casbin (or the dependency-free builtin).

---

## Packaging & deployment

- Publish the provider as a package, or bake the built module into the API
  image and reference it by absolute path.
- Helm: set the env var on the api/worker Secret or via
  `--set extraEnv` (whatever your values wiring uses); compose: add it to the
  `api` (and `worker` if it authorizes there) service `environment`.
- Keep the dependency surface small — these load in the API process at boot.
- Test your provider in isolation: both SPIs accept an injected importer /
  plain objects, so unit tests need no network or running RAGdoll.
