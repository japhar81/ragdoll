/**
 * Playwright integration suite.
 *
 * Drives the locally-running stack (`make refresh`) against a tenant named
 * `integration_testing` that's created on globalSetup and nuked on
 * globalTeardown — so re-running the suite is idempotent regardless of
 * pass / fail. The browser tests share a stored session minted once during
 * setup (admin@ragdoll.local / ragdoll-admin) so each test starts already
 * authenticated.
 *
 * Run with:
 *   npm run test:playwright
 *
 * Stack must be up:
 *   make refresh
 */
import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.RAGDOLL_WEB_URL ?? "http://localhost:8088";

export default defineConfig({
  testDir: "./specs",
  // Persist auth + scratch state next to the specs so cleanup is local.
  outputDir: "./.test-output",
  fullyParallel: false,
  // Hand-rolled sequential ordering: builder.spec depends on dataset.spec
  // having created the slug it pins, etc. Workers stay at 1 so a flaky
  // test can't trip a parallel one against the same tenant.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    storageState: "./.test-output/storage-state.json"
  },
  globalSetup: "./globalSetup.ts",
  globalTeardown: "./globalTeardown.ts",
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
