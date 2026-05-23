# Governance and Security

## Authentication

`@ragdoll/auth` `AuthResolver` resolves a principal with fixed precedence:

1. `Authorization: Bearer <token>` -> `SessionTokenService` (HMAC-SHA256,
   `typ: "RGD"`, `iat`/`exp`, constant-time verify, `SESSION_SECRET`). Issued
   by **local password login**, **self-service signup**, or **SSO**
   (OIDC/SAML). The token only identifies the user; grants are resolved live
   so revocations and role edits take effect without re-login.
2. `Authorization: ApiKey <key>` or `x-api-key: <key>` -> `ApiKeyService`
   (`rgd_<prefix>_<secret>`; only a sha256 hash plus prefix are stored;
   constant-time compare; revocable).
3. `DevAuthProvider` — trusts `x-actor-id` / `x-tenant-id` / `x-roles`
   verbatim. **Off by default** (strict default-deny): honoured only when
   `RAGDOLL_DEV_AUTH=1` AND `RAGDOLL_ENV` is not `production`.

Local credentials use `node:crypto` scrypt (`PasswordService`). Federated
identities map an external IdP subject to a local user (`user_identities`).
SSO connections are configured at runtime (`identity_providers`, managed in
the **Access ▸ Identity Providers** UI / `/api/identity-providers`). Storage:
migration `002_auth` (`api_keys`, `sessions`) and `005_rbac_identity`
(`users.password_hash/status`, `user_identities`, `identity_providers`,
`rbac_role_permissions`, `rbac_grants`, `auth_settings`).

Self-service signup is gated by an instance flag (`auth_settings.signup_mode`,
**Access ▸ Auth Settings**): `admin_only` (no public signup; SSO users are
auto-provisioned with **no** access until granted), `open_default_role`
(register + receive a configured default role at global scope), or
`open_no_access` (register, zero permissions until granted).

The first platform admin is provisioned from `BOOTSTRAP_ADMIN_EMAIL` /
`BOOTSTRAP_ADMIN_PASSWORD` on first boot (idempotent).

## RBAC: roles, permissions, and scopes

Authorization is a **Casbin** policy with hierarchical scopes. `@ragdoll/authz`
ships two decision-equivalent engines: a dependency-free reference engine
(used by the install-free test runner and as the production fallback) and a
real Casbin engine (`packages/authz/src/casbin.ts`, used by the server). A
conformance test pins them to identical decisions.

A grant is **a user holds a role within a scope**. Scopes are hierarchical and
a grant at an ancestor scope covers every descendant:

```
*                      global / platform-wide
t/<tenantId>           a whole tenant   (covers its envs + pipelines)
t/<tenantId>/e/<env>   one environment of a tenant
t/<tenantId>/p/<pid>   one pipeline of a tenant
```

So `tenant_admin @ t/T` authorizes tenant-T pipeline actions, while
`environment_admin @ t/T/e/prod` does **not** authorize tenant-wide ones.
Default-deny: with no covering grant the request is denied. The role ->
permission catalog is editable at runtime (**Access ▸ Roles & Permissions** /
`/api/roles`); built-in defaults seed a fresh install:

| Role | Permissions |
| --- | --- |
| `platform_admin` | all permissions (incl. `user:manage`, `role:manage`, `idp:manage`, `auth:settings`) |
| `environment_admin` | `pipeline:deploy`, `config:edit_pipeline`, `execution:view_logs`, `audit:view`, `pipeline:run` |
| `pipeline_admin` | `pipeline:create/update/delete/deploy`, `config:edit_pipeline`, `execution:view_logs`, `pipeline:run` |
| `pipeline_editor` | `pipeline:create`, `pipeline:update`, `config:edit_pipeline`, `pipeline:run` |
| `tenant_admin` | `config:edit_tenant`, `secret:manage_tenant`, `execution:view_logs`, `pipeline:run`, `user:manage` (scoped) |
| `tenant_operator` | `execution:view_logs`, `pipeline:run` |
| `viewer` | `execution:view_logs` |
| `auditor` | `audit:view`, `execution:view_logs` |

`user:manage` is scope-checked against the **target grant's scope**, so a
tenant admin can administer users within their tenant but cannot mint
platform-wide or other-tenant grants (no privilege escalation). Source of
truth: `DEFAULT_ROLE_PERMISSIONS` in `packages/authz/src/index.ts` (overridden
by `rbac_role_permissions` once populated). See ADR 0011.

## Tenant isolation points

A non-`platform_admin` principal cannot cross tenants. Isolation is enforced
in:

- API authorization (`enforce` merges principal tenant into the resource).
- Tenant/execution/audit/usage list endpoints (filtered by principal tenant).
- Config resolution (scoped values; locked keys cannot be overridden by
  lower-trust scopes).
- Secret resolution (`SecretAccessDeniedError` across tenants).
- Vector storage (collection name plus mandatory `tenantId` payload filter on
  every query and delete).
- Provider credential selection (tenant-scoped secret refs).

## Audit events

Audited actions include tenant create/update/delete, pipeline
create/update/delete, version save-draft/save/publish/rollback/archive,
deployment, pipeline-activation create/update/delete, schedule
create/update/toggle/delete, config definition/value upsert/delete, secret
create/rotate/delete, pipeline run/ingest. Every audit record stores
`actorId`, `tenantId`, `requestId`, source IP, and user agent.

`pipeline_activations` is the per-tenant version-binding control surface
(which version a tenant runs in an environment; ADR 0009). It carries no
secret material; activation create/update/delete plus version
save/rollback and schedule changes are all audited with before/after
diffs, so a tenant's effective-version changes are fully attributable.

The scheduler is not a user-facing API: it runs inside the worker and
enqueues `run_pipeline` jobs with `source: "schedule"` under the worker
process's identity (no end-user principal). Scheduled runs resolve their
version through the same activation precedence as API runs, so the same
tenant-isolation and version-binding controls apply.

Before/after diffs are passed through `redactValue` before persistence, and
secret values are written as `REDACTED`. The secrets API never returns a
plaintext value at any endpoint (list/create/rotate all return `REDACTED`).

## Live events (`/api/events`)

Every audited mutation is ALSO published to a `ChangeBus` (see ADR 0015)
so the UI can update in real time without polling. The worker publishes
`execution.*` lifecycle events on the same bus.

A WebSocket endpoint at `/api/events` fans events out to authenticated
clients. Auth is the same as the REST surface — the first frame after open
is `{type:"auth", token|apiKey}` and the connection runs through
`AuthResolver` like every other route. A 10 s grace window closes idle
unauthenticated sockets.

Each connection's *scope reach* is computed once at auth time from the
principal's grants: a global-scope grant lets the connection see every
event; a tenant grant restricts it to that tenant. Platform-level events
(`tenantId: null`) reach only global-scope principals. Builder rooms (one
channel per pipeline) are gated by `pipeline:update` at the pipeline scope
so a viewer cannot see another tenant's draft.

Transport: in-process when `REDIS_URL` is unset (tests, single-replica
local); Redis pub/sub on channel `ragdoll:changes` otherwise — required
for multi-replica fan-out and for the worker→API channel. Bus failures
log but never block a mutation; the audit log remains authoritative.
