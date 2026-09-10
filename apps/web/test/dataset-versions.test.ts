/**
 * Guards for the Datasets screen "Cut version" affordance.
 *
 * The web app is NOT typechecked in CI (root tsconfig excludes apps/web; vite
 * only strips types), so a missing api method or a broken helper ships as a
 * runtime crash. Pin both:
 *   - `api.createDatasetVersion` exists (the method the new Cut-version button
 *     and not-ready banner call);
 *   - `initialBackendCollections` snapshots bindings → backend collections with
 *     the dataset slug as the fallback base name, so a version cut from the UI
 *     gets per-dataset index naming instead of degrading to a shared `default`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/lib/api.ts";
import { initialBackendCollections } from "../src/lib/datasetVersions.ts";
import type { DatasetView } from "../src/lib/api.ts";

test("api exposes createDatasetVersion (used by Cut version + not-ready banner)", () => {
  assert.equal(typeof api.createDatasetVersion, "function");
});

function ds(bindings: DatasetView["bindings"], slug = "irs-pubs"): DatasetView {
  return {
    id: "d1",
    scope: "tenant",
    tenantId: "t1",
    environmentId: null,
    slug,
    displayName: "D",
    description: null,
    embeddingProfile: {},
    chunkSchema: {},
    bindings,
    currentVersionId: null,
    archivedAt: null,
    createdAt: "",
    createdBy: null,
    updatedAt: ""
  };
}

test("initialBackendCollections defaults each binding to the dataset slug", () => {
  const out = initialBackendCollections(
    ds({ text: { connection: "os" }, vectors: { connection: "os" } })
  );
  assert.deepEqual(out, { text: "irs-pubs", vectors: "irs-pubs" });
});

test("initialBackendCollections honors an explicit binding.collection over the slug", () => {
  const out = initialBackendCollections(
    ds({ text: { connection: "os", collection: "custom-idx" }, vectors: { connection: "os" } })
  );
  assert.deepEqual(out, { text: "custom-idx", vectors: "irs-pubs" });
});

test("initialBackendCollections treats a blank collection as unset (falls back to slug)", () => {
  const out = initialBackendCollections(ds({ text: { connection: "os", collection: "  " } }));
  assert.deepEqual(out, { text: "irs-pubs" });
});

test("initialBackendCollections on a dataset with no bindings is empty", () => {
  assert.deepEqual(initialBackendCollections(ds({})), {});
});
