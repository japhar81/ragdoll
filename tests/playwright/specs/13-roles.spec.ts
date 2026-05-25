/**
 * Roles & Permissions screen. Verify the built-in roles list returns,
 * the all-permissions catalog is non-empty, and the UI renders.
 */
import { test, expect } from "../helpers/fixtures.ts";

test.describe("roles & permissions", () => {
  test("list returns the builtin roles + permissions catalog", async ({
    rest
  }) => {
    const res = await rest.request<{
      roles: Array<{ name: string; permissions: string[]; builtin?: boolean }>;
      allPermissions?: string[];
    }>("GET", "/api/roles");
    expect(res.roles.length).toBeGreaterThan(0);
    // Common platform roles should be present.
    const names = new Set(res.roles.map((r) => r.name));
    expect(names.has("platform_admin") || names.has("admin")).toBe(true);
    if (res.allPermissions) {
      expect(res.allPermissions.length).toBeGreaterThan(0);
    }
  });

  test("Roles screen mounts", async ({ page }) => {
    await page.goto("/roles");
    await expect(
      page.locator(".toolbar strong", { hasText: /Roles/i })
    ).toBeVisible();
  });
});
