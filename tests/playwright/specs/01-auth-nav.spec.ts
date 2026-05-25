/**
 * Boot the SPA already signed in (via the storageState seeded in
 * globalSetup) and verify the nav contract — every sidebar group is
 * present and the recent Settings restructure landed (Users / Roles /
 * Identity Providers / Auth Settings / Retention all live under
 * Settings, not Access).
 *
 * If this spec breaks, every downstream spec breaks too — keep it cheap
 * + run first.
 */
import { test, expect } from "../helpers/fixtures.ts";

test.describe("auth + sidebar", () => {
  test("signed-in shell renders the expected nav groups", async ({ page }) => {
    await page.goto("/");
    // The sidebar groups are rendered as section labels — wait for the
    // app shell to mount rather than for a specific role/text so an
    // upstream change to the chrome doesn't flake this test.
    await expect(page.locator("nav, aside").first()).toBeVisible({
      timeout: 15_000
    });
    for (const group of ["Build", "Operate", "Govern", "Settings"]) {
      await expect(page.getByText(group, { exact: true }).first()).toBeVisible();
    }
  });

  test("Settings group contains Retention (post-restructure)", async ({
    page
  }) => {
    await page.goto("/");
    // Retention is the new one; the four pre-existing entries should
    // also be there. Use links to avoid matching the section header.
    for (const label of [
      "Users",
      "Roles & Permissions",
      "Identity Providers",
      "Auth Settings",
      "Retention"
    ]) {
      await expect(
        page.getByRole("link", { name: label, exact: true })
      ).toBeVisible();
    }
  });

  test("Retention link routes to the Retention screen", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Retention", exact: true }).click();
    await expect(page).toHaveURL(/\/retention$/);
    // The Screen chrome uses <strong> for the title, not <h1>; match by
    // text within the toolbar instead.
    await expect(
      page.locator(".toolbar strong", { hasText: "Retention" })
    ).toBeVisible();
    // Three resource rows are guaranteed by the 012 migration seed.
    // "Executions" appears twice on the page (sidebar link + table cell);
    // scope to the table to avoid the strict-mode collision.
    const rows = page.locator("table.grid tbody");
    for (const label of ["Executions", "Usage records", "Audit log"]) {
      await expect(rows.getByText(label, { exact: true })).toBeVisible();
    }
  });
});
