/**
 * Identity Providers — create OIDC, list, toggle enabled, delete.
 * Globally-scoped rows; per-run slug suffix keeps idempotent.
 */
import { test, expect } from "../helpers/fixtures.ts";

const RUN_SUFFIX = String(Date.now()).slice(-8);
const SLUG = `pw_integration_idp_${RUN_SUFFIX}`;

test.describe("identity providers", () => {
  let providerId: string;

  test.afterAll(async ({ rest }) => {
    try {
      if (providerId)
        await rest.request("DELETE", `/api/identity-providers/${providerId}`);
    } catch {
      /* ignore */
    }
  });

  test("create OIDC + appears in the grid", async ({ page, rest }) => {
    const created = await rest.request<{
      provider: { id: string; slug: string; kind: string };
    }>("POST", "/api/identity-providers", {
      slug: SLUG,
      kind: "oidc",
      displayName: "PW Integration OIDC",
      config: {
        issuer: "https://example.invalid/oidc",
        clientId: "pw-test",
        clientSecret: "pw-secret",
        scopes: "openid profile email"
      }
    });
    providerId = created.provider.id;
    expect(created.provider.kind).toBe("oidc");
    await page.goto("/identity-providers");
    await expect(
      page.locator(".toolbar strong", { hasText: "Identity Providers" })
    ).toBeVisible();
    await expect(page.getByText(SLUG).first()).toBeVisible();
  });

  test("toggle enabled false then true round-trips", async ({ rest }) => {
    const off = await rest.request<{
      provider: { enabled: boolean };
    }>("PUT", `/api/identity-providers/${providerId}`, { enabled: false });
    expect(off.provider.enabled).toBe(false);
    const on = await rest.request<{
      provider: { enabled: boolean };
    }>("PUT", `/api/identity-providers/${providerId}`, { enabled: true });
    expect(on.provider.enabled).toBe(true);
  });
});
