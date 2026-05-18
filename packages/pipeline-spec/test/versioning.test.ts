import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSemver,
  compareSemver,
  maxSemver,
  semverBump,
  nextVersionOnSave,
  rollbackPointer,
  resolveActivation,
  effectiveVersionId,
  specChecksum,
  VersionNotFoundError,
  ActivationResolutionError,
  type PipelineVersionRecord
} from "../src/index.ts";
import type { PipelineSpec } from "../../core/src/index.ts";

const fixedNow = () => "2026-05-18T00:00:00.000Z";

function makeSpec(name: string, extraNodeId?: string): PipelineSpec {
  return {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name },
    spec: {
      nodes: [
        { id: "input", type: "input" },
        ...(extraNodeId ? [{ id: extraNodeId, type: "output" as const }] : []),
        { id: "output", type: "output" }
      ],
      edges: []
    }
  };
}

function makeRecord(version: string, spec: PipelineSpec, id: string): PipelineVersionRecord {
  return {
    id,
    pipelineId: spec.metadata.name,
    version,
    status: "published",
    spec,
    checksum: specChecksum(spec),
    createdAt: fixedNow()
  };
}

/* -------------------------------- semver ---------------------------------- */

test("parseSemver: valid and invalid", () => {
  assert.deepEqual(parseSemver("1.2.3"), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseSemver("  10.0.42  "), { major: 10, minor: 0, patch: 42 });
  assert.equal(parseSemver("1.2"), null);
  assert.equal(parseSemver("1.2.3-rc1"), null);
  assert.equal(parseSemver("v1.2.3"), null);
  assert.equal(parseSemver(""), null);
  assert.equal(parseSemver("a.b.c"), null);
});

test("compareSemver: ordering and unparseable handling", () => {
  assert.ok(compareSemver("1.0.0", "2.0.0") < 0);
  assert.ok(compareSemver("1.2.0", "1.1.9") > 0);
  assert.ok(compareSemver("1.0.1", "1.0.1") === 0);
  assert.ok(compareSemver("1.1.0", "1.0.5") > 0);
  // Unparseable sorts below any valid semver, equal to each other.
  assert.ok(compareSemver("garbage", "0.0.1") < 0);
  assert.ok(compareSemver("0.0.1", "garbage") > 0);
  assert.equal(compareSemver("garbage", "also-bad"), 0);
});

test("maxSemver: empty / all-invalid -> 0.0.0, else greatest", () => {
  assert.equal(maxSemver([]), "0.0.0");
  assert.equal(maxSemver(["nope", "still-no"]), "0.0.0");
  assert.equal(maxSemver(["1.0.0", "2.3.4", "2.3.10", "0.9.9"]), "2.3.10");
  assert.equal(maxSemver(["1.0.0", "bad", "1.2.0"]), "1.2.0");
});

test("semverBump: patch/minor/major with resets", () => {
  assert.equal(semverBump("1.2.3", "patch"), "1.2.4");
  assert.equal(semverBump("1.2.3", "minor"), "1.3.0");
  assert.equal(semverBump("1.2.3", "major"), "2.0.0");
  // minor resets patch; major resets minor+patch.
  assert.equal(semverBump("1.0.9", "minor"), "1.1.0");
  assert.equal(semverBump("3.7.5", "major"), "4.0.0");
  // Unparseable base treated as 0.0.0.
  assert.equal(semverBump("garbage", "patch"), "0.0.1");
  assert.equal(semverBump("garbage", "minor"), "0.1.0");
  assert.equal(semverBump("garbage", "major"), "1.0.0");
});

/* --------------------------- nextVersionOnSave ---------------------------- */

test("nextVersionOnSave: idempotent when checksum matches latest", () => {
  const spec = makeSpec("p");
  const latest = makeRecord("1.2.0", spec, "v-latest");
  const result = nextVersionOnSave({
    existingVersions: [latest],
    latest,
    spec,
    now: fixedNow
  });
  assert.equal(result.kind, "idempotent");
  if (result.kind === "idempotent") {
    assert.equal(result.version, latest);
  }
});

test("nextVersionOnSave: new record with default patch bump + parent linkage", () => {
  const v1Spec = makeSpec("p");
  const v1 = makeRecord("1.0.0", v1Spec, "v1");
  const changed = makeSpec("p", "extra");

  const result = nextVersionOnSave({
    existingVersions: [v1],
    latest: v1,
    spec: changed,
    now: fixedNow
  });
  assert.equal(result.kind, "new");
  if (result.kind === "new") {
    assert.equal(result.record.version, "1.0.1");
    assert.equal(result.record.status, "published");
    assert.equal(result.record.pipelineId, "p");
    assert.equal(result.record.checksum, specChecksum(changed));
    assert.equal(result.record.parentVersionId, "v1");
    assert.equal(result.record.createdAt, "2026-05-18T00:00:00.000Z");
    assert.equal(result.record.spec, changed);
  }
});

test("nextVersionOnSave: minor/major level honored", () => {
  const v1 = makeRecord("1.4.2", makeSpec("p"), "v1");
  const changed = makeSpec("p", "extra");

  const minor = nextVersionOnSave({ existingVersions: [v1], latest: v1, spec: changed, level: "minor", now: fixedNow });
  assert.equal(minor.kind === "new" && minor.record.version, "1.5.0");

  const major = nextVersionOnSave({ existingVersions: [v1], latest: v1, spec: changed, level: "major", now: fixedNow });
  assert.equal(major.kind === "new" && major.record.version, "2.0.0");
});

test("nextVersionOnSave: monotonic bump from GLOBAL max even when latest is older", () => {
  // Versions exist up to 3.0.0, but the latest pointer was rolled back to 1.0.0.
  const v1 = makeRecord("1.0.0", makeSpec("p"), "v1");
  const v2 = makeRecord("2.0.0", makeSpec("p", "n2"), "v2");
  const v3 = makeRecord("3.0.0", makeSpec("p", "n3"), "v3");
  const changed = makeSpec("p", "newnode");

  const result = nextVersionOnSave({
    existingVersions: [v1, v2, v3],
    latest: v1, // pointer rolled back to the oldest
    spec: changed,
    now: fixedNow
  });
  assert.equal(result.kind, "new");
  if (result.kind === "new") {
    // Bumped from global max (3.0.0), not from latest (1.0.0).
    assert.equal(result.record.version, "3.0.1");
    // Parent still links to the current latest pointer.
    assert.equal(result.record.parentVersionId, "v1");
  }
});

test("nextVersionOnSave: no latest -> parentVersionId null, bumps from existing", () => {
  const result = nextVersionOnSave({
    existingVersions: [],
    spec: makeSpec("fresh"),
    now: fixedNow
  });
  assert.equal(result.kind, "new");
  if (result.kind === "new") {
    assert.equal(result.record.version, "0.0.1");
    assert.equal(result.record.parentVersionId, null);
    assert.equal(result.record.pipelineId, "fresh");
  }
});

test("nextVersionOnSave: does not mutate inputs", () => {
  const v1 = makeRecord("1.0.0", makeSpec("p"), "v1");
  const existing = [v1];
  nextVersionOnSave({ existingVersions: existing, latest: v1, spec: makeSpec("p", "x"), now: fixedNow });
  assert.equal(existing.length, 1);
  assert.equal(v1.version, "1.0.0");
});

/* ----------------------------- rollbackPointer ---------------------------- */

test("rollbackPointer: returns id when found", () => {
  const versions = [
    makeRecord("1.0.0", makeSpec("p"), "v1"),
    makeRecord("2.0.0", makeSpec("p", "n"), "v2")
  ];
  assert.equal(rollbackPointer(versions, "v1"), "v1");
  assert.equal(rollbackPointer(versions, "v2"), "v2");
});

test("rollbackPointer: throws VersionNotFoundError when missing", () => {
  const versions = [makeRecord("1.0.0", makeSpec("p"), "v1")];
  assert.throws(() => rollbackPointer(versions, "nope"), VersionNotFoundError);
  assert.throws(() => rollbackPointer([], "v1"), VersionNotFoundError);
});

/* ---------------------------- resolveActivation --------------------------- */

interface Act {
  label: string;
  enabled: boolean;
  tag?: string;
}

test("resolveActivation: explicit label wins (must exist + enabled)", () => {
  const acts: Act[] = [
    { label: "default", enabled: true, tag: "d" },
    { label: "canary", enabled: true, tag: "c" }
  ];
  assert.equal(resolveActivation(acts, "canary").tag, "c");
});

test("resolveActivation: explicit label missing -> error", () => {
  assert.throws(
    () => resolveActivation([{ label: "default", enabled: true }], "ghost"),
    ActivationResolutionError
  );
});

test("resolveActivation: explicit label disabled -> error", () => {
  assert.throws(
    () => resolveActivation([{ label: "canary", enabled: false }], "canary"),
    ActivationResolutionError
  );
});

test("resolveActivation: default label preferred over other enabled", () => {
  const acts: Act[] = [
    { label: "canary", enabled: true, tag: "c" },
    { label: "default", enabled: true, tag: "d" }
  ];
  assert.equal(resolveActivation(acts).tag, "d");
});

test("resolveActivation: disabled default falls through to sole enabled", () => {
  const acts: Act[] = [
    { label: "default", enabled: false, tag: "d" },
    { label: "canary", enabled: true, tag: "c" }
  ];
  assert.equal(resolveActivation(acts).tag, "c");
});

test("resolveActivation: exactly one enabled is chosen", () => {
  const acts: Act[] = [
    { label: "a", enabled: false },
    { label: "b", enabled: true, tag: "b" }
  ];
  assert.equal(resolveActivation(acts).tag, "b");
});

test("resolveActivation: ambiguous (multiple enabled, no default) -> error", () => {
  const acts: Act[] = [
    { label: "a", enabled: true },
    { label: "b", enabled: true }
  ];
  assert.throws(() => resolveActivation(acts), ActivationResolutionError);
});

test("resolveActivation: none enabled -> error", () => {
  assert.throws(
    () => resolveActivation([{ label: "a", enabled: false }]),
    ActivationResolutionError
  );
});

/* ---------------------------- effectiveVersionId -------------------------- */

test("effectiveVersionId: trackLatest follows pipeline latest", () => {
  assert.equal(
    effectiveVersionId({ trackLatest: true, pipelineVersionId: "pinned" }, "latest-id"),
    "latest-id"
  );
});

test("effectiveVersionId: pinned uses its own version id", () => {
  assert.equal(
    effectiveVersionId({ trackLatest: false, pipelineVersionId: "pinned" }, "latest-id"),
    "pinned"
  );
});

test("effectiveVersionId: trackLatest but no pipeline latest -> error", () => {
  assert.throws(
    () => effectiveVersionId({ trackLatest: true, pipelineVersionId: "pinned" }, null),
    ActivationResolutionError
  );
  assert.throws(
    () => effectiveVersionId({ trackLatest: true, pipelineVersionId: "pinned" }),
    ActivationResolutionError
  );
});

test("effectiveVersionId: pinned but no pipelineVersionId -> error", () => {
  assert.throws(
    () => effectiveVersionId({ trackLatest: false, pipelineVersionId: null }, "latest-id"),
    ActivationResolutionError
  );
  assert.throws(
    () => effectiveVersionId({ trackLatest: false }, "latest-id"),
    ActivationResolutionError
  );
});
