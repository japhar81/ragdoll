/**
 * Unit tests for the cascade-delete UI helpers (apps/web/src/lib/cascadeDelete.ts).
 *
 * These cover the pure helper layer the CascadeDeleteModal sits on top
 * of — the modal's render path lives outside node:test (no JSDOM in
 * the web test harness), but every branch the modal cares about runs
 * through these helpers, so this is the load-bearing coverage:
 *
 *   - isHasDependentsError narrows the 409 envelope correctly and
 *     ignores any other 409 (built-in role refusal, slug conflict)
 *     or other status codes.
 *   - tryCascadeDelete translates 409 into a resolved {ok:false} and
 *     leaves every other error rejecting (so the caller's normal
 *     error path still runs for 401/403/404/422/500).
 *   - totalDependents sums every count, including zero buckets if the
 *     server ever surfaces them.
 *
 * The api-helper `?force=true` plumbing has its own regression check
 * via apiSurface.test.ts — this file is helpers-only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/lib/api.ts";
import {
  isHasDependentsError,
  totalDependents,
  tryCascadeDelete
} from "../src/lib/cascadeDelete.ts";

// ---------------------------------------------------------------------------
// isHasDependentsError
// ---------------------------------------------------------------------------

test("isHasDependentsError: recognises the canonical has_dependents envelope", () => {
  const err = new ApiError(409, {
    error: "has_dependents",
    message: "Cannot delete folder — 5 dependents.",
    dependents: { pipelines: 3, subfolders: 2 },
    hint: "?force=true to cascade"
  });
  const dep = isHasDependentsError(err);
  assert.ok(dep, "should narrow");
  assert.deepEqual(dep!.dependents, { pipelines: 3, subfolders: 2 });
  assert.equal(dep!.hint, "?force=true to cascade");
  assert.equal(dep!.message, "Cannot delete folder — 5 dependents.");
});

test("isHasDependentsError: rejects every other 409 shape (built-in role refusal, slug conflict)", () => {
  // Built-in role
  const builtin = new ApiError(409, { error: "conflict", message: "cannot delete a built-in role" });
  assert.equal(isHasDependentsError(builtin), undefined);
  // Slug conflict on POST
  const slug = new ApiError(409, { error: "conflict", message: "slug exists" });
  assert.equal(isHasDependentsError(slug), undefined);
  // Right error code, wrong status
  const wrongStatus = new ApiError(422, {
    error: "has_dependents",
    dependents: { pipelines: 1 }
  });
  assert.equal(isHasDependentsError(wrongStatus), undefined);
  // Right status, no body
  const noBody = new ApiError(409, null);
  assert.equal(isHasDependentsError(noBody), undefined);
});

test("isHasDependentsError: ignores non-ApiError throws (e.g. fetch network failure)", () => {
  assert.equal(isHasDependentsError(new Error("net")), undefined);
  assert.equal(isHasDependentsError("string"), undefined);
  assert.equal(isHasDependentsError(undefined), undefined);
  assert.equal(isHasDependentsError(null), undefined);
});

// ---------------------------------------------------------------------------
// tryCascadeDelete
// ---------------------------------------------------------------------------

test("tryCascadeDelete: returns {ok:true} on a clean 204 path", async () => {
  const result = await tryCascadeDelete(async () => undefined);
  assert.deepEqual(result, { ok: true });
});

test("tryCascadeDelete: translates 409 has_dependents into {ok:false} (modal can render without try/catch)", async () => {
  const envelope = {
    error: "has_dependents" as const,
    message: "blocked",
    dependents: { versions: 2, deployments: 1 },
    hint: "?force=true to cascade"
  };
  const result = await tryCascadeDelete(async () => {
    throw new ApiError(409, envelope);
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.dependents.dependents, { versions: 2, deployments: 1 });
  }
});

test("tryCascadeDelete: PROPAGATES any other error class (401/403/404/422/500/network)", async () => {
  await assert.rejects(
    () =>
      tryCascadeDelete(async () => {
        throw new ApiError(404, { error: "not_found" });
      }),
    (err: unknown) => err instanceof ApiError && err.status === 404
  );
  await assert.rejects(
    () =>
      tryCascadeDelete(async () => {
        throw new ApiError(500, { error: "internal" });
      }),
    (err: unknown) => err instanceof ApiError && err.status === 500
  );
  // 409 conflict that ISN'T has_dependents (e.g. built-in role) also throws.
  await assert.rejects(
    () =>
      tryCascadeDelete(async () => {
        throw new ApiError(409, { error: "conflict", message: "built-in" });
      }),
    (err: unknown) => err instanceof ApiError && err.status === 409
  );
  // Plain Error (no http) also throws.
  await assert.rejects(
    () =>
      tryCascadeDelete(async () => {
        throw new Error("network");
      }),
    /network/
  );
});

// ---------------------------------------------------------------------------
// totalDependents
// ---------------------------------------------------------------------------

test("totalDependents: sums every count value", () => {
  assert.equal(
    totalDependents({
      error: "has_dependents",
      message: "",
      dependents: { pipelines: 3, subfolders: 2, schedules: 1 },
      hint: ""
    }),
    6
  );
});

test("totalDependents: handles an empty dependents bag gracefully", () => {
  assert.equal(
    totalDependents({ error: "has_dependents", message: "", dependents: {}, hint: "" }),
    0
  );
});

// ---------------------------------------------------------------------------
// api: ?force=true is appended only when explicitly requested
// ---------------------------------------------------------------------------

test("api.delete<X> helpers append ?force=true only when opts.force=true (folders / pipelines / datasets / tenants / roles / connections)", async () => {
  // Replace global fetch to capture the URLs each helper actually hits.
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: { method?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  try {
    const { api } = await import("../src/lib/api.ts");
    await api.deleteFolder("F1");
    await api.deleteFolder("F2", { force: true });
    await api.deletePipeline("P1");
    await api.deletePipeline("P2", { force: true });
    await api.deleteDataset("D1");
    await api.deleteDataset("D2", { force: true });
    await api.deleteTenant("T1");
    await api.deleteTenant("T2", { force: true });
    await api.deleteRole("R1");
    await api.deleteRole("R2", { force: true });
    // Connections: default soft-archives; force=true hard-deletes the row.
    await api.deleteConnection("C1");
    await api.deleteConnection("C2", { force: true });
  } finally {
    globalThis.fetch = realFetch;
  }
  // Default calls — no query string.
  const defaults = calls.filter((c) => !c.includes("?force="));
  const forced = calls.filter((c) => c.includes("?force=true"));
  assert.equal(defaults.length, 6, `expected 6 default-DELETE calls, got: ${defaults.join("|")}`);
  assert.equal(forced.length, 6, `expected 6 force=true calls, got: ${forced.join("|")}`);
  for (const c of defaults) assert.equal(c.includes("?"), false, `default call must not carry a query string: ${c}`);
  for (const c of forced) assert.match(c, /\?force=true$/);
});
