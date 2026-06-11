/**
 * Functional tests for `GET /api/pipelines/:id/validation` — the
 * per-pipeline validator that returns the same envelope the Builder
 * uses to light up canvas badges, without making the caller resend the
 * spec.
 *
 *   - latest version (no ?version param) returns the canonical
 *     PipelineValidationResult shape on a valid pipeline.
 *   - ?version=X.Y.Z pins to a specific version and returns its
 *     validation; unknown version → 404.
 *   - pipeline with no saved versions → 404 with an actionable message
 *     (NOT 500).
 *   - unknown pipeline id/slug → 404 pipeline_not_found.
 *   - resolution works for SLUG and UUID identically (matches every
 *     other /api/pipelines/:id route).
 *
 * Framework-agnostic, InMemory, offline / install-free.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildHarness, echoSpec } from "./helpers.ts";
import { createApp } from "../src/app.ts";

const ADMIN = { "x-actor-id": "admin", "x-roles": "platform_admin" };

test("GET /api/pipelines/:id/validation returns the validation envelope for the latest version", async () => {
  const harness = buildHarness();

  const created = await harness.request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "vp-pipeline", name: "vp-pipeline" }
  });
  assert.equal(created.status, 201);
  const id = created.body.pipeline.id;

  const pub = await harness.request({
    method: "POST",
    path: `/api/pipelines/${id}/versions`,
    headers: ADMIN,
    body: { version: "1.0.0", publish: true, spec: echoSpec() }
  });
  assert.equal(pub.status, 201);

  const valid = await harness.request({
    method: "GET",
    path: `/api/pipelines/${id}/validation`,
    headers: ADMIN
  });
  assert.equal(valid.status, 200);
  // Envelope: pipeline id/slug + version metadata + the full
  // PipelineValidationResult shape.
  assert.equal(valid.body.pipelineId, id);
  assert.equal(valid.body.pipelineSlug, "vp-pipeline");
  assert.equal(valid.body.version, "1.0.0");
  assert.equal(typeof valid.body.versionId, "string");
  assert.equal(valid.body.valid, true);
  assert.ok(Array.isArray(valid.body.errors));
  assert.ok(Array.isArray(valid.body.warnings));
  assert.ok(Array.isArray(valid.body.requiredSecrets));
  assert.ok(Array.isArray(valid.body.requiredConfig));
  assert.ok(Array.isArray(valid.body.missingPlugins));
  assert.ok(Array.isArray(valid.body.datasetSlots));
});

test("GET /api/pipelines/:id/validation resolves by SLUG identically to UUID", async () => {
  const harness = buildHarness();

  const created = await harness.request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "by-slug", name: "by-slug" }
  });
  const id = created.body.pipeline.id;
  await harness.request({
    method: "POST",
    path: `/api/pipelines/${id}/versions`,
    headers: ADMIN,
    body: { version: "1.0.0", publish: true, spec: echoSpec() }
  });

  const bySlug = await harness.request({
    method: "GET",
    path: "/api/pipelines/by-slug/validation",
    headers: ADMIN
  });
  const byUuid = await harness.request({
    method: "GET",
    path: `/api/pipelines/${id}/validation`,
    headers: ADMIN
  });
  assert.equal(bySlug.status, 200);
  assert.equal(byUuid.status, 200);
  // Both yield the same envelope (modulo wall-clock — there's none in the shape).
  assert.deepEqual(bySlug.body, byUuid.body);
});

test("GET /api/pipelines/:id/validation?version=X.Y.Z pins to that version", async () => {
  const harness = buildHarness();

  const created = await harness.request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "vp-pinned", name: "vp-pinned" }
  });
  const id = created.body.pipeline.id;
  await harness.request({
    method: "POST",
    path: `/api/pipelines/${id}/versions`,
    headers: ADMIN,
    body: { version: "1.0.0", publish: true, spec: echoSpec("first") }
  });
  await harness.request({
    method: "POST",
    path: `/api/pipelines/${id}/versions`,
    headers: ADMIN,
    body: { version: "2.0.0", publish: true, spec: echoSpec("second") }
  });

  const pinned = await harness.request({
    method: "GET",
    path: `/api/pipelines/${id}/validation`,
    headers: ADMIN,
    query: { version: "1.0.0" }
  });
  assert.equal(pinned.status, 200);
  assert.equal(pinned.body.version, "1.0.0");
});

test("GET /api/pipelines/:id/validation?version=missing → 404 (NOT 500)", async () => {
  const harness = buildHarness();

  const created = await harness.request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "vp-404v", name: "vp-404v" }
  });
  const id = created.body.pipeline.id;
  await harness.request({
    method: "POST",
    path: `/api/pipelines/${id}/versions`,
    headers: ADMIN,
    body: { version: "1.0.0", publish: true, spec: echoSpec() }
  });

  const missing = await harness.request({
    method: "GET",
    path: `/api/pipelines/${id}/validation`,
    headers: ADMIN,
    query: { version: "9.9.9" }
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "not_found");
});

test("GET /api/pipelines/:id/validation on a pipeline with no versions → 404 with an actionable hint", async () => {
  const harness = buildHarness();

  const created = await harness.request({
    method: "POST",
    path: "/api/pipelines",
    headers: ADMIN,
    body: { slug: "no-versions", name: "no-versions" }
  });
  const id = created.body.pipeline.id;

  const noVersions = await harness.request({
    method: "GET",
    path: `/api/pipelines/${id}/validation`,
    headers: ADMIN
  });
  assert.equal(noVersions.status, 404);
  assert.equal(noVersions.body.error, "not_found");
  assert.match(String(noVersions.body.message ?? ""), /no saved versions/);
});

test("GET /api/pipelines/:id/validation on an unknown id/slug → 404 pipeline_not_found", async () => {
  const harness = buildHarness();

  const unknown = await harness.request({
    method: "GET",
    path: "/api/pipelines/does-not-exist/validation",
    headers: ADMIN
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, "pipeline_not_found");
});
