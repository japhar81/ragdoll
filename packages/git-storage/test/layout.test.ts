/**
 * Repo path layout — the same helper both writes the per-tenant directory
 * tree and parses inbound git diffs into (tenant, env, kind) tuples.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { layoutFor, parseRepoPath } from "../src/layout.ts";

test("layoutFor produces stable, hand-readable paths", () => {
  const l = layoutFor({
    pathPrefix: "platform",
    tenantSlug: "acme",
    envSlug: "dev"
  });
  assert.equal(l.envRoot, "platform/acme/dev");
  assert.equal(l.manifest, "platform/acme/dev/manifest.yaml");
  assert.equal(l.pipelineDir, "platform/acme/dev/pipelines");
  assert.equal(l.pipelineFile("intake"), "platform/acme/dev/pipelines/intake.yaml");
  assert.equal(l.configsFile, "platform/acme/dev/configs/values.yaml");
  assert.equal(l.secretsFile, "platform/acme/dev/secrets/values.enc");
});

test("layoutFor handles empty pathPrefix (repo root)", () => {
  const l = layoutFor({ pathPrefix: "", tenantSlug: "acme", envSlug: "prod" });
  assert.equal(l.envRoot, "acme/prod");
  assert.equal(l.manifest, "acme/prod/manifest.yaml");
});

test("layoutFor strips trailing/leading slashes in pathPrefix", () => {
  const l = layoutFor({
    pathPrefix: "/a/b/",
    tenantSlug: "t",
    envSlug: "e"
  });
  assert.equal(l.envRoot, "a/b/t/e");
});

test("parseRepoPath round-trips every file the layout emits", () => {
  const prefix = "platform";
  const paths = layoutFor({ pathPrefix: prefix, tenantSlug: "acme", envSlug: "dev" });
  assert.deepEqual(parseRepoPath(prefix, paths.manifest), {
    tenantSlug: "acme",
    envSlug: "dev",
    kind: "manifest"
  });
  assert.deepEqual(parseRepoPath(prefix, paths.pipelineFile("intake")), {
    tenantSlug: "acme",
    envSlug: "dev",
    kind: "pipeline",
    pipelineSlug: "intake"
  });
  assert.deepEqual(parseRepoPath(prefix, paths.configsFile), {
    tenantSlug: "acme",
    envSlug: "dev",
    kind: "configs"
  });
  assert.deepEqual(parseRepoPath(prefix, paths.secretsFile), {
    tenantSlug: "acme",
    envSlug: "dev",
    kind: "secrets"
  });
});

test("parseRepoPath returns undefined for paths outside the prefix", () => {
  assert.equal(parseRepoPath("platform", "other/acme/dev/manifest.yaml"), undefined);
  assert.equal(parseRepoPath("platform", "platform/acme"), undefined); // too short
  assert.equal(
    parseRepoPath("platform", "platform/acme/dev/something/else.yaml"),
    undefined
  );
});

test("parseRepoPath handles empty pathPrefix correctly", () => {
  assert.deepEqual(parseRepoPath("", "acme/dev/manifest.yaml"), {
    tenantSlug: "acme",
    envSlug: "dev",
    kind: "manifest"
  });
});
