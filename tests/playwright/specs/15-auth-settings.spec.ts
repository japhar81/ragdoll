/**
 * Auth Settings — read current, toggle signup mode, restore.
 * Global config; we restore the original value so re-runs and other
 * specs see a stable baseline.
 */
import { test, expect } from "../helpers/fixtures.ts";

interface AuthSettings {
  signupMode?: string;
  defaultRole?: string | null;
}

test.describe("auth settings", () => {
  test("read + round-trip toggle + restore", async ({ rest }) => {
    const before = await rest.request<{ settings: AuthSettings }>(
      "GET",
      "/api/auth/settings"
    );
    const originalMode = before.settings.signupMode ?? "admin_only";
    const nextMode =
      originalMode === "admin_only" ? "open_no_access" : "admin_only";
    const updated = await rest.request<{ settings: AuthSettings }>(
      "PUT",
      "/api/auth/settings",
      { signupMode: nextMode }
    );
    expect(updated.settings.signupMode).toBe(nextMode);
    // Restore so other specs see the baseline mode.
    await rest.request("PUT", "/api/auth/settings", {
      signupMode: originalMode
    });
  });

  test("Auth Settings screen mounts", async ({ page }) => {
    await page.goto("/auth-settings");
    await expect(
      page.locator(".toolbar strong", { hasText: /Auth Settings/i })
    ).toBeVisible();
  });
});
