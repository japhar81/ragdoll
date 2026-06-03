// k6 setup helper: discover the local stack's auth + tenant + pipeline IDs.
//
// k6's setup() phase runs ONCE before any VU starts and its return value is
// passed (deep-cloned) to default() / teardown() in every VU. We do the
// stateful work here so the load loop stays a pure POST.
//
// Inputs (env vars, all optional):
//   - BASE_URL                 default http://localhost:3001
//   - RAGDOLL_API_KEY          if set, used as `Authorization: ApiKey <key>`;
//                              if not, we log in with BOOTSTRAP_ADMIN_* and
//                              use the returned `Authorization: Bearer ...`.
//   - BOOTSTRAP_ADMIN_EMAIL    default admin@ragdoll.local
//   - BOOTSTRAP_ADMIN_PASSWORD default ragdoll-admin
//   - TENANT_SLUG              default tenant-local
//
// Returns: { baseUrl, authHeader, tenantId, pipelines: { [slug]: id } }
//
// `pipelines` includes EVERY load-* slug found in /api/pipelines; a default()
// can pick whichever it wants. If a slug expected by a scenario is missing,
// the scenario fails fast in setup() with a clear message — that's better
// than 100 VUs hammering a 404 for 10 minutes.

import http from "k6/http";
import { check, fail } from "k6";

const REQUIRED_PIPELINES = [
  "load-passthrough",
  "load-fanout-merge",
  "load-deep-chain",
  "load-xml-parse"
];

export function bootstrapAuth() {
  const baseUrl = __ENV.BASE_URL || "http://localhost:3001";
  const tenantSlug = __ENV.TENANT_SLUG || "tenant-local";

  // Step 1 — auth. API key wins if provided; otherwise log in as admin.
  let authHeader;
  if (__ENV.RAGDOLL_API_KEY) {
    authHeader = `ApiKey ${__ENV.RAGDOLL_API_KEY}`;
  } else {
    const email = __ENV.BOOTSTRAP_ADMIN_EMAIL || "admin@ragdoll.local";
    const password = __ENV.BOOTSTRAP_ADMIN_PASSWORD || "ragdoll-admin";
    const res = http.post(
      `${baseUrl}/api/auth/login`,
      JSON.stringify({ email, password }),
      { headers: { "content-type": "application/json" } }
    );
    if (
      !check(res, {
        "login 200": (r) => r.status === 200,
        "login returns token": (r) => !!r.json("token")
      })
    ) {
      fail(`login failed (status=${res.status}): ${res.body}`);
    }
    authHeader = `Bearer ${res.json("token")}`;
  }

  const adminHeaders = {
    authorization: authHeader,
    "content-type": "application/json"
  };

  // Step 2 — resolve the tenant id from its slug.
  const tenantRes = http.get(`${baseUrl}/api/tenants`, { headers: adminHeaders });
  if (
    !check(tenantRes, {
      "/api/tenants 200": (r) => r.status === 200
    })
  ) {
    fail(
      `tenants lookup failed (status=${tenantRes.status}): ${tenantRes.body}`
    );
  }
  const tenants = tenantRes.json("tenants") || [];
  const tenant = tenants.find((t) => t.slug === tenantSlug);
  if (!tenant) {
    fail(
      `tenant with slug "${tenantSlug}" not found — seeded the stack? (found: ${tenants.map((t) => t.slug).join(", ")})`
    );
  }

  // Step 3 — list pipelines + index every load-* one by slug.
  const pipeRes = http.get(`${baseUrl}/api/pipelines`, { headers: adminHeaders });
  if (
    !check(pipeRes, { "/api/pipelines 200": (r) => r.status === 200 })
  ) {
    fail(`pipelines lookup failed (status=${pipeRes.status}): ${pipeRes.body}`);
  }
  const all = pipeRes.json("pipelines") || [];
  const pipelines = {};
  for (const p of all) {
    if (typeof p.slug === "string" && p.slug.startsWith("load-")) {
      pipelines[p.slug] = p.id;
    }
  }
  for (const required of REQUIRED_PIPELINES) {
    if (!pipelines[required]) {
      fail(
        `missing required load pipeline "${required}" — run \`npm run build:load-seeds\` and re-up the stack so the seed re-applies`
      );
    }
  }

  return { baseUrl, authHeader, tenantId: tenant.id, pipelines };
}

/** Build the headers a /invoke call needs. Re-derived per request so k6 can
 *  rotate per-VU headers later if we ever multi-tenant the harness. */
export function invokeHeaders(setupData) {
  return {
    authorization: setupData.authHeader,
    "x-tenant-id": setupData.tenantId,
    "content-type": "application/json"
  };
}
