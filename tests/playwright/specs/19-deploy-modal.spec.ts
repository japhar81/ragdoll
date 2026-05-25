/**
 * Deploy modal flows.
 *
 * Build a pipeline whose spec pins a dataset slug, navigate to the
 * builder, open the Run modal, and assert the slot row renders. We
 * don't actually fire the run (no provider / live worker integration
 * here); the contract under test is "modal opens for a pipeline with
 * pinned slugs and lists the slot".
 *
 * Also asserts the modal is SKIPPED automatically when the pipeline
 * has no dataset slots — Run goes straight to the run path.
 */
import { test, expect } from "../helpers/fixtures.ts";

const RUN_SUFFIX = String(Date.now()).slice(-8);
const SLUGGED_PIPELINE = `pw_integration_slug_${RUN_SUFFIX}`;
const SLOTLESS_PIPELINE = `pw_integration_nosl_${RUN_SUFFIX}`;
const DATASET_SLUG = `pw_integration_deploy_${RUN_SUFFIX}`;

test.describe("deploy modal", () => {
  let sluggedId: string;
  let slotlessId: string;

  test.beforeAll(async ({ rest, state }) => {
    // Dataset to satisfy the slot.
    await rest.request("POST", "/api/datasets", {
      scope: "global",
      slug: DATASET_SLUG,
      displayName: "Deploy Test",
      modalities: ["vector"],
      backends: { vector: { provider: "qdrant" } }
    });
    // Pipeline that pins it.
    const a = await rest.request<{ pipeline: { id: string } }>(
      "POST",
      "/api/pipelines",
      { slug: SLUGGED_PIPELINE, name: "Slug Pipeline" }
    );
    sluggedId = a.pipeline.id;
    await rest.request("POST", `/api/pipelines/${sluggedId}/versions`, {
      version: "1.0.0",
      spec: {
        apiVersion: "rag-platform/v1",
        kind: "Pipeline",
        metadata: { name: SLUGGED_PIPELINE },
        spec: {
          nodes: [
            { id: "in", type: "input" },
            {
              id: "retrieve",
              plugin: {
                category: "retriever",
                id: "qdrant_retriever",
                version: "1.0.0"
              },
              dataset: { slug: DATASET_SLUG, alias: "stable" },
              config: {}
            },
            { id: "out", type: "output" }
          ],
          edges: [
            { from: "in", to: "retrieve" },
            { from: "retrieve", to: "out" }
          ]
        }
      },
      publish: true
    });
    // Pipeline with no dataset slots (input → output).
    const b = await rest.request<{ pipeline: { id: string } }>(
      "POST",
      "/api/pipelines",
      { slug: SLOTLESS_PIPELINE, name: "Slotless Pipeline" }
    );
    slotlessId = b.pipeline.id;
    await rest.request("POST", `/api/pipelines/${slotlessId}/versions`, {
      version: "1.0.0",
      spec: {
        apiVersion: "rag-platform/v1",
        kind: "Pipeline",
        metadata: { name: SLOTLESS_PIPELINE },
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
    void state;
  });

  test("Run button opens the deploy modal listing the dataset slot", async ({
    page
  }) => {
    await page.goto(`/builder/${sluggedId}`);
    // Wait for the builder to load + the deploy/run buttons to mount.
    await expect(
      page.getByRole("button", { name: /^Run$/ })
    ).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: /^Run$/ }).click();
    await expect(page.locator(".deploy-modal")).toBeVisible();
    // The modal headers carry the pipeline slug as a code element.
    await expect(page.locator(".deploy-modal code", { hasText: SLUGGED_PIPELINE })).toBeVisible();
    // The slot row carries the dataset slug.
    await expect(
      page.locator(".deploy-modal code", { hasText: DATASET_SLUG })
    ).toBeVisible();
  });

  test("Run on a slotless pipeline skips the modal (no slot to wire)", async ({
    page
  }) => {
    await page.goto(`/builder/${slotlessId}`);
    await expect(
      page.getByRole("button", { name: /^Run$/ })
    ).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: /^Run$/ }).click();
    // The deploy modal should NOT appear — no slots means no wiring step.
    // Give the UI a beat to potentially open it.
    await page.waitForTimeout(700);
    await expect(page.locator(".deploy-modal")).toBeHidden();
  });
});
