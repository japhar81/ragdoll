/**
 * SSO start/callback rate limiting + the 404 path for unknown providers.
 *
 * The full OIDC/SAML round-trip needs an IdP under test; that's covered
 * by the e2e suite. Here we lock in the surface behavior — auth not
 * required, but rate-limited, and unknown providers 404 fast.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildHarness } from "./helpers.ts";
import { PasswordService } from "../../../packages/auth/src/index.ts";
import { ssoPerIpLimiter } from "../src/app/rate-limit.ts";

async function seedAdminAndProvider(h: ReturnType<typeof buildHarness>): Promise<void> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await h.deps.users!.create({
    id,
    email: `a-${randomUUID().slice(0, 6)}@x.io`,
    displayName: "a",
    passwordHash: await new PasswordService().hash("password123"),
    status: "active",
    createdAt: now,
    updatedAt: now
  });
  await h.deps.rbacPolicies!.addGrant({
    id: randomUUID(),
    userId: id,
    role: "platform_admin",
    scope: "*",
    createdAt: now
  });
  const bearer = `Bearer ${h.sessions.sign({ id, type: "user", roles: [] }, 3600)}`;
  const res = await h.request({
    method: "POST",
    path: "/api/identity-providers",
    headers: { authorization: bearer },
    body: {
      slug: "test-oidc",
      kind: "oidc",
      displayName: "Test OIDC",
      config: {
        issuer: "https://example.com",
        clientId: "abc",
        clientSecret: "shhh"
      }
    }
  });
  assert.equal(res.status, 201);
}

test("GET /api/auth/providers is public and returns enabled providers", async () => {
  const h = buildHarness({ withAuth: true });
  await seedAdminAndProvider(h);
  const res = await h.request({ method: "GET", path: "/api/auth/providers" });
  assert.equal(res.status, 200);
  assert.equal(res.body.providers[0].slug, "test-oidc");
});

test("GET /api/auth/sso/:slug/start 404s for an unknown provider slug", async () => {
  ssoPerIpLimiter.reset();
  const h = buildHarness({ withAuth: true });
  const res = await h.request({
    method: "GET",
    path: "/api/auth/sso/does-not-exist/start"
  });
  assert.equal(res.status, 404);
});

test("SSO start endpoint is rate-limited per IP", async () => {
  ssoPerIpLimiter.reset();
  const h = buildHarness({ withAuth: true });
  // Default capacity = 10, refill 1/sec. Fire 12 from a single IP and
  // expect a 429 well before the loop ends.
  let limited = false;
  for (let i = 0; i < 15; i++) {
    const res = await h.request({
      method: "GET",
      path: "/api/auth/sso/missing/start",
      headers: { "x-forwarded-for": "1.2.3.4" }
    });
    if (res.status === 429) {
      assert.equal(res.body.error, "rate_limited");
      assert.equal(res.body.scope, "ip");
      assert.ok(res.body.retryAfterSec >= 1);
      limited = true;
      break;
    }
    // Unknown provider but auth-free → 404 until the bucket is empty.
    assert.equal(res.status, 404);
  }
  assert.equal(limited, true, "expected a 429 within the burst window");
});

test("SSO callback endpoint is also rate-limited per IP", async () => {
  ssoPerIpLimiter.reset();
  const h = buildHarness({ withAuth: true });
  // Fire many requests against the unauthenticated SSO callback;
  // expect a 429 before completion. Use a unique IP so cross-test
  // bucket pollution can't mask a regression.
  const seenStatuses = new Set<number>();
  let saw429 = false;
  for (let i = 0; i < 50; i++) {
    const res = await h.request({
      method: "GET",
      path: "/api/auth/sso/missing/callback",
      query: { code: "abc", state: "xyz" },
      headers: { "x-forwarded-for": "5.6.7.8" }
    });
    seenStatuses.add(res.status);
    if (res.status === 429) {
      saw429 = true;
      break;
    }
  }
  assert.equal(
    saw429,
    true,
    `expected a 429 within 50 calls; saw statuses: ${[...seenStatuses].join(",")}`
  );
});
