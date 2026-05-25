/**
 * Builder UI flows that don't require ReactFlow drag-drop.
 * Exercises:
 *   - opening an existing pipeline by id loads its spec
 *   - the Details / Versioning toolbar menus appear and are interactive
 *   - the pipeline-level "Datasets" tab (added in the dataset wave) opens
 *     and renders the right empty state when no slot is pinned
 */
import { test, expect } from "../helpers/fixtures.ts";

const RUN_SUFFIX = String(Date.now()).slice(-8);
const PIPELINE_SLUG = `pw_integration_builder_${RUN_SUFFIX}`;

test.describe("builder UI", () => {
  let pipelineId: string;

  test.beforeAll(async ({ rest }) => {
    const created = await rest.request<{ pipeline: { id: string } }>(
      "POST",
      "/api/pipelines",
      {
        slug: PIPELINE_SLUG,
        name: "Builder UI Test"
      }
    );
    pipelineId = created.pipeline.id;
    await rest.request("POST", `/api/pipelines/${pipelineId}/versions`, {
      version: "1.0.0",
      spec: {
        apiVersion: "rag-platform/v1",
        kind: "Pipeline",
        metadata: { name: PIPELINE_SLUG },
        spec: {
          nodes: [
            { id: "in", type: "input" },
            { id: "out", type: "output" }
          ],
          edges: [{ from: "in", to: "out" }]
        }
      },
      publish: true
    });
  });

  test("opening a pipeline route renders its slug in the toolbar", async ({
    page
  }) => {
    await page.goto(`/builder/${pipelineId}`);
    await expect(
      page
        .locator(`input[value*="${PIPELINE_SLUG}"]`)
        .first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("Datasets inspector tab opens with empty state", async ({ page }) => {
    await page.goto(`/builder/${pipelineId}`);
    // Wait for the inspector to mount.
    await expect(page.getByRole("tab", { name: /Datasets/ })).toBeVisible({
      timeout: 15_000
    });
    await page.getByRole("tab", { name: /Datasets/ }).click();
    // No nodes pin a slug, so the empty-state copy should appear.
    await expect(
      page.getByText(/doesn't pin any datasets yet/i)
    ).toBeVisible();
  });

  test("Versioning menu exposes Save Draft / Publish", async ({ page }) => {
    await page.goto(`/builder/${pipelineId}`);
    await page.getByRole("button", { name: /Versioning/ }).click();
    await expect(
      page.getByRole("button", { name: /Save Draft/ }).first()
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Publish/ }).first()
    ).toBeVisible();
  });
});
