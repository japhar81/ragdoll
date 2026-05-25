/**
 * Config values at tenant scope. Upsert + list at the integration tenant
 * scope; ensure the value lands and the values listing returns it.
 */
import { test, expect } from "../helpers/fixtures.ts";

const RUN_SUFFIX = String(Date.now()).slice(-8);
const KEY = `pw.integration.key.${RUN_SUFFIX}`;

test.describe("config values", () => {
  test("upsert at tenant scope and read it back", async ({ rest, state }) => {
    // config_values.key has an FK to config_definitions — register the
    // key first so the upsert lands.
    await rest.request("PUT", `/api/config/definitions/${KEY}`, {
      type: "string",
      allowedScopes: ["global", "tenant"],
      tenantOverridable: true
    });
    await rest.request("POST", "/api/config/values", {
      key: KEY,
      value: "integration-test-value",
      scope: "tenant",
      scopeId: state.tenantId
    });
    const list = await rest.request<{
      values: Array<{ key: string; value: unknown; scope: string }>;
    }>(
      "GET",
      `/api/config/values?scope=tenant&scope_id=${state.tenantId}`,
      undefined,
      { tenantId: state.tenantId }
    );
    const found = list.values.find((v) => v.key === KEY);
    expect(found).toBeDefined();
    expect(found?.scope).toBe("tenant");
  });

  test("config definitions endpoint lists known keys", async ({ rest }) => {
    const defs = await rest.request<{
      definitions: Array<{ key: string; type: string }>;
    }>("GET", "/api/config/definitions");
    expect(Array.isArray(defs.definitions)).toBe(true);
  });

  test("Config screen mounts + shows scope tree", async ({ page }) => {
    await page.goto("/config");
    await expect(
      page.locator(".toolbar strong", { hasText: "Config" })
    ).toBeVisible();
    await expect(page.locator(".scope-tree")).toBeVisible();
  });
});
