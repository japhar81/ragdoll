/**
 * Users + grants: create a throwaway user, grant them a tenant-scoped
 * role, list their grants, revoke, delete the user. Idempotent across
 * re-runs via the per-run email suffix.
 */
import { test, expect } from "../helpers/fixtures.ts";

const RUN_SUFFIX = String(Date.now()).slice(-8);
const EMAIL = `pw_integration_user_${RUN_SUFFIX}@example.com`;

test.describe("users + grants", () => {
  let userId: string;

  test("create user via REST + appears in /users grid", async ({
    page,
    rest
  }) => {
    const created = await rest.request<{
      user: { id: string; email: string };
    }>("POST", "/api/users", {
      email: EMAIL,
      password: "ragdoll-pw-12345",
      displayName: "PW Integration"
    });
    userId = created.user.id;
    expect(created.user.email).toBe(EMAIL);
    await page.goto("/users");
    await expect(
      page.locator(".toolbar strong", { hasText: "Users" })
    ).toBeVisible();
    await expect(page.getByText(EMAIL).first()).toBeVisible({
      timeout: 15_000
    });
  });

  test("grant a tenant-scoped role, list, revoke", async ({ rest, state }) => {
    const grant = await rest.request<{
      grant: { id: string; role: string; tenantId: string | null };
    }>("POST", `/api/users/${userId}/grants`, {
      role: "viewer",
      tenantId: state.tenantId
    });
    expect(grant.grant.role).toBe("viewer");
    expect(grant.grant.tenantId).toBe(state.tenantId);
    const list = await rest.request<{
      grants: Array<{ id: string; role: string }>;
    }>("GET", `/api/users/${userId}/grants`);
    expect(list.grants.some((g) => g.id === grant.grant.id)).toBe(true);
    await rest.request(
      "DELETE",
      `/api/users/${userId}/grants/${grant.grant.id}`
    );
    const after = await rest.request<{
      grants: Array<{ id: string }>;
    }>("GET", `/api/users/${userId}/grants`);
    expect(after.grants.some((g) => g.id === grant.grant.id)).toBe(false);
  });

  test("delete user via REST", async ({ rest }) => {
    await rest.request("DELETE", `/api/users/${userId}`);
    const list = await rest.request<{
      users: Array<{ id: string }>;
    }>("GET", "/api/users");
    expect(list.users.some((u) => u.id === userId)).toBe(false);
  });
});
