/**
 * Webhook triggers: scoped mint, public POST, revoke. End-to-end through
 * `createApp` with the full auth stack wired (strict default-deny harness).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildHarness, echoSpec } from "./helpers.ts";
import { PasswordService } from "../../../packages/auth/src/index.ts";

async function seedUser(
  h: ReturnType<typeof buildHarness>,
  opts: { email: string; grants?: Array<{ role: string; scope: string }> }
): Promise<{ id: string; bearer: Record<string, string> }> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await h.deps.users!.create({
    id,
    email: opts.email,
    displayName: opts.email,
    passwordHash: await new PasswordService().hash("password123"),
    status: "active",
    createdAt: now,
    updatedAt: now
  });
  for (const g of opts.grants ?? []) {
    await h.deps.rbacPolicies!.addGrant({
      id: randomUUID(),
      userId: id,
      role: g.role,
      scope: g.scope,
      createdAt: now
    });
  }
  return {
    id,
    bearer: {
      authorization: `Bearer ${h.sessions.sign(
        { id, type: "user", roles: [] },
        3600
      )}`
    }
  };
}

/** Provision a deployable pipeline so resolveDeployedVersion has something. */
async function seedRunnablePipeline(
  h: ReturnType<typeof buildHarness>,
  tenantId: string
): Promise<{ pipelineId: string }> {
  const admin = await seedUser(h, {
    email: `pa-${randomUUID().slice(0, 8)}@x.io`,
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const created = await h.request({
    method: "POST",
    path: "/api/pipelines",
    headers: admin.bearer,
    body: { slug: `wp-${randomUUID().slice(0, 8)}`, name: "Webhook Pipeline" }
  });
  assert.equal(created.status, 201);
  const pipelineId = created.body.pipeline.id;
  const pub = await h.request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/versions`,
    headers: admin.bearer,
    body: { version: "1.0.0", publish: true, spec: echoSpec() }
  });
  assert.equal(pub.status, 201);
  await h.request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/deployments`,
    headers: { ...admin.bearer, "x-tenant-id": tenantId },
    body: { version: "1.0.0", environment: "dev", tenantId }
  });
  return { pipelineId };
}

// --- minting -------------------------------------------------------------

test("a user without pipeline:run @ tenant cannot mint a trigger (403)", async () => {
  const h = buildHarness({ withAuth: true });
  const tenantId = randomUUID();
  await h.deps.tenants.create({
    id: tenantId,
    slug: "ten-x",
    name: "X",
    status: "active",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const { pipelineId } = await seedRunnablePipeline(h, tenantId);
  const { bearer } = await seedUser(h, {
    email: "viewer@x.io",
    grants: [{ role: "viewer", scope: "*" }]
  });
  const res = await h.request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/triggers`,
    headers: { ...bearer, "x-tenant-id": tenantId },
    body: { environment: "dev", name: "edge" }
  });
  assert.equal(res.status, 403);
});

test("a tenant-scoped user can mint a trigger for their tenant only", async () => {
  const h = buildHarness({ withAuth: true });
  const tenantId = randomUUID();
  await h.deps.tenants.create({
    id: tenantId,
    slug: "ten-y",
    name: "Y",
    status: "active",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const { pipelineId } = await seedRunnablePipeline(h, tenantId);
  const { bearer } = await seedUser(h, {
    email: "op@y.io",
    grants: [{ role: "tenant_operator", scope: `t/${tenantId}` }]
  });
  const ok = await h.request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/triggers`,
    headers: { ...bearer, "x-tenant-id": tenantId },
    body: { environment: "dev", name: "ci" }
  });
  assert.equal(ok.status, 201);
  assert.match(ok.body.token, /^wht_[0-9a-f]+_[0-9a-f]+$/);
  assert.ok(ok.body.url.includes(ok.body.token));
});

// --- public trigger ------------------------------------------------------

test("POST /api/triggers/webhook/:token enqueues a run with the body as input", async () => {
  const h = buildHarness({ withAuth: true });
  const tenantId = randomUUID();
  await h.deps.tenants.create({
    id: tenantId,
    slug: "ten-z",
    name: "Z",
    status: "active",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const { pipelineId } = await seedRunnablePipeline(h, tenantId);
  const admin = await seedUser(h, {
    email: "padmin2@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const minted = await h.request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/triggers`,
    headers: { ...admin.bearer, "x-tenant-id": tenantId },
    body: { environment: "dev", name: "fire" }
  });
  assert.equal(minted.status, 201);
  const token = minted.body.token;

  // No auth headers; the path token IS the auth.
  const fire = await h.request({
    method: "POST",
    path: `/api/triggers/webhook/${token}`,
    body: { question: "what time is it?" }
  });
  assert.equal(fire.status, 202);
  assert.equal(fire.body.status, "accepted");
  assert.ok(fire.body.executionId);

  // The job is queued with the body as the run's input.
  const jobs = h.queue.list();
  const last = jobs[jobs.length - 1];
  assert.equal(last.type, "run_pipeline");
  assert.deepEqual((last.payload as { input: unknown }).input, {
    question: "what time is it?"
  });
});

test("an invalid or malformed webhook token returns 401", async () => {
  const h = buildHarness({ withAuth: true });
  const bogus = await h.request({
    method: "POST",
    path: "/api/triggers/webhook/wht_nope_nope",
    body: {}
  });
  assert.equal(bogus.status, 401);

  const malformed = await h.request({
    method: "POST",
    path: "/api/triggers/webhook/not-a-token",
    body: {}
  });
  assert.equal(malformed.status, 401);
});

test("webhook trigger is rate-limited per token after burst capacity is exhausted", async () => {
  // Reset module-state so other tests in the file don't pre-consume tokens.
  const { webhookPerIpLimiter, webhookPerTokenLimiter } = await import(
    "../src/app/rate-limit.ts"
  );
  webhookPerIpLimiter.reset();
  webhookPerTokenLimiter.reset();

  const h = buildHarness({ withAuth: true });
  const tenantId = randomUUID();
  await h.deps.tenants.create({
    id: tenantId,
    slug: "ten-rl",
    name: "RL",
    status: "active",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const { pipelineId } = await seedRunnablePipeline(h, tenantId);
  const admin = await seedUser(h, {
    email: "padmin-rl@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const minted = await h.request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/triggers`,
    headers: { ...admin.bearer, "x-tenant-id": tenantId },
    body: { environment: "dev", name: "rl" }
  });
  assert.equal(minted.status, 201);
  const token = minted.body.token;

  // Default capacity = 20 (per token), 60 (per IP). Drain the token bucket
  // by firing 21 requests from one source.
  let lastStatus = 0;
  let limited = false;
  for (let i = 0; i < 25; i++) {
    const res = await h.request({
      method: "POST",
      path: `/api/triggers/webhook/${token}`,
      body: { i }
    });
    lastStatus = res.status;
    if (res.status === 429) {
      limited = true;
      assert.equal(res.body.error, "rate_limited");
      assert.equal(res.body.scope, "token");
      assert.ok(res.body.retryAfterSec > 0);
      break;
    }
  }
  assert.equal(limited, true, `expected 429 within 25 calls; last status was ${lastStatus}`);
});

test("deleting a trigger revokes it immediately", async () => {
  const h = buildHarness({ withAuth: true });
  const tenantId = randomUUID();
  await h.deps.tenants.create({
    id: tenantId,
    slug: "ten-r",
    name: "R",
    status: "active",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const { pipelineId } = await seedRunnablePipeline(h, tenantId);
  const admin = await seedUser(h, {
    email: "padmin3@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const minted = await h.request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/triggers`,
    headers: { ...admin.bearer, "x-tenant-id": tenantId },
    body: { environment: "dev", name: "revokeme" }
  });
  assert.equal(minted.status, 201);
  const token = minted.body.token;
  const id = minted.body.trigger.id;

  const ok = await h.request({
    method: "POST",
    path: `/api/triggers/webhook/${token}`,
    body: {}
  });
  assert.equal(ok.status, 202);

  const del = await h.request({
    method: "DELETE",
    path: `/api/triggers/${id}`,
    headers: { ...admin.bearer, "x-tenant-id": tenantId }
  });
  assert.equal(del.status, 204);

  const denied = await h.request({
    method: "POST",
    path: `/api/triggers/webhook/${token}`,
    body: {}
  });
  assert.equal(denied.status, 401);
});

// --- listing -------------------------------------------------------------

test("GET /api/pipelines/:id/triggers returns minted triggers without the token", async () => {
  const h = buildHarness({ withAuth: true });
  const tenantId = randomUUID();
  await h.deps.tenants.create({
    id: tenantId,
    slug: "ten-l",
    name: "L",
    status: "active",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const { pipelineId } = await seedRunnablePipeline(h, tenantId);
  const admin = await seedUser(h, {
    email: "padmin4@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  await h.request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/triggers`,
    headers: { ...admin.bearer, "x-tenant-id": tenantId },
    body: { environment: "dev", name: "one" }
  });
  await h.request({
    method: "POST",
    path: `/api/pipelines/${pipelineId}/triggers`,
    headers: { ...admin.bearer, "x-tenant-id": tenantId },
    body: { environment: "dev", name: "two" }
  });
  const list = await h.request({
    method: "GET",
    path: `/api/pipelines/${pipelineId}/triggers`,
    headers: { ...admin.bearer, "x-tenant-id": tenantId }
  });
  assert.equal(list.status, 200);
  assert.equal(list.body.triggers.length, 2);
  for (const t of list.body.triggers) {
    assert.ok(!("token" in t));
    assert.ok(!("hash" in t));
    assert.ok(t.prefix);
  }
});
