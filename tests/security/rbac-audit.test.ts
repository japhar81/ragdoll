/**
 * RBAC enforcement audit — failing baseline.
 *
 * Each test here asserts a single specific gap identified in
 * `docs/refactor/01-rbac-audit.md`. They are written to FAIL against
 * `main@ca776cf` (the baseline this branch forked from) and to PASS
 * once Phase 2 lands. They are intentionally narrow: each test fixes
 * the smallest possible code-shape claim ("this field exists",
 * "this regex appears in this source file") so a single fix flips a
 * single test, making bisecting Phase 2 progress trivial.
 *
 * Why a mix of functional and source-shape assertions? The gaps span
 * code paths that don't all have an easy functional probe — e.g. a
 * `DagExecutor.execute()` that doesn't enforce can only be observed
 * by absence (nothing happens that should). The source-shape tests
 * make absence directly observable.
 *
 * When Phase 2 lands, every test here should pass without any test
 * having to be deleted or weakened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

async function read(rel: string): Promise<string> {
  return readFile(path.resolve(repoRoot, rel), "utf8");
}

/* -------------------------------------------------------------------------- */
/*  Group A — Worker job payloads must carry an `enqueuedBy` principal       */
/* -------------------------------------------------------------------------- */

test("RunPipelineJob payload carries an enqueuedBy principal", async () => {
  const src = await read("apps/worker/src/handlers.ts");
  // The Phase 2 fix adds `enqueuedBy?: EnqueuedBy` to every job payload
  // interface so the worker can re-enforce on dequeue. The grep is loose
  // on purpose — any of `enqueuedBy:` / `enqueuedBy?:` matches.
  assert.match(
    src,
    /interface RunPipelineJob[\s\S]{0,1500}enqueuedBy/,
    "RunPipelineJob is missing the enqueuedBy field — Phase 2 must add it so the worker can re-check the original principal's grants at dequeue time."
  );
});

test("IngestDatasourceJob payload carries an enqueuedBy principal", async () => {
  const src = await read("apps/worker/src/handlers.ts");
  assert.match(
    src,
    /interface IngestDatasourceJob[\s\S]{0,1200}enqueuedBy/,
    "IngestDatasourceJob is missing the enqueuedBy field."
  );
});

test("EvaluatePipelineJob payload carries an enqueuedBy principal", async () => {
  const src = await read("apps/worker/src/handlers.ts");
  assert.match(
    src,
    /interface EvaluatePipelineJob[\s\S]{0,1200}enqueuedBy/,
    "EvaluatePipelineJob is missing the enqueuedBy field."
  );
});

test("BatchRunJob payload carries an enqueuedBy principal", async () => {
  const src = await read("apps/worker/src/handlers.ts");
  assert.match(
    src,
    /interface BatchRunJob[\s\S]{0,1200}enqueuedBy/,
    "BatchRunJob is missing the enqueuedBy field."
  );
});

test("DeleteTenantVectorDataJob payload carries an enqueuedBy principal", async () => {
  const src = await read("apps/worker/src/handlers.ts");
  assert.match(
    src,
    /interface DeleteTenantVectorDataJob[\s\S]{0,800}enqueuedBy/,
    "DeleteTenantVectorDataJob is missing the enqueuedBy field — this is the highest-privilege job and absolutely must re-check on dequeue."
  );
});

/* -------------------------------------------------------------------------- */
/*  Group B — Worker re-enforces on dequeue                                  */
/* -------------------------------------------------------------------------- */

test("worker handlers call a requirePermission / authorizer helper on dequeue", async () => {
  const src = await read("apps/worker/src/handlers.ts");
  // Phase 2 introduces `requirePermission` (or `authorizer.enforce` /
  // `principal.authorize`) into the worker path. Today: zero references.
  assert.match(
    src,
    /requirePermission|authorizer\.enforce|principal\.authorize/,
    "apps/worker/src/handlers.ts contains no permission check on dequeue. Phase 2 must wire one in so a job whose enqueuer has since lost the grant cannot run."
  );
});

test("worker exports a PermissionDeniedError or comparable denial outcome", async () => {
  const src = await read("apps/worker/src/handlers.ts");
  assert.match(
    src,
    /PermissionDeniedError|"denied"|status:\s*"denied"/,
    "Worker has no notion of a 'denied' outcome — a permission-denied dequeue should mark the execution status as 'denied' (not 'failed' so retries don't fire)."
  );
});

/* -------------------------------------------------------------------------- */
/*  Group C — Scheduler re-checks grants at fire time                        */
/* -------------------------------------------------------------------------- */

test("scheduler re-checks the schedule creator's grants at fire time", async () => {
  const src = await read("apps/worker/src/scheduler.ts");
  // Phase 2 adds the re-check so a creator who lost pipeline:run can't
  // keep firing pipelines through schedules they made earlier.
  assert.match(
    src,
    /requirePermission|authorizer\.enforce|principal\.authorize|paused_no_grant/,
    "Scheduler currently fires every enabled schedule without re-checking the creator's grants. Phase 2 must re-resolve grants at fire time and pause the schedule on missing grant."
  );
});

/* -------------------------------------------------------------------------- */
/*  Group D — DAG executor performs a defense-in-depth entry check           */
/* -------------------------------------------------------------------------- */

test("DagExecutor entry path invokes a principal-authorize closure", async () => {
  const src = await read("packages/runtime/src/index.ts");
  // The full per-plugin resource check waits for Datasets (Phase 4+).
  // Phase 2 just adds an entry-level check so a tampered job that
  // somehow reaches the executor still gets rejected.
  assert.match(
    src,
    /principalAuthorize|requirePermission|authorize\(/,
    "packages/runtime/src/index.ts performs no authorization. Phase 2 must add an optional principal-authorize hook on RuntimeContext and call it at executor entry."
  );
});

/* -------------------------------------------------------------------------- */
/*  Group E — ChangeEvent supports per-event permission filtering            */
/* -------------------------------------------------------------------------- */

test("ChangeEvent declares an optional requiredPermission field", async () => {
  const src = await read("packages/events/src/index.ts");
  assert.match(
    src,
    /interface ChangeEvent[\s\S]{0,800}requiredPermission/,
    "ChangeEvent has no requiredPermission field. Phase 2 must add one so sensitive events (secret.*, config.*, user.*, role.*) can be filtered at WebSocket fan-out instead of broadcast to every viewer in the tenant."
  );
});

test("WebSocket canSee filter consults requiredPermission when present", async () => {
  const src = await read("apps/api/src/websocket.ts");
  // The Phase 2 fan-out filter is tightened to read requiredPermission
  // off each event and call principal.authorize before forwarding.
  assert.match(
    src,
    /requiredPermission/,
    "apps/api/src/websocket.ts does not consult event.requiredPermission. Phase 2 must extend canSee() so events tagged with a required permission are dropped for connections lacking it."
  );
});

/* -------------------------------------------------------------------------- */
/*  Group F — Sensitive event publishers tag the events                      */
/* -------------------------------------------------------------------------- */

test("secret value mutations publish events tagged with secret:manage_tenant", async () => {
  const src = await read("apps/api/src/app.ts");
  // After Phase 2 the secret-value routes publish events with
  // requiredPermission: "secret:manage_tenant". The grep is intentionally
  // loose — any occurrence in the file means the publishers got tagged.
  assert.match(
    src,
    /requiredPermission:\s*"secret:manage_tenant"/,
    "Secret-value mutations broadcast as plain tenant-scoped events; any tenant viewer can subscribe and learn that a secret rotated. Phase 2 must tag these events with requiredPermission: 'secret:manage_tenant'."
  );
});

test("user grant changes publish events tagged with user:manage", async () => {
  const src = await read("apps/api/src/app.ts");
  assert.match(
    src,
    /requiredPermission:\s*"user:manage"/,
    "User grant additions/removals broadcast as plain tenant events. Phase 2 must tag these with requiredPermission: 'user:manage'."
  );
});

/* -------------------------------------------------------------------------- */
/*  Group G — Execution records capture the actor                            */
/* -------------------------------------------------------------------------- */

test("PublishingExecutionStore does not hardcode actorId: null", async () => {
  const src = await read("apps/worker/src/handlers.ts");
  // Today: literal `actorId: null` in the execution event publisher.
  // Phase 2 reads the actor off the run context instead.
  const hardcoded = /actorId:\s*null/.test(src);
  assert.equal(
    hardcoded,
    false,
    "apps/worker/src/handlers.ts hardcodes `actorId: null` when publishing execution events. Phase 2 must thread the run's actorId through so 'who ran this?' is answerable from the audit/execution trail."
  );
});

/* -------------------------------------------------------------------------- */
/*  Group H — Unified permission helper exists                               */
/* -------------------------------------------------------------------------- */

test("packages/auth exports a requirePermission helper", async () => {
  const src = await read("packages/auth/src/index.ts");
  assert.match(
    src,
    /export (async )?function requirePermission|export const requirePermission/,
    "packages/auth/src/index.ts does not export a requirePermission helper. Phase 2 introduces one so REST handlers, worker handlers, the scheduler, and the executor all share a single denial code path with a stable PermissionDeniedError shape."
  );
});

test("packages/auth exports a stable PermissionDeniedError", async () => {
  const src = await read("packages/auth/src/index.ts");
  assert.match(
    src,
    /export class PermissionDeniedError/,
    "packages/auth/src/index.ts does not export a PermissionDeniedError class. Phase 2 introduces one with a stable shape (subject, resource, action, traceId) so callers can map denial to a consistent error response."
  );
});
