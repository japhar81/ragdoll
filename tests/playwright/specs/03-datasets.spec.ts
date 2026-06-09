/**
 * Datasets CRUD (ADR-0023): create a tenant-scoped slug with an initial
 * binding, confirm it lands on the Datasets grid, extend with a second
 * binding via PATCH, confirm the detail panel reflects both bindings.
 * All tenant-scoped writes carry the integration_testing tenant via
 * x-tenant-id so teardown's cascade delete cleans up everything.
 */
import { test, expect } from "../helpers/fixtures.ts";

const RUN_SUFFIX = String(Date.now()).slice(-8);
const SLUG = `pw_integration_corpus_${RUN_SUFFIX}`;
const THROWAWAY_SLUG = `pw_integration_throwaway_${RUN_SUFFIX}`;

test.describe("datasets", () => {
  test("create + add-binding round-trip via REST and surface in UI", async ({
    page,
    state,
    rest
  }) => {
    // REST: create at tenant scope with the vectors binding only.
    const created = await rest.request<{
      dataset: {
        id: string;
        slug: string;
        bindings: Record<string, { connection?: string }>;
      };
    }>("POST", "/api/datasets", {
      scope: "tenant",
      tenantId: state.tenantId,
      slug: SLUG,
      displayName: "Integration Corpus",
      bindings: { vectors: { connection: "qdrant" } }
    });
    expect(Object.keys(created.dataset.bindings)).toContain("vectors");
    const datasetId = created.dataset.id;

    await page.goto("/datasets");
    await expect(page.getByText(SLUG).first()).toBeVisible({ timeout: 15_000 });

    // PATCH: add the text binding alongside the existing vectors slot.
    const patched = await rest.request<{
      dataset: { bindings: Record<string, { connection?: string }> };
    }>(
      "PATCH",
      `/api/datasets/${datasetId}`,
      {
        bindings: {
          vectors: { connection: "qdrant" },
          text: { connection: "opensearch" }
        }
      },
      { tenantId: state.tenantId }
    );
    expect(Object.keys(patched.dataset.bindings)).toEqual(
      expect.arrayContaining(["vectors", "text"])
    );

    // UI again: open the row's detail; both binding names should be on
    // screen in the bindings table.
    await page.goto(`/datasets/${datasetId}`);
    await expect(page.getByText("vectors").first()).toBeVisible({
      timeout: 10_000
    });
    await expect(page.getByText("text").first()).toBeVisible();
  });

  test("delete from REST removes the row from the grid", async ({
    page,
    rest,
    state
  }) => {
    const throwaway = await rest.request<{ dataset: { id: string; slug: string } }>(
      "POST",
      "/api/datasets",
      {
        scope: "tenant",
        tenantId: state.tenantId,
        slug: THROWAWAY_SLUG,
        displayName: "Throwaway",
        bindings: { vectors: { connection: "qdrant" } }
      }
    );
    await rest.request("DELETE", `/api/datasets/${throwaway.dataset.id}`, undefined, {
      tenantId: state.tenantId
    });
    await page.goto("/datasets");
    await expect(
      page.getByText(throwaway.dataset.slug)
    ).toBeHidden({ timeout: 15_000 });
  });
});
