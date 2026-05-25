/**
 * Datasets CRUD: create a tenant-scoped slug, confirm it lands on the
 * Datasets grid, extend it with a second backend via PATCH, confirm the
 * detail panel reflects both modalities. All tenant-scoped writes carry
 * the integration_testing tenant via x-tenant-id so teardown's cascade
 * delete cleans up everything we make here.
 */
import { test, expect } from "../helpers/fixtures.ts";

// Datasets live under the integration_testing tenant so teardown's
// cascade nukes them. Even so, the unique suffix means a re-run survives
// a botched prior teardown without 409ing on the next setup.
const RUN_SUFFIX = String(Date.now()).slice(-8);
const SLUG = `pw_integration_corpus_${RUN_SUFFIX}`;
const THROWAWAY_SLUG = `pw_integration_throwaway_${RUN_SUFFIX}`;

test.describe("datasets", () => {
  test("create + add-backend round-trip via REST and surface in UI", async ({
    page,
    state,
    rest
  }) => {
    // REST: create at tenant scope with the vector backend only.
    const created = await rest.request<{
      dataset: { id: string; slug: string; modalities: string[] };
    }>("POST", "/api/datasets", {
      scope: "tenant",
      tenantId: state.tenantId,
      slug: SLUG,
      displayName: "Integration Corpus",
      modalities: ["vector"],
      backends: { vector: { provider: "qdrant" } }
    });
    expect(created.dataset.modalities).toContain("vector");
    const datasetId = created.dataset.id;

    // UI: open Datasets, our row should be in the grid. The
    // datasets-all query fetches per-tenant lists, so this also
    // implicitly proves the integration tenant is visible to the
    // principal.
    await page.goto("/datasets");
    await expect(page.getByText(SLUG).first()).toBeVisible({ timeout: 15_000 });

    // PATCH: add the text backend. The picker / deploy modal use exactly
    // this shape elsewhere; we're exercising the API contract straight.
    const patched = await rest.request<{
      dataset: { modalities: string[]; backends: Record<string, unknown> };
    }>(
      "PATCH",
      `/api/datasets/${datasetId}`,
      {
        modalities: ["vector", "text"],
        backends: {
          vector: { provider: "qdrant" },
          text: { provider: "opensearch" }
        }
      },
      { tenantId: state.tenantId }
    );
    expect(patched.dataset.modalities).toEqual(
      expect.arrayContaining(["vector", "text"])
    );

    // UI again: open the row's detail; both modalities should be on screen.
    await page.goto(`/datasets/${datasetId}`);
    await expect(page.getByText("vector, text").first()).toBeVisible({
      timeout: 10_000
    });
    await expect(
      page.getByText(/vector: qdrant.*text: opensearch|text: opensearch.*vector: qdrant/)
    ).toBeVisible();
  });

  test("delete from REST removes the row from the grid", async ({
    page,
    rest,
    state
  }) => {
    // Create + delete a throwaway so we can prove the grid mutation
    // path. Uses a tenant-scoped slug so we don't collide with the
    // first test's row.
    const throwaway = await rest.request<{ dataset: { id: string; slug: string } }>(
      "POST",
      "/api/datasets",
      {
        scope: "tenant",
        tenantId: state.tenantId,
        slug: THROWAWAY_SLUG,
        displayName: "Throwaway",
        modalities: ["vector"],
        backends: { vector: { provider: "qdrant" } }
      }
    );
    await rest.request("DELETE", `/api/datasets/${throwaway.dataset.id}`, undefined, {
      tenantId: state.tenantId
    });
    await page.goto("/datasets");
    // Wait for the React Query refetch to land. We give it up to 15s but
    // expect it sub-second in practice.
    await expect(
      page.getByText(throwaway.dataset.slug)
    ).toBeHidden({ timeout: 15_000 });
  });
});
