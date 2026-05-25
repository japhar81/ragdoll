/**
 * Secrets: create at tenant scope, list shows REDACTED values only.
 * Cascade-deletes with the tenant on teardown.
 */
import { test, expect } from "../helpers/fixtures.ts";

const RUN_SUFFIX = String(Date.now()).slice(-8);
const SECRET_KEY = `pw.test.${RUN_SUFFIX}`;

test.describe("secrets", () => {
  test("create at tenant scope; value is REDACTED on list", async ({
    rest,
    state
  }) => {
    const created = await rest.request<{
      secret: { id: string; value: string };
    }>("POST", "/api/secrets", {
      key: SECRET_KEY,
      value: "supersecret",
      scope: "tenant",
      tenantId: state.tenantId
    });
    expect(created.secret.value).toBe("REDACTED");
    const list = await rest.request<{
      secrets: Array<{ id: string; value: string }>;
    }>("GET", "/api/secrets", undefined, { tenantId: state.tenantId });
    const stored = list.secrets.find((s) => s.id === created.secret.id);
    expect(stored).toBeDefined();
    expect(stored?.value).toBe("REDACTED");
  });

  test("Secrets screen mounts + shows the scope tree", async ({ page }) => {
    await page.goto("/secrets");
    await expect(
      page.locator(".toolbar strong", { hasText: "Secrets" })
    ).toBeVisible();
    await expect(page.locator(".scope-tree")).toBeVisible();
    await expect(page.getByText(/values never displayed/i)).toBeVisible();
  });
});
