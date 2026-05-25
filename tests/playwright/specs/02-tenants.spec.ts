/**
 * The Tenants screen lists every tenant the principal can see. The
 * integration_testing tenant — created in globalSetup — must appear, and
 * its detail must round-trip through the API too.
 */
import { test, expect } from "../helpers/fixtures.ts";
import { INTEGRATION_TENANT_SLUG, INTEGRATION_TENANT_NAME } from "../helpers/env.ts";

test.describe("tenants screen", () => {
  test("integration tenant appears in the list and detail matches", async ({
    page,
    state,
    rest
  }) => {
    await page.goto("/tenants");
    await expect(
      page.locator(".toolbar strong", { hasText: "Tenants" })
    ).toBeVisible();
    // The slug is the unique fingerprint — use a row that contains it
    // rather than matching by display name (which an operator might rename).
    await expect(page.getByText(INTEGRATION_TENANT_SLUG).first()).toBeVisible();

    const tenant = await rest.request<{
      tenant: { id: string; slug: string; name: string };
    }>("GET", `/api/tenants/${state.tenantId}`, undefined, {
      tenantId: state.tenantId
    });
    expect(tenant.tenant.slug).toBe(INTEGRATION_TENANT_SLUG);
    expect(tenant.tenant.name).toBe(INTEGRATION_TENANT_NAME);
  });
});
