/**
 * Profile + API keys. Mints a short-lived API key for the bootstrap
 * admin, verifies the plaintext is returned only on create, lists it,
 * and revokes. Cleanup is in afterAll so a failed assertion doesn't
 * leak a key that would still authenticate.
 */
import { test, expect } from "../helpers/fixtures.ts";

const RUN_SUFFIX = String(Date.now()).slice(-8);
const KEY_NAME = `pw_integration_key_${RUN_SUFFIX}`;

test.describe("profile + api keys", () => {
  let keyId: string;

  test.afterAll(async ({ rest }) => {
    try {
      if (keyId) await rest.request("DELETE", `/api/api-keys/${keyId}`);
    } catch {
      /* ignore */
    }
  });

  test("create API key returns plaintext exactly once", async ({ rest }) => {
    const created = await rest.request<{
      apiKey: { id: string; name: string; prefix?: string };
      plaintext?: string;
    }>("POST", "/api/api-keys", {
      name: KEY_NAME,
      role: "viewer"
    });
    keyId = created.apiKey.id;
    expect(created.apiKey.name).toBe(KEY_NAME);
    // The plaintext key should be in the create response and start with
    // the `rgd_` prefix used by the API key middleware.
    expect(typeof created.plaintext === "string").toBe(true);
    expect(created.plaintext?.startsWith("rgd_")).toBe(true);
    // It MUST NOT be returned on subsequent list calls.
    const list = await rest.request<{
      apiKeys: Array<{ id: string; plaintext?: string }>;
    }>("GET", "/api/api-keys");
    const stored = list.apiKeys.find((k) => k.id === keyId);
    expect(stored).toBeDefined();
    expect(stored?.plaintext).toBeUndefined();
  });

  test("revoked key returns 401 on subsequent use", async ({ rest, state }) => {
    void state;
    if (!keyId) return; // skip if prior test bailed
    // Get the plaintext fresh by minting another short-lived key.
    const tmp = await rest.request<{
      apiKey: { id: string };
      plaintext: string;
    }>("POST", "/api/api-keys", {
      name: `${KEY_NAME}_revoketest`,
      role: "viewer"
    });
    const plaintext = tmp.plaintext;
    // Revoke it.
    await rest.request("DELETE", `/api/api-keys/${tmp.apiKey.id}`);
    // Now an attempt to authenticate with it should fail.
    const res = await fetch(
      `${process.env.RAGDOLL_API_URL ?? "http://localhost:3001"}/api/auth/me`,
      { headers: { authorization: `Bearer ${plaintext}` } }
    );
    expect([401, 403]).toContain(res.status);
  });

  test("Profile screen mounts + lists API keys", async ({ page }) => {
    await page.goto("/profile");
    await expect(page.getByText(/API keys/i).first()).toBeVisible({
      timeout: 15_000
    });
  });
});
