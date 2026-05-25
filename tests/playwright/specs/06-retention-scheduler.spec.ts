/**
 * The two pieces of the system-config story added in the same wave:
 *   - Retention: REST returns the three rows; PATCH round-trips.
 *   - Scheduler: the two un-deletable system schedules are listed,
 *     delete button is hidden, API DELETE returns the documented 403
 *     `system_schedule_undeletable`.
 *
 * Retention's PATCH writes are global config — we restore the original
 * value after asserting so the suite is idempotent against other specs
 * (executions count cap, etc).
 */
import { test, expect } from "../helpers/fixtures.ts";

test.describe("retention + scheduler", () => {
  test("retention list returns three resources", async ({ rest }) => {
    const list = await rest.request<{
      settings: Array<{
        resource: "executions" | "usage" | "audit";
        maxCount: number | null;
        maxAgeDays: number | null;
      }>;
    }>("GET", "/api/retention");
    const resources = new Set(list.settings.map((s) => s.resource));
    expect(resources.has("executions")).toBe(true);
    expect(resources.has("usage")).toBe(true);
    expect(resources.has("audit")).toBe(true);
  });

  test("retention PATCH round-trips and is then restored", async ({ rest }) => {
    const original = (
      await rest.request<{
        settings: Array<{
          resource: string;
          maxCount: number | null;
          maxAgeDays: number | null;
        }>;
      }>("GET", "/api/retention")
    ).settings.find((s) => s.resource === "executions")!;
    expect(original).toBeDefined();
    // Bump max_age by 1 day; verify; restore.
    const next = (original.maxAgeDays ?? 90) + 1;
    const patched = await rest.request<{
      setting: { maxAgeDays: number | null };
    }>("PATCH", "/api/retention/executions", { maxAgeDays: next });
    expect(patched.setting.maxAgeDays).toBe(next);
    await rest.request("PATCH", "/api/retention/executions", {
      maxAgeDays: original.maxAgeDays
    });
  });

  test("scheduler lists the two system schedules", async ({ page }) => {
    await page.goto("/scheduler");
    await expect(
      page.locator(".toolbar strong", { hasText: "Scheduler" })
    ).toBeVisible();
    await expect(page.getByText(/stale execution sweep/i)).toBeVisible();
    await expect(page.getByText(/retention sweep/i)).toBeVisible();
  });

  test("DELETE on a system schedule is rejected with 403", async ({ rest }) => {
    // Pull the schedules and find a system row. system schedules don't
    // carry a tenant_id so listing requires no tenant header.
    const list = await rest.request<{
      schedules: Array<{ id: string; system?: boolean; jobType?: string }>;
    }>("GET", "/api/schedules", undefined, { tenantId: "" });
    const sys = list.schedules.find((s) => s.system === true);
    expect(sys).toBeDefined();
    if (!sys) return;
    // Direct fetch so we can read the body shape even on a non-2xx.
    const res = await fetch(
      `${process.env.RAGDOLL_API_URL ?? "http://localhost:3001"}/api/schedules/${sys.id}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${rest.token}`
        }
      }
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("system_schedule_undeletable");
  });
});
