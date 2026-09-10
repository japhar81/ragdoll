/**
 * Regression tests for the "dataset bound but never cut into a version" trap.
 *
 * A dataset created + bound but never built has `current_version_id IS NULL`
 * and no `stable` alias. Before the fix the resolver returned `undefined` for
 * this case — indistinguishable from "no dataset matched the ref" — so the
 * empty dataset reached the sink and its generic guard mislabelled it as a
 * MISSING BINDING, sending the operator to fix the one thing that wasn't broken.
 *
 * The fix:
 *   1. resolve() THROWS a typed `DatasetNotBuiltError` for the exists-but-
 *      unbuilt case (distinct from the `undefined` "no dataset" return), so the
 *      executor can surface an accurate "cut a version" message.
 *   2. a resolved binding's collection defaults to the DATASET SLUG when
 *      neither the binding nor the version supplies one — so a version cut
 *      without backend collections can never silently degrade ingest to the
 *      shared `default` index.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDatasetResolver,
  DatasetNotBuiltError
} from "../src/dataset-resolver.ts";
import type {
  DatasetRepository,
  DatasetVersionRepository,
  DatasetAliasRepository,
  DatasetRow,
  DatasetVersionRow,
  DatasetAliasRow
} from "../../db/src/index.ts";

function fakeDatasetRepo(row: DatasetRow): DatasetRepository {
  return {
    async get(id: string) {
      return id === row.id ? row : undefined;
    },
    async resolveSlug(args: { slug: string }) {
      return args.slug === row.slug ? row : undefined;
    }
  } as unknown as DatasetRepository;
}

function fakeVersionRepo(row: DatasetVersionRow | undefined): DatasetVersionRepository {
  return {
    async get(id: string) {
      return row && id === row.id ? row : undefined;
    }
  } as unknown as DatasetVersionRepository;
}

function fakeAliasRepo(row: DatasetAliasRow | undefined): DatasetAliasRepository {
  return {
    async resolve() {
      return row;
    }
  } as unknown as DatasetAliasRepository;
}

const tenantId = "tenant-a";

function datasetRow(overrides: Partial<DatasetRow> = {}): DatasetRow {
  return {
    id: "ds-1",
    slug: "irs-pubs",
    scope: "tenant",
    tenantId,
    environmentId: null,
    displayName: "IRS Pubs",
    description: null,
    embeddingProfile: {},
    chunkSchema: {},
    currentVersionId: null,
    bindings: { text: { connection: "os-prod" }, vectors: { connection: "os-prod" } },
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  } as unknown as DatasetRow;
}

function versionRow(overrides: Partial<DatasetVersionRow> = {}): DatasetVersionRow {
  return {
    id: "ver-1",
    datasetId: "ds-1",
    versionLabel: "v1",
    status: "ready",
    backendCollections: {},
    createdAt: new Date().toISOString(),
    ...overrides
  } as unknown as DatasetVersionRow;
}

// ---------------------------------------------------------------------------

test("resolve() THROWS DatasetNotBuiltError when the dataset exists but has no version", async () => {
  const resolver = buildDatasetResolver({
    datasets: fakeDatasetRepo(datasetRow()), // currentVersionId: null
    datasetVersions: fakeVersionRepo(undefined),
    datasetAliases: fakeAliasRepo(undefined) // no stable alias
  });
  await assert.rejects(
    () => resolver.resolve({ ref: { slug: "irs-pubs" }, tenantId }),
    (err: unknown) => {
      assert.ok(err instanceof DatasetNotBuiltError, "typed error");
      assert.equal((err as DatasetNotBuiltError).slug, "irs-pubs");
      assert.match((err as Error).message, /no published version/);
      return true;
    }
  );
});

test("resolve() returns undefined (NOT a throw) when no dataset matches the ref", async () => {
  const resolver = buildDatasetResolver({
    datasets: fakeDatasetRepo(datasetRow()),
    datasetVersions: fakeVersionRepo(undefined),
    datasetAliases: fakeAliasRepo(undefined)
  });
  const resolved = await resolver.resolve({ ref: { slug: "does-not-exist" }, tenantId });
  assert.equal(resolved, undefined, "no dataset => undefined, not DatasetNotBuiltError");
});

test("binding collection defaults to the dataset SLUG when the version has no backendCollections", async () => {
  const resolver = buildDatasetResolver({
    datasets: fakeDatasetRepo(datasetRow({ currentVersionId: "ver-1" })),
    datasetVersions: fakeVersionRepo(versionRow({ backendCollections: {} })),
    datasetAliases: fakeAliasRepo(undefined) // falls back to currentVersionId
  });
  const resolved = await resolver.resolve({ ref: { slug: "irs-pubs" }, tenantId });
  assert.ok(resolved);
  // Both bindings default to the slug (base name) — no silent `default` index.
  assert.equal(resolved!.bindings.text.collection, "irs-pubs");
  assert.equal(resolved!.bindings.vectors.collection, "irs-pubs");
});

test("version backendCollections win over the slug default; explicit binding.collection wins over both", async () => {
  const resolver = buildDatasetResolver({
    datasets: fakeDatasetRepo(
      datasetRow({
        currentVersionId: "ver-1",
        bindings: {
          text: { connection: "os-prod" }, // no explicit collection -> version value
          vectors: { connection: "os-prod", collection: "explicit-vec" } // explicit wins
        }
      })
    ),
    datasetVersions: fakeVersionRepo(
      versionRow({ backendCollections: { text: "from-version" } })
    ),
    datasetAliases: fakeAliasRepo(undefined)
  });
  const resolved = await resolver.resolve({ ref: { slug: "irs-pubs" }, tenantId });
  assert.ok(resolved);
  assert.equal(resolved!.bindings.text.collection, "from-version");
  assert.equal(resolved!.bindings.vectors.collection, "explicit-vec");
});
