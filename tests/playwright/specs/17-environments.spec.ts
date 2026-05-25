/**
 * Per-tenant environments. The integration_testing tenant already has
 * "dev" from globalSetup; create a second env, list, delete.
 */
import { test, expect } from "../helpers/fixtures.ts";

const RUN_SUFFIX = String(Date.now()).slice(-8);
const ENV_NAME = `pwint_${RUN_SUFFIX}`;

test.describe("environments", () => {
  test("create + list + delete a tenant environment", async ({
    rest,
    state
  }) => {
    const created = await rest.request<{
      environment: { id: string; name: string };
    }>(
      "POST",
      `/api/tenants/${state.tenantId}/environments`,
      { name: ENV_NAME },
      { tenantId: state.tenantId }
    );
    const envId = created.environment.id;
    expect(created.environment.name).toBe(ENV_NAME);

    const list = await rest.request<{
      environments: Array<{ id: string; name: string }>;
    }>(
      "GET",
      `/api/tenants/${state.tenantId}/environments`,
      undefined,
      { tenantId: state.tenantId }
    );
    expect(list.environments.some((e) => e.id === envId)).toBe(true);
    expect(list.environments.some((e) => e.name === "dev")).toBe(true);

    await rest.request(
      "DELETE",
      `/api/tenants/${state.tenantId}/environments/${envId}`,
      undefined,
      { tenantId: state.tenantId }
    );
    const after = await rest.request<{
      environments: Array<{ id: string }>;
    }>(
      "GET",
      `/api/tenants/${state.tenantId}/environments`,
      undefined,
      { tenantId: state.tenantId }
    );
    expect(after.environments.some((e) => e.id === envId)).toBe(false);
  });
});
