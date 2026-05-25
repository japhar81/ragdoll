# 01 — RBAC Enforcement Audit

Snapshot of where authorization is and isn't checked as of
`refactor/datasets-rbac-retrieval` branching off `ca776cf`. This is
read-only — Phase 2 fixes the gaps.

## Method

Every public-ish entry point was checked: every route handler in
`apps/api/src/app.ts`, the WebSocket handler in
`apps/api/src/websocket.ts`, every MCP tool in `apps/api/src/mcp.ts`,
every job handler in `apps/worker/src/handlers.ts`, the scheduler in
`apps/worker/src/scheduler.ts`, the DAG executor in
`packages/runtime/src/index.ts`, the CLI command files, and the
ChangeBus publish surface in `packages/events/src/index.ts`. For each:
what should be enforced (against what scope), what is enforced today,
and what the gap (if any) is.

## Headline counts

- **92** explicit `enforce(principal, perm, scope)` call sites in
  `apps/api/src/app.ts`.
- **0** enforce calls in `apps/worker/`.
- **0** enforce calls in `packages/runtime/`.
- **1** enforce call in `apps/api/src/websocket.ts` (Builder-room join
  for `pipeline:update`); the bus fan-out itself uses a coarser
  `canSee()` filter, NOT `enforce`.

## A. REST API — `apps/api/src/app.ts`

| Entry point                                         | Resource                                             | Required perm                | Enforced? | Notes                                                                |
| --------------------------------------------------- | ---------------------------------------------------- | ---------------------------- | --------- | -------------------------------------------------------------------- |
| `GET /healthz`, `GET /readyz`                       | none                                                 | none                         | n/a       | Public probes (ADR-aligned).                                         |
| `POST /api/auth/login` / `signup` / `logout`        | none / signup-mode                                   | signup-mode gate             | ✅ partial | `signup` checks `authSettings.signupMode`, not Casbin.               |
| `GET /api/auth/me`, `PATCH /api/auth/me`            | self                                                 | authenticated only           | ✅         | Implicit (auth-only); writes scope to `principal.id`.                |
| `GET /api/auth/providers`, SSO endpoints            | none                                                 | none                         | n/a       | Credential exchange / public discovery.                              |
| `GET /api/tenants`                                  | `*`                                                  | `audit:view`                 | ✅         | `app.ts:715`                                                         |
| `GET /api/tenants/:id`                              | `t/<id>`                                             | `audit:view`                 | ✅         | `app.ts:724`                                                         |
| `POST /api/tenants`                                 | `*`                                                  | `config:edit_global`         | ✅         | `app.ts:737`                                                         |
| `PUT /api/tenants/:id` / `DELETE /api/tenants/:id`  | `*`                                                  | `config:edit_global`         | ✅         | `app.ts:761`, `app.ts:925`                                           |
| `GET/PUT/DELETE /api/tenants/:id/storage`           | `t/<id>`                                             | `config:edit_tenant`         | ✅         | Git mirror config; only active when feature wired.                   |
| `*/api/tenants/:id/environments`                    | `*` (global write) / `t/<id>` (read)                 | `config:edit_global`, `audit:view` | ✅   | Environments are platform-managed.                                   |
| `GET/POST/PUT/DELETE /api/pipelines[…]`             | `t/<tid>`/`t/<tid>/p/<pid>`                          | `pipeline:*`                 | ✅         | Pipeline CRUD, folders, versioning — 7 + 4 + 5 sites.                |
| `POST /api/pipelines/:id/run` / `/ingest` / `/stream`/`/batch-run`/`/evaluate`/`/reindex` | `t/<tid>/p/<pid>` | `pipeline:run`               | ✅         | 6 execute paths; `app.ts:2334-2641`.                                 |
| `*/api/configs[…]` / `*/api/secrets[…]` / `secret-values[…]` | tenant- or global-scoped                    | `config:edit_*` / `secret:manage_tenant` | ✅ | 14 + 4 sites.                                                        |
| `*/api/users`, `/api/roles`, `/api/idps`            | depends on grant target scope                        | `user:manage`, `role:manage`, `idp:manage` | ✅ | `user:manage` is checked against the **target** grant scope at `app.ts:3275`. |
| `GET /api/audit`, `GET /api/usage`                  | tenant / global                                      | `audit:view`, `execution:view_logs` | ✅  | `app.ts:2242`, `app.ts:2253`.                                        |
| `POST /api/triggers/webhook/:token`                 | n/a                                                  | n/a (token-as-auth)          | ✅ design | ADR 0012: bearer-in-URL by design; revoke = mint anew.               |
| `POST /api/api-keys` / `GET /api/api-keys`          | self                                                 | authenticated                | ✅         | Owner-scoped; verified by `profile-apikeys.test.ts`.                 |

REST surface is comprehensive. Phase 2 standardizes the helper but
the *coverage* is in good shape.

## B. WebSocket — `apps/api/src/websocket.ts`

| Entry point                                | What it does                                       | Enforced?                           | Gap                                                                                  |
| ------------------------------------------ | -------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------ |
| `GET /api/events` (upgrade)                | Open socket; await `{type:"auth", token\|apiKey}`. | Auth-after-open, same `AuthResolver`. | None.                                                                                |
| First `{type:"auth"}` frame                | Authenticates the connection.                      | `AuthResolver.resolve()`.            | None.                                                                                |
| `{type:"builder:join", pipelineId}`        | Joins a collaborative-editor room.                 | `enforce(p, "pipeline:update", scope)` at `app.ts:271` equivalent. | None.                                                                                |
| Bus fan-out (every `ChangeEvent`)          | Decides which connections receive an event.        | `canSee(conn, event)` — tenant ID match only. | **Coarse**: a `viewer` on tenant T sees `secret.change`, `config.update`, `user.grants.added` for T even though their role lacks the corresponding perms. |
| Builder room edit/presence frames          | Broadcast to room members.                         | Room membership is permission-gated at join. | None.                                                                                |

**Phase 2 fix:** apply a per-event permission check at fan-out time.
The simplest correct model: tag each `ChangeEvent` with a
`requiredPermission?: Permission` at publish time; if set, the
subscriber must hold it at the event's scope to receive the event.
Untagged events stay tenant-coarse (back-compat for the bulk of
`pipeline.*` / `execution.*` events that all current viewers can
already see).

## C. MCP — `apps/api/src/mcp.ts`

| Entry point                       | What it does                                       | Enforced?                                 | Gap |
| --------------------------------- | -------------------------------------------------- | ----------------------------------------- | --- |
| `POST /mcp` (tool call)           | Parses auth headers; opens a fresh `Server` + `StreamableHTTPServerTransport`. | Same `AuthResolver` as REST.              | None. |
| Every tool body                   | Calls `app.handle({ method, path, headers, body })` in-process. | Transitively covered by REST `enforce`.   | None — but Phase 2 must verify each tool's `path` lands on an enforce-gated route (no debug/admin tool that bypasses). |

**Phase 2 work:** code-presence audit — enumerate every MCP tool's
`callApi(...)` target path and assert it appears in the REST enforce
table above. No new runtime code; one test that walks the MCP tools
list.

## D. CLI — `apps/cli/src/`

| Entry point     | What it does                       | Enforced?                                  | Gap |
| --------------- | ---------------------------------- | ------------------------------------------ | --- |
| Any subcommand  | HTTP client → REST API with Bearer / x-api-key. | Transitively covered by REST `enforce`.    | None. |

No new CLI code in Phase 2.

## E. Worker job handlers — `apps/worker/src/handlers.ts`

| Job type                            | Carried identity        | Enforce on dequeue?   | Gap                                                                          |
| ----------------------------------- | ----------------------- | --------------------- | ---------------------------------------------------------------------------- |
| `RunPipelineJob`                    | `tenantId, pipelineId`  | ❌ none                | **Critical gap**: job payload carries no actor/principal id, no captured grant snapshot, no signed payload. A worker that gets a tampered job (or one whose enqueueing principal has since lost the grant) will execute it. |
| `IngestDatasourceJob`               | `tenantId, pipelineId`  | ❌ none                | Same.                                                                        |
| `ReindexTenantJob`                  | `tenantId`              | ❌ none                | Same.                                                                        |
| `EvaluatePipelineJob`               | `tenantId, pipelineId`  | ❌ none                | Same.                                                                        |
| `BatchRunJob`                       | `tenantId, pipelineId`  | ❌ none                | Same.                                                                        |
| `DeleteTenantVectorDataJob`         | `tenantId`              | ❌ none                | Highest-privilege: blows away vector data. No re-check.                      |
| `RotateProviderModelMetadataJob`    | none                    | ❌ none                | Platform-scope; treats every worker run as authorized.                       |
| `PluginHealthCheckJob`              | none                    | ❌ none                | Read-only; lower risk but still no re-check.                                 |

**Phase 2 fix:** extend every job-payload type with
`enqueuedBy: { principalId, principalType, roles[], requestId }`,
populate at enqueue from `app.ts`'s `principal`, and on dequeue call
`authorizer.enforce(principal, perm, scope)` against the *current*
grants. On denial: persist a `denied` execution row, do not run, emit
an audit log.

Execution records also need `actorId` / `actorType` columns so the
UI can answer "who ran this?" — today
`PublishingExecutionStore.fire()` passes `actorId: null`
unconditionally (`handlers.ts:398`).

## F. Scheduler — `apps/worker/src/scheduler.ts`

| Entry point          | What it does                                 | Enforce at fire? | Gap                                                                          |
| -------------------- | -------------------------------------------- | ---------------- | ---------------------------------------------------------------------------- |
| Cron fire            | Enqueues a `RunPipelineJob` with `source: "schedule"`. | ❌ none           | The schedule was authorized **at create time**. If the creator loses `pipeline:run` later, their schedules keep firing. |

**Phase 2 fix:** schedule rows already carry the creator's
`principalId` (verify); the scheduler re-resolves their grants at
fire time and refuses to enqueue if `pipeline:run` is not currently
held. On refusal: mark the schedule `paused_no_grant`, emit an audit
log, surface in the UI.

## G. DAG executor — `packages/runtime/src/index.ts`

| Layer                                  | What it does                                  | Enforce?       | Gap                                                                          |
| -------------------------------------- | --------------------------------------------- | -------------- | ---------------------------------------------------------------------------- |
| `DagExecutor.execute(context, spec)`   | Walks the DAG, invokes plugins.               | ❌ none         | Trusts the `RuntimeContext` fully. A compromised worker can execute any spec against any tenant.|
| Per-node plugin invocation             | Loads plugin, passes config/secrets/inputs.   | ❌ none         | When Datasets land (Phase 4+), each node references resources (datasets, secrets) and the executor must check the running principal's access to each. **Out of scope for Phase 2** — first the principal has to reach the executor. |

**Phase 2 fix (limited):** thread an authorizer + the run's
captured principal through `WorkerDeps` so the executor can call
`enforce(principal, "pipeline:run", scope)` once at entry as a
defense-in-depth check. The full per-plugin-resource check waits for
Datasets.

## H. ChangeBus — `packages/events/src/index.ts`

| Entry point             | What it does                                    | Filtered by perm? | Gap                                                                          |
| ----------------------- | ----------------------------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| `ChangeBus.publish()`   | Emits an event to all in-process subscribers + optional Redis. | No (publisher side has no notion of subscriber perms). | Filtering belongs at fan-out (the WS handler) — see B above.                 |
| Subscribers             | `(event) => ...`                                 | No                | n/a; one subscription per consumer.                                          |

## Open questions parked

Items I could not resolve from reading alone; tracked here so a
reviewer can push back rather than discovering them in the code:

1. **Job payload integrity.** The plan calls for signed job payloads
   so a tampered `RunPipelineJob` is rejected. Worth doing? Threat
   model: worker shares the DB pool with the API, so a compromise
   that lets an attacker write to `bullmq` keys probably also lets
   them write to `executions`. Provisional answer: **defer** — re-checking
   grants at dequeue is the real defense; signing on top is overkill
   for this trust model.
2. **Scheduler "soft pause" on missing grant.** Phase 2 marks
   `paused_no_grant`; do we want an admin notification? Provisional
   answer: emit an audit log + a `schedule.paused_no_grant`
   ChangeEvent that the UI can surface in the schedule list.
3. **Executor entry-check failure mode.** A defense-in-depth
   `enforce` at executor entry that fails should mark the execution
   `denied` (not `failed`) so it doesn't trip retry semantics.
   Provisional answer: yes.

## Phase 2 plan (preview)

1. `packages/auth/src/index.ts` — add `requirePermission` /
   `assertPermission` helpers + a stable `PermissionDeniedError`
   shape (carries `subject, resource, action, traceId`). Reuse the
   existing `enforce` sync closure underneath.
2. `apps/worker/src/handlers.ts` — extend every job payload with
   `enqueuedBy`; populate at every enqueue point in `app.ts`; on
   dequeue, call `requirePermission` against current grants; persist
   `denied` execution rows.
3. `apps/worker/src/scheduler.ts` — at fire time, re-resolve the
   schedule creator's grants, refuse + pause if missing.
4. `packages/runtime/src/index.ts` — accept an optional
   `principalAuthorize` on `RuntimeContext` and call it at executor
   entry; otherwise behave as today (so unit tests don't all break).
5. `apps/api/src/websocket.ts` — extend `canSee()` with an optional
   per-event permission check; events that opt in to a required
   permission are filtered at fan-out.
6. `packages/events/src/index.ts` — extend `ChangeEvent` with
   optional `requiredPermission?: Permission`; emit it on the
   sensitive event types (`secret.*`, `config.*`, `user.*`,
   `role.*`, `idp.*`).
7. `apps/api/src/mcp.ts` — code-presence audit test only (no
   runtime change).
8. Refresh tests — `tests/security/rbac-audit.test.ts` flips from
   red to green.
