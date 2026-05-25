/**
 * Playwright globalTeardown.
 *
 * Nuke the integration_testing tenant unconditionally. Always re-resolves
 * the tenant by slug so a botched setup still gets cleaned up. DELETE on
 * /api/tenants/:id cascades through everything created during the suite —
 * pipelines, deployments, schedules, datasets, audit, executions — so
 * re-running is idempotent.
 *
 * Skipped only when KEEP_INTEGRATION_TENANT=1 is set, which is handy for
 * post-mortem debugging.
 */
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  INTEGRATION_TENANT_SLUG
} from "./helpers/env.ts";
import { createRestClient, signIn } from "./helpers/api.ts";

export default async function globalTeardown(): Promise<void> {
  if (process.env.KEEP_INTEGRATION_TENANT === "1") {
    console.log(
      `[playwright/teardown] KEEP_INTEGRATION_TENANT=1 set; leaving "${INTEGRATION_TENANT_SLUG}" tenant in place`
    );
    return;
  }
  let token: string;
  try {
    ({ token } = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD));
  } catch (error) {
    console.warn(
      `[playwright/teardown] could not sign in to clean up tenant (${
        (error as Error).message
      }) — leaving any stale rows behind`
    );
    return;
  }
  const client = createRestClient(token);
  let tenants: Array<{ id: string; slug: string }>;
  try {
    const list = await client.request<{
      tenants: Array<{ id: string; slug: string }>;
    }>("GET", "/api/tenants");
    tenants = list.tenants;
  } catch (error) {
    console.warn(`[playwright/teardown] tenant list failed: ${(error as Error).message}`);
    return;
  }
  const tenant = tenants.find((t) => t.slug === INTEGRATION_TENANT_SLUG);
  if (tenant) {
    try {
      // Intentionally NOT scoping the request to the tenant we're about to
      // delete — the API stamps audit_logs.tenant_id from the request
      // principal's tenantId, and once the tenant row is gone that FK
      // points at nothing and the audit insert blows up the transaction.
      // The bootstrap admin doesn't need x-tenant-id to authorize this.
      await client.request("DELETE", `/api/tenants/${tenant.id}`, undefined, {
        tenantId: ""
      });
      console.log(
        `[playwright/teardown] deleted "${INTEGRATION_TENANT_SLUG}" tenant ${tenant.id}`
      );
    } catch (error) {
      console.warn(
        `[playwright/teardown] DELETE /api/tenants/${tenant.id} failed: ${
          (error as Error).message
        }`
      );
    }
  } else {
    console.log(
      `[playwright/teardown] no "${INTEGRATION_TENANT_SLUG}" tenant found`
    );
  }

  // Pipelines are global rows — the tenant CASCADE doesn't sweep them.
  // Clean up anything the suite created (slug prefix `pw_integration_`)
  // so re-runs don't 409 on the next POST.
  try {
    const list = await client.request<{
      pipelines: Array<{ id: string; slug: string }>;
    }>("GET", "/api/pipelines");
    const orphans = list.pipelines.filter((p) =>
      p.slug.startsWith("pw_integration_")
    );
    for (const p of orphans) {
      try {
        await client.request("DELETE", `/api/pipelines/${p.id}`);
      } catch (error) {
        console.warn(
          `[playwright/teardown] DELETE /api/pipelines/${p.id} (${p.slug}) failed: ${
            (error as Error).message
          }`
        );
      }
    }
    if (orphans.length > 0) {
      console.log(
        `[playwright/teardown] cleaned ${orphans.length} orphan pipeline${
          orphans.length === 1 ? "" : "s"
        }`
      );
    }
  } catch (error) {
    console.warn(
      `[playwright/teardown] pipeline cleanup failed: ${(error as Error).message}`
    );
  }
}
