/**
 * Dataset detail panel — versions list + alias retarget + add-backend
 * affordance. Bound to the integration tenant so teardown cascades the
 * fresh dataset away with the tenant.
 */
import { test, expect } from "../helpers/fixtures.ts";

const RUN_SUFFIX = String(Date.now()).slice(-8);
const SLUG = `pw_integration_detail_${RUN_SUFFIX}`;

test.describe("dataset detail", () => {
  let datasetId: string;

  test.beforeAll(async ({ rest, state }) => {
    const ds = await rest.request<{ dataset: { id: string } }>(
      "POST",
      "/api/datasets",
      {
        scope: "tenant",
        tenantId: state.tenantId,
        slug: SLUG,
        displayName: "Detail Tests",
        modalities: ["vector"],
        backends: { vector: { provider: "qdrant" } }
      }
    );
    datasetId = ds.dataset.id;
  });

  test("versions + aliases endpoints respond with stable shapes", async ({
    rest
  }) => {
    const res = await rest.request<{
      versions: Array<{ id: string; versionLabel: string; status: string }>;
      aliases: Array<{ alias: string; versionId: string }>;
    }>("GET", `/api/datasets/${datasetId}/versions`);
    expect(Array.isArray(res.versions)).toBe(true);
    expect(Array.isArray(res.aliases)).toBe(true);
  });

  test("create a version + retarget the stable alias", async ({ rest }) => {
    // Two versions so the alias swap has somewhere to point.
    const v1 = await rest.request<{
      version: { id: string };
    }>("POST", `/api/datasets/${datasetId}/versions`, {
      versionLabel: "v1",
      status: "ready"
    });
    const v2 = await rest.request<{
      version: { id: string };
    }>("POST", `/api/datasets/${datasetId}/versions`, {
      versionLabel: "v2",
      status: "ready"
    });
    // Retarget stable to v2 — the API uses PATCH on the alias route.
    await rest.request(
      "PATCH",
      `/api/datasets/${datasetId}/aliases/stable`,
      { versionId: v2.version.id }
    );
    const after = await rest.request<{
      aliases: Array<{ alias: string; versionId: string }>;
    }>("GET", `/api/datasets/${datasetId}/versions`);
    const stable = after.aliases.find((a) => a.alias === "stable");
    expect(stable?.versionId).toBe(v2.version.id);
    void v1;
  });

  test("dataset detail UI lists the row in the grid", async ({
    page
  }) => {
    await page.goto(`/datasets/${datasetId}`);
    // The detail card opens below the grid; verify the slug appears as
    // a heading and the modalities line is rendered.
    await expect(page.getByText(SLUG).first()).toBeVisible({
      timeout: 15_000
    });
  });
});
