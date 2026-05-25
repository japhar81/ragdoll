/**
 * Playwright globalSetup.
 *
 * Two responsibilities:
 *   1. Sign in to the local stack as the bootstrap admin and stash both a
 *      Bearer token (for REST calls from specs / teardown) and a browser
 *      storageState file (so each test starts already authenticated).
 *   2. Create the `integration_testing` tenant + a `dev` environment so the
 *      whole suite operates against an isolated row that teardown can
 *      cascade-delete. If the tenant already exists from a botched prior
 *      run we reuse it — the slug is the idempotency key.
 *
 * Output:
 *   tests/playwright/.test-output/storage-state.json   (browser session)
 *   tests/playwright/.test-output/integration-state.json (token, tenantId, …)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { request, type FullConfig } from "@playwright/test";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  INTEGRATION_TENANT_NAME,
  INTEGRATION_TENANT_SLUG,
  STATE_PATH,
  WEB_URL
} from "./helpers/env.ts";
import { createRestClient, signIn } from "./helpers/api.ts";

interface IntegrationState {
  token: string;
  principalId?: string;
  tenantId: string;
  tenantSlug: string;
  environment: string;
}

async function ensureTenant(
  client: ReturnType<typeof createRestClient>
): Promise<{ tenantId: string; environment: string }> {
  // Check whether a prior run's tenant is still around.
  const existing = await client.request<{
    tenants: Array<{ id: string; slug: string }>;
  }>("GET", "/api/tenants");
  let row = existing.tenants.find((t) => t.slug === INTEGRATION_TENANT_SLUG);
  if (!row) {
    const created = await client.request<{
      tenant: { id: string; slug: string };
    }>("POST", "/api/tenants", {
      slug: INTEGRATION_TENANT_SLUG,
      name: INTEGRATION_TENANT_NAME
    });
    row = created.tenant;
  }
  // Make sure a `dev` environment exists on the tenant so any pipeline
  // deploy in the specs has somewhere to land.
  const envs = await client.request<{
    environments: Array<{ name: string }>;
  }>("GET", `/api/tenants/${row.id}/environments`, undefined, {
    tenantId: row.id
  });
  if (!envs.environments.some((e) => e.name === "dev")) {
    await client
      .request("POST", `/api/tenants/${row.id}/environments`, { name: "dev" }, {
        tenantId: row.id
      })
      .catch(() => {
        /* the API may auto-create envs on first use; ignore conflicts */
      });
  }
  return { tenantId: row.id, environment: "dev" };
}

async function persistBrowserSession(
  token: string,
  storageStatePath: string
): Promise<void> {
  // Drive a real browser login so we capture httpOnly cookies the SPA
  // uses. The simpler path of just writing a localStorage entry isn't
  // sufficient — the web app reads its token from a session cookie set
  // by /api/auth/login on the same origin as the SPA.
  const reqCtx = await request.newContext({ baseURL: WEB_URL });
  const res = await reqCtx.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    headers: { "content-type": "application/json" }
  });
  if (!res.ok()) {
    throw new Error(
      `browser sign-in failed via the SPA origin: HTTP ${res.status()} ${await res.text()}`
    );
  }
  // Also seed localStorage with the bearer so the React app's api client
  // picks it up — the bootstrap admin login may set both a cookie AND a
  // localStorage token; mirror that.
  await mkdir(dirname(storageStatePath), { recursive: true });
  const state = await reqCtx.storageState();
  // Merge bearer into localStorage manually; Playwright's storageState
  // captures cookies but not localStorage from an APIRequestContext.
  state.origins = state.origins ?? [];
  let origin = state.origins.find((o) => o.origin === WEB_URL);
  if (!origin) {
    origin = { origin: WEB_URL, localStorage: [] };
    state.origins.push(origin);
  }
  // Storage key the web app reads its session from — must match
  // STORAGE_KEY in apps/web/src/lib/auth.ts so React boots already
  // authenticated.
  origin.localStorage = [
    ...origin.localStorage.filter((e) => e.name !== "ragdoll.session.token"),
    { name: "ragdoll.session.token", value: token }
  ];
  await writeFile(storageStatePath, JSON.stringify(state, null, 2));
  await reqCtx.dispose();
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const { token, principalId } = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  const client = createRestClient(token);
  const { tenantId, environment } = await ensureTenant(client);

  const integrationState: IntegrationState = {
    token,
    principalId,
    tenantId,
    tenantSlug: INTEGRATION_TENANT_SLUG,
    environment
  };
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(integrationState, null, 2));

  // Resolve the storageState path from the running config so we end up
  // writing to whatever the projects expect (single source of truth).
  const storageStatePath =
    (config.projects[0].use.storageState as string | undefined) ??
    "./tests/playwright/.test-output/storage-state.json";
  await persistBrowserSession(token, storageStatePath);
}
