# Access Control: Login, SSO, and RBAC

How to administer authentication and authorization. Architecture rationale is
in [ADR 0011](../adr/0011-auth-rbac-casbin.md); enforcement details in
[Governance and Security](./governance-and-security.md).

## First login

Auth is strict default-deny — there is no header bypass by default. Provision
the first platform admin via environment variables (read once, idempotently,
on API startup):

```
BOOTSTRAP_ADMIN_EMAIL=admin@your.org
BOOTSTRAP_ADMIN_PASSWORD=<strong password>
```

The local docker-compose sets `admin@ragdoll.local` / `ragdoll-admin` for
convenience — **change these outside local dev.** Sign in at the web app; the
nav only shows sections your grants permit (the server still enforces).

## The model in one paragraph

A user holds a **role** within a **scope**. Roles map to **permissions**
(editable). Scope is hierarchical and a grant at a broader scope covers
everything beneath it:

| Scope string | Meaning |
| --- | --- |
| `*` | global / platform-wide |
| `t/<tenantId>` | an entire tenant (its envs and pipelines) |
| `t/<tenantId>/e/<env>` | one environment of a tenant |
| `t/<tenantId>/p/<pipelineId>` | one pipeline of a tenant |

## Common tasks (Access section in the UI)

- **Users** — create local users (omit the password for SSO-only),
  enable/disable, delete, and open **Grants** to assign a role at a level
  (global / tenant / environment / pipeline). You can only grant within scopes
  your own grants cover, so a tenant admin cannot escalate to platform.
- **Roles & Permissions** — tick the permissions for each role, or add a
  custom role. Changes take effect immediately (no re-login).
- **Identity Providers** — add OIDC or SAML connections (below).
- **Auth Settings** — choose the signup mode.

Equivalent REST: `POST /api/auth/login`, `POST /api/auth/signup`,
`GET /api/auth/me`, `/api/users`, `/api/users/:id/grants`, `/api/roles`,
`/api/roles/:name/permissions`, `/api/identity-providers`,
`/api/auth/settings` (see `docs/api/openapi.yaml`).

## Signup modes

Set in **Auth Settings** (`auth_settings.signup_mode`):

| Mode | Local signup | SSO first login |
| --- | --- | --- |
| `admin_only` | disabled (403) | account auto-created, **no** access until granted |
| `open_default_role` | allowed; gets the configured default role at `*` | same default role |
| `open_no_access` | allowed; **no** permissions until granted | account created, no access |

## Configuring SSO

Add a provider in **Identity Providers**. Secrets are write-only (shown as
`REDACTED`; left untouched on edit unless you type a new value).

**OIDC** `config`: `issuer`, `clientId`, `clientSecret`, optional `scopes`
(default `openid email profile`). Discovery, JWKS, and `nonce`/`state` are
handled automatically. Register this redirect URI at the IdP:

```
<api-origin>/api/auth/sso/<slug>/callback
```

**SAML** `config`: `entryPoint`, `issuer` (SP entity id), `callbackUrl` (ACS),
`idpCert` (PEM body), optional `emailAttribute` / `nameAttribute`. Assertions
must be signed (enforced).

After the IdP authenticates, the callback issues a session token and redirects
the browser to `WEB_BASE_URL` with `#access_token=...`, which the SPA consumes
and clears from the address bar.

## Environment variables

| Var | Purpose |
| --- | --- |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | first platform admin (first boot only) |
| `WEB_BASE_URL` | where the SSO callback returns the browser (default `/`) |
| `RAGDOLL_DEV_AUTH=1` | re-enable the insecure `x-roles` dev provider (non-prod only) |
| `SESSION_SECRET` | HMAC key for session tokens (set a strong value) |

## Operational notes

- Sessions are stateless; "sign out" discards the client token. Disabling or
  deleting a user, or revoking a grant, takes effect on that user's next
  request (live grant resolution).
- SSO login state is in-process with a 10-minute TTL; for multiple API
  replicas, pin SSO logins to one replica or front them with sticky sessions
  until a shared state store lands.
- The dependency-free authz engine and the Casbin engine are conformance-
  tested to make identical decisions, so behaviour is the same whether or not
  `casbin` is installed.
