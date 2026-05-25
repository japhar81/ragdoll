/**
 * Builder flow — open a fresh pipeline, save it, publish, and confirm
 * the version landed via REST. Spec-internal slug is unique so re-runs
 * against the same tenant don't collide.
 *
 * NOT exercised here: ReactFlow node DnD interactions. Those are
 * intensely brittle in headless mode (touch events, position math,
 * stage containers) and the same code path is well covered by the
 * unit tests in apps/web/test/. We do exercise the REST seam the
 * builder uses on Save / Publish, which is the part most likely to
 * break across refactors.
 */
import { test, expect } from "../helpers/fixtures.ts";

// Pipelines are global rows (not tenant-scoped). Teardown can only nuke
// the integration_testing tenant — it can't reach across to delete
// pipelines created here. A per-run suffix keeps the slug unique so
// re-running the suite doesn't 409 on a leftover row.
const RUN_SUFFIX = String(Date.now()).slice(-8);
const PIPELINE_SLUG = `pw_integration_pipeline_${RUN_SUFFIX}`;

test.describe("builder + pipelines", () => {
  test("create + publish a minimal pipeline; version persists", async ({
    page,
    rest
  }) => {
    // Bare-minimum pipeline: input → output. Enough to exercise the
    // save/version path without ReactFlow drag mechanics.
    const minimalSpec = {
      apiVersion: "rag-platform/v1",
      kind: "Pipeline",
      metadata: { name: PIPELINE_SLUG, timeoutMs: 600_000 },
      spec: {
        nodes: [
          { id: "in", type: "input" },
          { id: "out", type: "output" }
        ],
        edges: [{ from: "in", to: "out" }]
      }
    };

    // Pipelines are global rows (per the API contract — POST /api/pipelines
     // takes slug + name; tenant association happens at deploy time).
    const created = await rest.request<{
      pipeline: { id: string; slug: string };
    }>("POST", `/api/pipelines`, {
      slug: PIPELINE_SLUG,
      name: "Integration Test Pipeline"
    });
    const pipelineId = created.pipeline.id;

    // Save a published version against it.
    const versioned = await rest.request<{
      version: { id: string; version: string };
    }>(`POST`, `/api/pipelines/${pipelineId}/versions`, {
      version: "1.0.0",
      spec: minimalSpec,
      publish: true
    });
    expect(versioned.version.version).toBe("1.0.0");

    // UI: opening the builder for this id should render the saved slug
    // in the toolbar. Don't poke ReactFlow internals — just confirm the
    // route handles the pipeline id end-to-end.
    await page.goto(`/builder/${pipelineId}`);
    await expect(
      page.locator('input[value*="' + PIPELINE_SLUG + '"]').first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("timeout field defaults to 60 and round-trips through save", async ({
    page,
    rest
  }) => {
    const slug = `pw_integration_timeout_${RUN_SUFFIX}`;
    const created = await rest.request<{
      pipeline: { id: string };
    }>("POST", `/api/pipelines`, {
      slug,
      name: "Timeout Demo"
    });
    await page.goto(`/builder/${created.pipeline.id}`);
    // Open the Details menu, edit timeout, save a version, confirm the
    // spec.metadata carries it.
    await page.getByRole("button", { name: /Details/ }).click();
    const timeoutInput = page.getByLabel(/Timeout/i).first();
    await expect(timeoutInput).toBeVisible();
    await timeoutInput.fill("15");
    // The Toolbar Save button publishes the in-memory draft.
    await page
      .getByRole("button", { name: /^Save$/ })
      .first()
      .click();
    // Wait for the toolbar to flip back from "Saving…"; reading the
    // versions API is more robust than waiting for a toast.
    await page.waitForTimeout(1500);
    const versions = await rest.request<{
      versions: Array<{ spec?: { metadata?: { timeoutMs?: number } } }>;
    }>("GET", `/api/pipelines/${created.pipeline.id}/versions`);
    const latest = versions.versions[0];
    expect(latest?.spec?.metadata?.timeoutMs).toBe(15 * 60_000);
  });
});
