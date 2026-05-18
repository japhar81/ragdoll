# Governance and Security

## Authentication

`@ragdoll/auth` `AuthResolver` resolves a principal with fixed precedence:

1. `Authorization: Bearer <token>` -> `SessionTokenService` (HMAC-SHA256,
   `typ: "RGD"`, `iat`/`exp`, constant-time verify, `SESSION_SECRET`).
2. `Authorization: ApiKey <key>` or `x-api-key: <key>` -> `ApiKeyService`
   (`rgd_<prefix>_<secret>`; only a sha256 hash plus prefix are stored;
   constant-time compare; revocable).
3. `DevAuthProvider` — trusts `x-actor-id` / `x-tenant-id` / `x-roles`
   verbatim. Insecure; the API rejects its `dev-user` fallback when
   `RAGDOLL_ENV=production`.

Postgres-backed key and session storage is created by migration `002_auth`
(`api_keys`, `sessions`).

## RBAC roles and permissions

`enforce()` bridges the principal into `@ragdoll/authz` `requirePermission`,
merging the principal tenant into the resource so cross-tenant access is denied
unless the principal is `platform_admin`.

| Role | Permissions |
| --- | --- |
| `platform_admin` | all permissions; bypasses the tenant check |
| `environment_admin` | `pipeline:deploy`, `config:edit_pipeline`, `execution:view_logs`, `audit:view`, `pipeline:run` |
| `pipeline_admin` | `pipeline:create`, `pipeline:update`, `pipeline:delete`, `pipeline:deploy`, `config:edit_pipeline`, `execution:view_logs`, `pipeline:run` |
| `pipeline_editor` | `pipeline:create`, `pipeline:update`, `config:edit_pipeline`, `pipeline:run` |
| `tenant_admin` | `config:edit_tenant`, `secret:manage_tenant`, `execution:view_logs`, `pipeline:run` |
| `tenant_operator` | `execution:view_logs`, `pipeline:run` |
| `viewer` | `execution:view_logs` |
| `auditor` | `audit:view`, `execution:view_logs` |

Source of truth: `ROLE_PERMISSIONS` in `packages/authz/src/index.ts`.

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
create/update/delete, version save-draft/publish/archive, deployment, config
definition/value upsert/delete, secret create/rotate/delete, pipeline
run/ingest. Every audit record stores `actorId`, `tenantId`, `requestId`,
source IP, and user agent.

Before/after diffs are passed through `redactValue` before persistence, and
secret values are written as `REDACTED`. The secrets API never returns a
plaintext value at any endpoint (list/create/rotate all return `REDACTED`).
