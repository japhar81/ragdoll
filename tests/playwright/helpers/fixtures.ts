/**
 * Per-spec fixtures.
 *
 * Layers a `state` (loaded from `.test-output/integration-state.json`) and
 * a Bearer-authenticated `rest` client on top of Playwright's `test`
 * object. A spec just imports `test` from here instead of from
 * `@playwright/test` and gets both fixtures for free.
 *
 * The browser session itself is loaded via `storageState` configured in
 * playwright.config.ts — every spec opens already signed in.
 */
import { readFile } from "node:fs/promises";
import { test as base } from "@playwright/test";
import { STATE_PATH } from "./env.ts";
import { createRestClient, type RestClient } from "./api.ts";

interface IntegrationState {
  token: string;
  principalId?: string;
  tenantId: string;
  tenantSlug: string;
  environment: string;
}

interface Fixtures {
  state: IntegrationState;
  rest: RestClient;
}

let cached: IntegrationState | undefined;
async function loadState(): Promise<IntegrationState> {
  if (cached) return cached;
  const raw = await readFile(STATE_PATH, "utf-8");
  cached = JSON.parse(raw) as IntegrationState;
  return cached;
}

export const test = base.extend<Fixtures>({
  state: async ({}, use) => {
    const state = await loadState();
    await use(state);
  },
  rest: async ({ state }, use) => {
    const client = createRestClient(state.token, state.tenantId);
    await use(client);
  }
});

export { expect } from "@playwright/test";
