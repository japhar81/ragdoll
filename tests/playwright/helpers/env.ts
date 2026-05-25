/**
 * Shared env helpers for Playwright globalSetup / teardown / specs.
 *
 * Centralizes the locally-running stack URLs + bootstrap admin creds so the
 * tests aren't littered with hardcoded strings. `INTEGRATION_TENANT_SLUG`
 * is the unique fingerprint our setup uses; teardown looks rows up by slug
 * (instead of stashed id) so a botched prior run still gets cleaned up.
 */
export const WEB_URL = process.env.RAGDOLL_WEB_URL ?? "http://localhost:8088";
export const API_URL = process.env.RAGDOLL_API_URL ?? "http://localhost:3001";
export const ADMIN_EMAIL =
  process.env.RAGDOLL_TEST_ADMIN_EMAIL ?? "admin@ragdoll.local";
export const ADMIN_PASSWORD =
  process.env.RAGDOLL_TEST_ADMIN_PASSWORD ?? "ragdoll-admin";
export const INTEGRATION_TENANT_SLUG = "integration_testing";
export const INTEGRATION_TENANT_NAME = "Integration Testing";

/** Path under .test-output where globalSetup persists the API token + tenant id
 *  so each spec can read them without re-authenticating. */
export const STATE_PATH = "./tests/playwright/.test-output/integration-state.json";
