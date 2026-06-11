/**
 * Phase 6 unit tests: PgVectorStore against a fake PgPoolLike.
 *
 * Real Postgres + pgvector lives behind docker-compose, so the offline
 * test runner can't exercise the actual SQL. Instead we record every
 * query the store issues and assert the wire shape: table name
 * sanitisation, the right column types, tenant scoping in queries,
 * distance-metric → opclass mapping, and the dimension-mismatch /
 * tenant-required guards.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DimensionMismatchError,
  PgVectorStore,
  VectorStoreError,
  type PgPoolLike
} from "../src/index.ts";

function recordingPool(): {
  pool: PgPoolLike;
  calls: Array<{ sql: string; params: unknown[] }>;
  rows: Array<Record<string, unknown>>;
  setRows(rows: Array<Record<string, unknown>>): void;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let queue: Array<Record<string, unknown>> = [];
  return {
    pool: {
      async query<R = Record<string, unknown>>(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        const rows = queue as unknown as R[];
        queue = [];
        return { rows, rowCount: rows.length };
      }
    },
    calls,
    get rows() {
      return queue;
    },
    setRows(rows) {
      queue = rows;
    }
  };
}

test("ensureCollection issues a CREATE TABLE with the right vector dim + ivfflat opclass", async () => {
  const rec = recordingPool();
  const store = new PgVectorStore({ pool: rec.pool });
  await store.ensureCollection("my-kb", { dimensions: 768, distance: "cosine" });
  assert.ok(
    rec.calls[0].sql.includes("CREATE TABLE IF NOT EXISTS vec_my_kb"),
    "table is prefixed + sanitised"
  );
  assert.ok(
    rec.calls[0].sql.includes("vector(768)"),
    "dimensions baked into the column type"
  );
  assert.ok(
    rec.calls[2].sql.includes("vector_cosine_ops"),
    "cosine opclass selected"
  );
});

test("ensureCollection rejects a re-ensure with different dimensions", async () => {
  const rec = recordingPool();
  const store = new PgVectorStore({ pool: rec.pool });
  await store.ensureCollection("kb", { dimensions: 768, distance: "cosine" });
  await assert.rejects(
    () => store.ensureCollection("kb", { dimensions: 384, distance: "cosine" }),
    DimensionMismatchError
  );
});

test("ensureCollection rejects a re-ensure with different distance", async () => {
  const rec = recordingPool();
  const store = new PgVectorStore({ pool: rec.pool });
  await store.ensureCollection("kb", { dimensions: 768, distance: "cosine" });
  await assert.rejects(
    () => store.ensureCollection("kb", { dimensions: 768, distance: "euclidean" }),
    VectorStoreError
  );
});

test("upsert batches points into a single INSERT … ON CONFLICT DO UPDATE", async () => {
  const rec = recordingPool();
  const store = new PgVectorStore({ pool: rec.pool });
  await store.ensureCollection("kb", { dimensions: 3, distance: "cosine" });
  rec.calls.length = 0;
  await store.upsert("kb", [
    {
      id: "a",
      tenantId: "tenant-1",
      vector: [1, 2, 3],
      payload: { text: "hello" }
    },
    {
      id: "b",
      tenantId: "tenant-1",
      vector: [4, 5, 6],
      payload: { text: "world" }
    }
  ]);
  assert.equal(rec.calls.length, 1);
  assert.ok(rec.calls[0].sql.includes("INSERT INTO vec_kb"));
  assert.ok(rec.calls[0].sql.includes("ON CONFLICT (id) DO UPDATE"));
  // 4 params per row, 2 rows.
  assert.equal(rec.calls[0].params.length, 8);
});

test("upsert rejects dimension mismatch", async () => {
  const rec = recordingPool();
  const store = new PgVectorStore({ pool: rec.pool });
  await store.ensureCollection("kb", { dimensions: 3, distance: "cosine" });
  await assert.rejects(
    () =>
      store.upsert("kb", [
        { id: "a", tenantId: "t-1", vector: [1, 2], payload: {} }
      ]),
    DimensionMismatchError
  );
});

test("query enforces tenant scoping and orders by distance", async () => {
  const rec = recordingPool();
  const store = new PgVectorStore({ pool: rec.pool });
  await store.ensureCollection("kb", { dimensions: 3, distance: "cosine" });
  rec.setRows([
    { id: "a", payload: { text: "x" }, dist: 0.1 },
    { id: "b", payload: { text: "y" }, dist: 0.4 }
  ]);
  const results = await store.query("kb", {
    vector: [1, 2, 3],
    topK: 2,
    tenantId: "tenant-1"
  });
  const lastCall = rec.calls[rec.calls.length - 1];
  assert.ok(lastCall.sql.includes("tenant_id = $2"));
  assert.ok(lastCall.sql.includes("<=>")); // cosine operator
  assert.ok(lastCall.sql.includes("ORDER BY dist"));
  // pgvector distance -> higher-is-closer score via negation.
  assert.equal(results[0].id, "a");
  assert.equal(results[0].score, -0.1);
});

test("query refuses to run without a tenantId", async () => {
  const rec = recordingPool();
  const store = new PgVectorStore({ pool: rec.pool });
  await store.ensureCollection("kb", { dimensions: 3, distance: "cosine" });
  await assert.rejects(
    () =>
      store.query("kb", {
        vector: [1, 2, 3],
        topK: 1,
        tenantId: ""
      }),
    VectorStoreError
  );
});

test("query splices payload @> filter when provided", async () => {
  const rec = recordingPool();
  const store = new PgVectorStore({ pool: rec.pool });
  await store.ensureCollection("kb", { dimensions: 3, distance: "cosine" });
  rec.setRows([]);
  await store.query("kb", {
    vector: [1, 2, 3],
    topK: 5,
    tenantId: "t-1",
    filter: { source: "wiki" }
  });
  const lastCall = rec.calls[rec.calls.length - 1];
  assert.ok(
    lastCall.sql.includes("payload @>"),
    "filter clause spliced into the WHERE"
  );
  // params: vector_literal, tenant, filter_json, topK
  assert.equal(lastCall.params.length, 4);
});

test("deleteByTenant scopes by tenant_id", async () => {
  const rec = recordingPool();
  const store = new PgVectorStore({ pool: rec.pool });
  await store.ensureCollection("kb", { dimensions: 3, distance: "cosine" });
  rec.calls.length = 0;
  await store.deleteByTenant("kb", "tenant-1");
  assert.equal(rec.calls.length, 1);
  assert.ok(rec.calls[0].sql.includes("DELETE FROM vec_kb"));
  assert.ok(rec.calls[0].sql.includes("tenant_id = $1"));
  assert.deepEqual(rec.calls[0].params, ["tenant-1"]);
});

test("deleteCollection drops the table and clears the cached metadata", async () => {
  const rec = recordingPool();
  const store = new PgVectorStore({ pool: rec.pool });
  await store.ensureCollection("kb", { dimensions: 3, distance: "cosine" });
  rec.calls.length = 0;
  await store.deleteCollection("kb");
  assert.ok(rec.calls[0].sql.startsWith("DROP TABLE IF EXISTS vec_kb"));
  // A subsequent ensureCollection should treat the collection as new.
  await store.ensureCollection("kb", { dimensions: 1536, distance: "euclidean" });
});

// ---------------------------------------------------------------------------
// "Delete X from a table that doesn't exist" must be a no-op, not a throw.
// The pg path mirrors the Qdrant fix (isCollectionMissingError) — both back
// the same VectorStore contract and the same ingest path hits both on first
// run, before any upsert has materialised the collection.
// ---------------------------------------------------------------------------

test("deleteByDocIds is a no-op when the table doesn't exist", async () => {
  const rec = recordingPool();
  const store = new PgVectorStore({ pool: rec.pool });
  // recordingPool() returns no rows from pg_attribute, so requireMeta()
  // throws CollectionNotFoundError. The fix should swallow it and skip
  // the DELETE entirely.
  await assert.doesNotReject(
    store.deleteByDocIds("ghost", "tenant-x", ["doc1", "doc2"])
  );
  // Critically: NO DELETE issued. Only the pg_attribute probe should have
  // run; if a DELETE shows up we'd be hitting a non-existent table for
  // real.
  assert.ok(
    rec.calls.every((c) => !c.sql.includes("DELETE FROM")),
    `expected zero DELETEs, saw: ${rec.calls.map((c) => c.sql.slice(0, 40)).join("|")}`
  );
});

test("deleteByIds is a no-op when the table doesn't exist", async () => {
  const rec = recordingPool();
  const store = new PgVectorStore({ pool: rec.pool });
  await assert.doesNotReject(store.deleteByIds("ghost", ["id1"]));
  assert.ok(rec.calls.every((c) => !c.sql.includes("DELETE FROM")));
});

test("deleteByTenant is a no-op when the table doesn't exist", async () => {
  const rec = recordingPool();
  const store = new PgVectorStore({ pool: rec.pool });
  await assert.doesNotReject(store.deleteByTenant("ghost", "tenant-x"));
  assert.ok(rec.calls.every((c) => !c.sql.includes("DELETE FROM")));
});

test("deleteByDocIds DOES issue a DELETE when the table exists", async () => {
  const rec = recordingPool();
  const store = new PgVectorStore({ pool: rec.pool });
  // Materialise the collection so requireMeta() succeeds.
  await store.ensureCollection("kb", { dimensions: 3, distance: "cosine" });
  rec.calls.length = 0;
  await store.deleteByDocIds("kb", "tenant-1", ["d1", "d2"]);
  // Exactly one DELETE issued; tenant scope mandatory; docIds bound as
  // a text[] parameter — same shape the bug fix didn't break.
  const deletes = rec.calls.filter((c) => c.sql.includes("DELETE FROM"));
  assert.equal(deletes.length, 1);
  assert.ok(deletes[0].sql.includes("WHERE tenant_id = $1"));
  assert.ok(deletes[0].sql.includes("payload->>'docId' = ANY($2::text[])"));
  assert.deepEqual(deletes[0].params, ["tenant-1", ["d1", "d2"]]);
});

// ---------------------------------------------------------------------------
// query() must mirror the delete posture: a missing table returns zero
// hits, not CollectionNotFoundError. Symmetric with QdrantVectorStore.query
// + InMemoryVectorStore.query.
// ---------------------------------------------------------------------------

test("query returns [] when the table doesn't exist", async () => {
  const rec = recordingPool();
  const store = new PgVectorStore({ pool: rec.pool });
  // recordingPool() returns no rows from pg_attribute → requireMeta()
  // throws CollectionNotFoundError → query swallows and returns [].
  const out = await store.query("ghost", { vector: [1, 2, 3], topK: 5, tenantId: "t1" });
  assert.deepEqual(out, []);
  // Sanity: no SELECT-from-ghost issued; only the pg_attribute probe.
  assert.ok(
    rec.calls.every((c) => !c.sql.includes("FROM vec_ghost")),
    `expected no SELECT against vec_ghost; saw: ${rec.calls.map((c) => c.sql.slice(0, 40)).join("|")}`
  );
});

test("query DOES issue a SELECT when the table exists", async () => {
  const rec = recordingPool();
  const store = new PgVectorStore({ pool: rec.pool });
  await store.ensureCollection("kb", { dimensions: 3, distance: "cosine" });
  rec.calls.length = 0;
  await store.query("kb", { vector: [1, 2, 3], topK: 5, tenantId: "t1" });
  const selects = rec.calls.filter((c) => c.sql.includes("FROM vec_kb"));
  assert.equal(selects.length, 1);
  assert.ok(selects[0].sql.includes("WHERE tenant_id = $2"));
});
