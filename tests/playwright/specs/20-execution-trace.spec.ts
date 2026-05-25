/**
 * Execution trace endpoint contracts.
 *
 * Live executions exist on the dev stack already (system sweeps run on
 * cadence too, but those aren't exec-store rows — only `run_pipeline`
 * jobs land in executions). When a trace exists, the shape carries an
 * execution + nodes array.
 */
import { test, expect } from "../helpers/fixtures.ts";

test.describe("execution trace", () => {
  test("/api/executions/:id/trace returns execution + nodes when present", async ({
    rest
  }) => {
    const page = await rest.request<{
      executions: Array<{ executionId: string; status: string }>;
    }>("GET", "/api/executions?limit=5");
    if (page.executions.length === 0) {
      test.info().annotations.push({
        type: "skip",
        description: "no executions present on this stack — trace shape untestable"
      });
      return;
    }
    const sample = page.executions[0];
    const trace = await rest.request<{
      execution: { executionId: string; status: string };
      nodes: Array<{ nodeId: string; status: string }>;
    }>("GET", `/api/executions/${sample.executionId}/trace`);
    expect(trace.execution.executionId).toBe(sample.executionId);
    expect(Array.isArray(trace.nodes)).toBe(true);
  });

  test("clicking View trace in the UI opens the detail panel", async ({
    page,
    rest
  }) => {
    const list = await rest.request<{
      executions: Array<{ executionId: string }>;
    }>("GET", "/api/executions?limit=1");
    if (list.executions.length === 0) {
      test.info().annotations.push({
        type: "skip",
        description: "no executions present"
      });
      return;
    }
    await page.goto("/executions");
    // The first row's "View trace" button.
    const viewBtn = page.getByRole("button", { name: /View trace/ }).first();
    await expect(viewBtn).toBeVisible({ timeout: 15_000 });
    await viewBtn.click();
    // After click, the detail header H2 should appear.
    await expect(
      page.getByRole("heading", { name: /Execution\s+/ })
    ).toBeVisible({ timeout: 10_000 });
  });
});
