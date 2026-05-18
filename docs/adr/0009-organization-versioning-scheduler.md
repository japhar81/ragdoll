# ADR 0009: Pipeline Organization, Concurrent Per-Tenant Versioning, and a Cron Scheduler

## Status

Accepted

## Context

Pipelines were a flat list with a single per-environment (optionally
tenant-scoped) `pipeline_deployments` pin. Three gaps remained:

1. No way to organize a growing pipeline catalog.
2. No first-class history: "Save" overwrote, and a tenant could only ever
   run one bound version per environment, so canary/stable rollouts and
   safe rollback were impossible.
3. Runs could only be triggered by the API or events — there was no
   time-based trigger.

This change is additive: existing tables, migrations, seeds, and
`pipeline_deployments` are untouched (migration
`003_org_and_scheduler.sql`), so the legacy resolution path and the
local-demo e2e stay byte-for-byte unchanged.

## Decision

**Pipeline organization.** A nested `pipeline_folders` tree
(`parent_id` self-reference, `UNIQUE (parent_id, name)`, `ON DELETE
RESTRICT` so a non-empty folder cannot be deleted from under its
children). `pipelines.folder_id` references a folder (`ON DELETE SET
NULL`, nullable = root). `GET /api/folders` returns the forest as
`PipelineFolderTreeNode`s; deleting a folder with child folders or
pipelines is `409`.

**Versioning model.** Published versions remain immutable (ADR-0001
content checksums; republishing identical content is idempotent,
divergent content on an existing version is `409 immutable_version`).
`POST /api/pipelines/:id/save` is the auto-versioned path: if the spec's
checksum equals the current latest version's, the save is idempotent and
returns it unchanged; otherwise a new published version is created. Its
number is the **global max** version across all of the pipeline's
versions bumped by `level` (default `patch`) — bumping from the global
max, not from the latest pointer, keeps version numbers monotonic and
collision-free even after a rollback. `parent_version_id` records
lineage to the version the save was based on. "Latest" is an explicit
pointer (`pipelines.latest_version_id`), not "highest number". Rollback
(`POST /api/pipelines/:id/rollback`) is a **pointer move only**: it
validates the target version exists and repoints `latest_version_id`;
it creates no new version row and mutates nothing (unknown id => `404`).

*Rationale / trade-off — pointer rollback vs "restore as new".* A
"restore as new version" model (copy the rolled-back spec into a fresh
top version) makes the linear version history self-describing but
doubles version rows on every rollback and muddies lineage. The product
decision is the pointer move: rollback is instant, allocates nothing,
and is trivially reversible (roll forward = move the pointer again). The
honest cost is that the latest pointer no longer implies "highest
version number", so tooling must read the explicit pointer. If you then
edit and `save` from a rolled-back pointer, the new version branches via
`parent_version_id` from that older version while its number is still
the global-max bump — lineage forks, numbers stay globally monotonic.

**Concurrent per-tenant versions.** `pipeline_activations` holds 1..N
labeled bindings per `(tenant, pipeline, environment)` (`UNIQUE
(tenant_id, pipeline_id, environment, label)`). Each binding is either
pinned to a `pipeline_version_id` or follows the pipeline's
`latest_version_id` when `track_latest = true`, and each is
independently `enabled` — so a tenant can run `stable` (pinned) and
`canary` (track-latest) in parallel in the same environment. Activation
resolution precedence: an explicit label (must exist and be enabled) >
the `default` label (if enabled) > the sole enabled activation >
`ActivationResolutionError` (`409 activation_unresolved`: ambiguous,
disabled, or missing). The effective version is then
`effectiveVersionId(activation, pipeline.latestVersionId)`
(track-latest follows the pointer; pinned uses its own version).
Run/deploy resolution precedence overall: an API-pinned
`pipelineVersionId` wins; else if the tenant has any activation for the
key, resolve via activations; else the legacy `pipeline_deployments`
path is the back-compat fallback (`409 no_active_deployment` when none).

**Config/Secrets navigation.** No new storage. `GET /api/config/values`
takes `scope` + `scope_id`/`scopeId` filters so the UI can render the
existing scoped config values and scoped secrets as a global → tenant →
pipeline tree. This is navigation over existing data only; secret values
are never exposed (list/create/rotate always return `REDACTED`, per ADR
0003 / governance doc).

**Scheduler.** A dependency-free 5-field Vixie/POSIX cron evaluator
(`@ragdoll/cron`: lists, ranges, steps, month/day names, Vixie dom/dow
OR semantics) drives a worker-side scheduler (`apps/worker/src/scheduler.ts`).
Each `tick()` scans due `schedules`, enqueues a `run_pipeline` job with
**no `pipelineVersionId`** and `source: "schedule"` (so the worker
resolves the effective version through the activation table at run time,
identically to API runs), then advances `next_run_at` via `markRun`. A
malformed stored cron skips just that schedule, not the tick.
**Evaluation is UTC only**: `matches`/`nextAfter` use `getUTC*`. The
`timezone` column is stored for display; it does not shift evaluation.
Scheduling is purely additive to the API and event triggers.
**Single active scheduler instance is assumed**: `listDue` + `markRun`
are not transactionally fenced, so two scheduler processes against the
same table would double-enqueue in the window before `markRun` lands.
The worker starts exactly one. Evolving to multi-worker requires leader
election (a Postgres advisory lock or a leased "scheduler" row) and
only `start()`ing the scheduler on the leader; the queue/repository
contracts do not change.

## Consequences

- Pipelines are organizable; folder deletes are safe (RESTRICT / `409`).
- Full immutable version history with lineage; canary + stable run
  concurrently per tenant via independently-enabled activations.
- Rollback is instant and allocation-free, but "latest" is an explicit
  pointer — never infer it from the highest version number. Editing from
  a rolled-back pointer forks lineage while numbers stay globally
  monotonic.
- Scheduling is **UTC-only**; a stored `timezone` is display metadata,
  not an evaluation offset. DST-correct local-time schedules are a
  future change to the evaluator.
- The scheduler is **single-instance**; running more than one without
  leader election double-enqueues. The documented evolution is advisory
  lock / leased row.
- Scheduled runs carry `source: "schedule"` and run with the worker
  process's identity (no end-user principal); they resolve versions via
  the same activation precedence as API runs.
- Fully additive: `pipeline_deployments` and the legacy resolution path
  are intact as the fallback when a tenant/pipeline has no activations.
- Config/secret navigation reuses scoped values and the redaction
  guarantees; no secret material is exposed by the tree.
