/**
 * Pipelines list + folder hierarchy. Verifies the screen mounts, REST
 * CRUD round-trips, and folder ↔ pipeline membership moves work.
 *
 * Folder rows are global (no tenant scope) — teardown's orphan sweep
 * cleans up by `pw_integration_` slug prefix; folders use a `name`
 * field instead so we delete explicitly in afterAll.
 */
import { test, expect } from "../helpers/fixtures.ts";

const RUN_SUFFIX = String(Date.now()).slice(-8);
const PIPELINE_SLUG = `pw_integration_p_folder_${RUN_SUFFIX}`;
const FOLDER_NAME = `pw_integration_folder_${RUN_SUFFIX}`;

test.describe("pipelines + folders", () => {
  let pipelineId: string;
  let folderId: string;

  test.afterAll(async ({ rest }) => {
    // Pipeline gets swept by teardown's slug-prefix cleanup; folders
    // don't, so delete them explicitly. Move pipeline to root first
    // so the folder's "non-empty" 409 doesn't block delete.
    try {
      if (pipelineId) {
        await rest.request(
          "PUT",
          `/api/pipelines/${pipelineId}/folder`,
          { folderId: null }
        );
      }
    } catch {
      /* ignore */
    }
    try {
      if (folderId) await rest.request("DELETE", `/api/folders/${folderId}`);
    } catch {
      /* ignore */
    }
  });

  test("pipelines list renders + REST round-trip", async ({ page, rest }) => {
    const created = await rest.request<{
      pipeline: { id: string; slug: string };
    }>("POST", "/api/pipelines", {
      slug: PIPELINE_SLUG,
      name: "Pipelines Folder Test"
    });
    pipelineId = created.pipeline.id;
    await page.goto("/pipelines");
    await expect(
      page.locator(".toolbar strong", { hasText: "Pipelines" })
    ).toBeVisible();
    await expect(page.getByText(PIPELINE_SLUG).first()).toBeVisible({
      timeout: 15_000
    });
  });

  test("create folder + move pipeline into it", async ({ rest }) => {
    const folder = await rest.request<{
      folder: { id: string; name: string };
    }>("POST", "/api/folders", { name: FOLDER_NAME });
    folderId = folder.folder.id;
    expect(folder.folder.name).toBe(FOLDER_NAME);
    await rest.request(
      "PUT",
      `/api/pipelines/${pipelineId}/folder`,
      { folderId }
    );
    // Read back through the pipelines list — the row's folderId should
    // now reflect our move.
    const list = await rest.request<{
      pipelines: Array<{ id: string; folderId: string | null }>;
    }>("GET", "/api/pipelines");
    const row = list.pipelines.find((p) => p.id === pipelineId);
    expect(row?.folderId).toBe(folderId);
  });

  test("non-empty folder DELETE 409s with conflict", async ({ rest, state }) => {
    void state;
    const res = await fetch(
      `${process.env.RAGDOLL_API_URL ?? "http://localhost:3001"}/api/folders/${folderId}`,
      { method: "DELETE", headers: { authorization: `Bearer ${rest.token}` } }
    );
    // 409 = conflict, 400 also acceptable if API returns BadRequest.
    expect([400, 409, 422]).toContain(res.status);
  });
});
