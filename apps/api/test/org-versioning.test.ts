/**
 * Wave-B functional tests: pipeline folders, auto-versioned save / rollback,
 * tenant<->pipeline associations + concurrent activations, run resolution
 * precedence (activation vs deployment back-compat), and schedule cron
 * validation. Framework-agnostic, InMemory, offline / install-free.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness, echoSpec } from "./helpers.ts";

const ADMIN = { "x-actor-id": "admin", "x-roles": "platform_admin" };

/* -------------------------------------------------------------------------- */
/* Folder tree CRUD + non-empty delete (409)                                  */
/* -------------------------------------------------------------------------- */

test("folder tree: create nested, list as tree, rename, reparent", async () => {
  const { request } = buildHarness();

  const root = await request({
    method: "POST",
    path: "/api/folders",
    headers: ADMIN,
    body: { name: "root" }
  });
  assert.equal(root.status, 201);
  const rootId = root.body.folder.id;

  const child = await request({
    method: "POST",
    path: "/api/folders",
    headers: ADMIN,
    body: { name: "child", parentId: rootId }
  });
  assert.equal(child.status, 201);
  const childId = child.body.folder.id;

  const tree = await request({ method: "GET", path: "/api/folders", headers: ADMIN });
  assert.equal(tree.status, 200);
  assert.equal(tree.body.folders.length, 1);
  assert.equal(tree.body.folders[0].id, rootId);
  assert.equal(tree.body.folders[0].children.length, 1);
  assert.equal(tree.body.folders[0].children[0].id, childId);

  const renamed = await request({
    method: "PUT",
    path: `/api/folders/${childId}`,
    headers: ADMIN,
    body: { name: "renamed-child" }
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.folder.name, "renamed-child");

  // Reparent child to root again (no-op move) then to null (root).
  const moved = await request({
    method: "PUT",
    path: `/api/folders/${childId}`,
    headers: ADMIN,
    body: { parentId: null }
  });
  assert.equal(moved.status, 200);
  const tree2 = await request({ method: "GET", path: "/api/folders", headers: ADMIN });
  assert.equal(tree2.body.folders.length, 2);
});

test("DELETE folder with a pipeline inside -> 409 conflict", async () => {
  const { request } = buildHarness();
  const folder = await request({
    method: "POST",
    path: "/api/folders",
    headers: ADMIN,
    body: { name: "with-pipeline" }
  });
  const folderId = folder.body.folder.id;

  const pipeline = await request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "in-folder", name: "In Folder", folderId }
  });
  assert.equal(pipeline.status, 201);
  assert.equal(pipeline.body.pipeline.folderId, folderId);

  const blocked = await request({
    method: "DELETE",
    path: `/api/folders/${folderId}`,
    headers: ADMIN
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, "conflict");

  // Detach the pipeline, then the delete succeeds.
  const detach = await request({
    method: "PUT",
    path: `/api/pipelines/${pipeline.body.pipeline.id}/folder`,
    headers: ADMIN,
    body: { folderId: null }
  });
  assert.equal(detach.status, 200);
  const ok = await request({
    method: "DELETE",
    path: `/api/folders/${folderId}`,
    headers: ADMIN
  });
  assert.equal(ok.status, 204);
});

/* -------------------------------------------------------------------------- */
/* Save: idempotent vs bump + latest pointer + versions lineage               */
/* -------------------------------------------------------------------------- */

test("save: idempotent re-save vs version bump, latest pointer + lineage", async () => {
  const { request } = buildHarness();
  const created = await request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "saver", name: "Saver" }
  });
  const pid = created.body.pipeline.id;
  assert.equal(created.body.pipeline.latestVersionId, null);

  // First save -> new version (patch bump from 0.0.0 -> 0.0.1).
  const s1 = await request({
    method: "POST",
    path: `/api/pipelines/${pid}/save`,
    headers: ADMIN,
    body: { spec: echoSpec() }
  });
  assert.equal(s1.status, 201);
  assert.equal(s1.body.created, true);
  assert.equal(s1.body.version.version, "0.0.1");
  const v1Id = s1.body.version.id;

  // Re-save identical spec -> idempotent, no new row, pointer unchanged.
  const s2 = await request({
    method: "POST",
    path: `/api/pipelines/${pid}/save`,
    headers: ADMIN,
    body: { spec: echoSpec() }
  });
  assert.equal(s2.status, 200);
  assert.equal(s2.body.created, false);
  assert.equal(s2.body.version.id, v1Id);

  // Save a CHANGED spec with a minor bump -> 0.1.0, parent = v1.
  const s3 = await request({
    method: "POST",
    path: `/api/pipelines/${pid}/save`,
    headers: ADMIN,
    body: { spec: echoSpec("saver-2"), level: "minor" }
  });
  assert.equal(s3.status, 201);
  assert.equal(s3.body.version.version, "0.1.0");
  assert.equal(s3.body.version.parentVersionId, v1Id);
  const v2Id = s3.body.version.id;

  const versions = await request({
    method: "GET",
    path: `/api/pipelines/${pid}/versions`,
    headers: ADMIN
  });
  assert.equal(versions.status, 200);
  assert.equal(versions.body.versions.length, 2);
  assert.equal(versions.body.latestVersionId, v2Id);
  const flagged = versions.body.versions.find((v: any) => v.id === v2Id);
  assert.equal(flagged.isLatest, true);
  const old = versions.body.versions.find((v: any) => v.id === v1Id);
  assert.equal(old.isLatest, false);
  assert.equal(old.parentVersionId, null);

  // Rollback the latest pointer to v1 (pointer move only, no new row).
  const rb = await request({
    method: "POST",
    path: `/api/pipelines/${pid}/rollback`,
    headers: ADMIN,
    body: { versionId: v1Id }
  });
  assert.equal(rb.status, 200);
  assert.equal(rb.body.latestVersionId, v1Id);

  const afterRb = await request({
    method: "GET",
    path: `/api/pipelines/${pid}/versions`,
    headers: ADMIN
  });
  assert.equal(afterRb.body.versions.length, 2, "rollback creates no new version");
  assert.equal(afterRb.body.latestVersionId, v1Id);

  // Rollback to a non-existent version -> 404.
  const bad = await request({
    method: "POST",
    path: `/api/pipelines/${pid}/rollback`,
    headers: ADMIN,
    body: { versionId: "does-not-exist" }
  });
  assert.equal(bad.status, 404);
});

/* -------------------------------------------------------------------------- */
/* Associate + 2 concurrent activations + run targeting                       */
/* -------------------------------------------------------------------------- */

test("associate + 2 concurrent activations (pinned + track_latest) + run targeting", async () => {
  const { request, queue } = buildHarness();
  const tenantId = "tenant-a";

  await request({
    method: "POST",
    path: "/api/tenants",
    headers: ADMIN,
    body: { slug: tenantId, name: "Tenant A" }
  });
  const created = await request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "act-pipe", name: "Act Pipe" }
  });
  const pid = created.body.pipeline.id;

  // Two saved versions: v1 (0.0.1) then v2 (0.0.2). latest -> v2.
  const v1 = await request({
    method: "POST",
    path: `/api/pipelines/${pid}/save`,
    headers: ADMIN,
    body: { spec: echoSpec() }
  });
  const v1Id = v1.body.version.id;
  const v2 = await request({
    method: "POST",
    path: `/api/pipelines/${pid}/save`,
    headers: ADMIN,
    body: { spec: echoSpec("act-pipe-2") }
  });
  const v2Id = v2.body.version.id;

  // Associate the pipeline to the tenant.
  const assoc = await request({
    method: "POST",
    path: `/api/tenants/${tenantId}/pipelines`,
    headers: ADMIN,
    body: { pipelineId: pid, environment: "prod" }
  });
  assert.equal(assoc.status, 201);
  assert.equal(assoc.body.association.enabled, true);

  // Activation A: pinned to v1.
  const actPinned = await request({
    method: "POST",
    path: `/api/tenants/${tenantId}/pipelines/${pid}/activations`,
    headers: ADMIN,
    body: {
      label: "pinned",
      environment: "prod",
      pipelineVersionId: v1Id
    }
  });
  assert.equal(actPinned.status, 201);
  assert.equal(actPinned.body.activation.effectiveVersionId, v1Id);

  // Activation B: tracks latest (-> v2).
  const actLatest = await request({
    method: "POST",
    path: `/api/tenants/${tenantId}/pipelines/${pid}/activations`,
    headers: ADMIN,
    body: { label: "live", environment: "prod", trackLatest: true }
  });
  assert.equal(actLatest.status, 201);
  assert.equal(actLatest.body.activation.effectiveVersionId, v2Id);

  // Duplicate label -> 409.
  const dup = await request({
    method: "POST",
    path: `/api/tenants/${tenantId}/pipelines/${pid}/activations`,
    headers: ADMIN,
    body: { label: "pinned", environment: "prod", pipelineVersionId: v2Id }
  });
  assert.equal(dup.status, 409);

  // GET tenant pipelines reflects both activations + their effective ids.
  const list = await request({
    method: "GET",
    path: `/api/tenants/${tenantId}/pipelines`,
    headers: ADMIN
  });
  assert.equal(list.status, 200);
  const entry = list.body.pipelines.find((p: any) => p.pipelineId === pid);
  assert.equal(entry.enabled, true);
  assert.equal(entry.activations.length, 2);

  // Ambiguous run (2 enabled activations, no label, no "default") -> 409.
  const ambiguous = await request({
    method: "POST",
    path: `/api/pipelines/${pid}/run`,
    headers: { ...ADMIN, "x-tenant-id": tenantId },
    body: { input: {}, environment: "prod" }
  });
  assert.equal(ambiguous.status, 409);
  assert.equal(ambiguous.body.error, "activation_unresolved");

  // Targeted run via the "pinned" label -> resolves v1.
  const runPinned = await request({
    method: "POST",
    path: `/api/pipelines/${pid}/run`,
    headers: { ...ADMIN, "x-tenant-id": tenantId },
    body: { input: { q: 1 }, environment: "prod", activation: "pinned" }
  });
  assert.equal(runPinned.status, 202);
  assert.equal(runPinned.body.resolvedVia, "activation");
  assert.equal(runPinned.body.activationLabel, "pinned");
  assert.equal(runPinned.body.pipelineVersionId, v1Id);
  assert.equal(await queue.status(runPinned.body.jobId), "queued");

  // Targeted run via "live" (track_latest) -> resolves v2.
  const runLive = await request({
    method: "POST",
    path: `/api/pipelines/${pid}/run`,
    headers: { ...ADMIN, "x-tenant-id": tenantId },
    body: { input: {}, environment: "prod", activation: "live" }
  });
  assert.equal(runLive.status, 202);
  assert.equal(runLive.body.pipelineVersionId, v2Id);

  // Disable the pinned activation; targeting it -> 409.
  const patch = await request({
    method: "PATCH",
    path: `/api/tenants/${tenantId}/pipelines/${pid}/activations/${actPinned.body.activation.id}`,
    headers: ADMIN,
    body: { enabled: false }
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.activation.enabled, false);

  const runDisabled = await request({
    method: "POST",
    path: `/api/pipelines/${pid}/run`,
    headers: { ...ADMIN, "x-tenant-id": tenantId },
    body: { input: {}, environment: "prod", activation: "pinned" }
  });
  assert.equal(runDisabled.status, 409);

  // Now only "live" is enabled -> unlabelled run resolves it unambiguously.
  const runDefault = await request({
    method: "POST",
    path: `/api/pipelines/${pid}/run`,
    headers: { ...ADMIN, "x-tenant-id": tenantId },
    body: { input: {}, environment: "prod" }
  });
  assert.equal(runDefault.status, 202);
  assert.equal(runDefault.body.pipelineVersionId, v2Id);

  // Deactivate the association via PATCH.
  const deactivate = await request({
    method: "PATCH",
    path: `/api/tenants/${tenantId}/pipelines/${pid}`,
    headers: ADMIN,
    body: { enabled: false, environment: "prod" }
  });
  assert.equal(deactivate.status, 200);
  assert.equal(deactivate.body.association.enabled, false);

  // DELETE the live activation.
  const del = await request({
    method: "DELETE",
    path: `/api/tenants/${tenantId}/pipelines/${pid}/activations/${actLatest.body.activation.id}`,
    headers: ADMIN
  });
  assert.equal(del.status, 204);
});

/* -------------------------------------------------------------------------- */
/* Back-compat: run with NO activations resolves via the deployment path      */
/* -------------------------------------------------------------------------- */

test("back-compat: run with no activations resolves via deployment", async () => {
  const { request, queue } = buildHarness();
  const created = await request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "legacy", name: "Legacy" }
  });
  const pid = created.body.pipeline.id;

  await request({
    method: "POST",
    path: `/api/pipelines/${pid}/versions`,
    headers: ADMIN,
    body: { version: "1.0.0", publish: true, spec: echoSpec() }
  });
  await request({
    method: "POST",
    path: `/api/pipelines/${pid}/deployments`,
    headers: ADMIN,
    body: { version: "1.0.0", environment: "dev" }
  });

  const run = await request({
    method: "POST",
    path: `/api/pipelines/${pid}/run`,
    headers: { ...ADMIN, "x-tenant-id": "tenant-a" },
    body: { input: { question: "hi" }, environment: "dev" }
  });
  assert.equal(run.status, 202);
  assert.equal(run.body.resolvedVia, "deployment");
  assert.equal(run.body.version, "1.0.0");
  assert.equal(run.body.activationLabel, undefined);
  assert.equal(await queue.status(run.body.jobId), "queued");
});

/* -------------------------------------------------------------------------- */
/* Schedules: cron validation (good + bad) + next_run_at                       */
/* -------------------------------------------------------------------------- */

test("schedules: create with valid + invalid cron, list filters, lifecycle", async () => {
  const { request } = buildHarness();
  const tenantId = "tenant-a";

  const good = await request({
    method: "POST",
    path: "/api/schedules",
    headers: ADMIN,
    body: {
      tenantId,
      pipelineId: "p-1",
      environment: "prod",
      cron: "0 * * * *",
      input: { x: 1 }
    }
  });
  assert.equal(good.status, 201);
  assert.equal(good.body.schedule.cron, "0 * * * *");
  assert.equal(good.body.schedule.timezone, "UTC");
  assert.ok(
    typeof good.body.schedule.nextRunAt === "string" &&
      good.body.schedule.nextRunAt.length > 0,
    "next_run_at computed via nextAfter"
  );
  const schedId = good.body.schedule.id;

  const bad = await request({
    method: "POST",
    path: "/api/schedules",
    headers: ADMIN,
    body: {
      tenantId,
      pipelineId: "p-1",
      environment: "prod",
      cron: "not a cron"
    }
  });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error, "validation_failed");

  // List + filters.
  const list = await request({
    method: "GET",
    path: "/api/schedules",
    headers: ADMIN,
    query: { tenant: tenantId, pipeline: "p-1" }
  });
  assert.equal(list.status, 200);
  assert.equal(list.body.schedules.length, 1);

  // PUT re-validates cron + recomputes next_run_at.
  const prevNext = good.body.schedule.nextRunAt;
  const put = await request({
    method: "PUT",
    path: `/api/schedules/${schedId}`,
    headers: ADMIN,
    body: { cron: "*/5 * * * *", timezone: "America/New_York" }
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.schedule.cron, "*/5 * * * *");
  assert.equal(put.body.schedule.timezone, "America/New_York");
  assert.ok(typeof put.body.schedule.nextRunAt === "string");
  void prevNext;

  // PUT with a bad cron -> 422 (re-validation).
  const putBad = await request({
    method: "PUT",
    path: `/api/schedules/${schedId}`,
    headers: ADMIN,
    body: { cron: "xx" }
  });
  assert.equal(putBad.status, 422);

  // PATCH disable.
  const patch = await request({
    method: "PATCH",
    path: `/api/schedules/${schedId}`,
    headers: ADMIN,
    body: { enabled: false }
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.schedule.enabled, false);

  // DELETE.
  const del = await request({
    method: "DELETE",
    path: `/api/schedules/${schedId}`,
    headers: ADMIN
  });
  assert.equal(del.status, 204);
  const after = await request({
    method: "GET",
    path: "/api/schedules",
    headers: ADMIN
  });
  assert.equal(after.body.schedules.length, 0);
});

/* -------------------------------------------------------------------------- */
/* config/values scope + scopeId filters (tree support)                        */
/* -------------------------------------------------------------------------- */

test("config/values accepts scope + scopeId filters (camelCase + snake_case)", async () => {
  const { request } = buildHarness();
  await request({
    method: "PUT",
    path: "/api/config/definitions/k",
    headers: ADMIN,
    body: { type: "string", allowedScopes: ["global", "tenant"] }
  });
  await request({
    method: "POST",
    path: "/api/config/values",
    headers: ADMIN,
    body: { key: "k", value: "g", scope: "global" }
  });
  await request({
    method: "POST",
    path: "/api/config/values",
    headers: ADMIN,
    body: { key: "k", value: "t", scope: "tenant", scopeId: "tenant-a" }
  });

  const globalOnly = await request({
    method: "GET",
    path: "/api/config/values",
    headers: ADMIN,
    query: { scope: "global" }
  });
  assert.equal(globalOnly.status, 200);
  assert.equal(globalOnly.body.values.length, 1);
  assert.equal(globalOnly.body.values[0].scope, "global");

  const tenantCamel = await request({
    method: "GET",
    path: "/api/config/values",
    headers: ADMIN,
    query: { scope: "tenant", scopeId: "tenant-a" }
  });
  assert.equal(tenantCamel.body.values.length, 1);
  assert.equal(tenantCamel.body.values[0].scopeId, "tenant-a");

  const tenantSnake = await request({
    method: "GET",
    path: "/api/config/values",
    headers: ADMIN,
    query: { scope: "tenant", scope_id: "tenant-a" }
  });
  assert.equal(tenantSnake.body.values.length, 1);
});
