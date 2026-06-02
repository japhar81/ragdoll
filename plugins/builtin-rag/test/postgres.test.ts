import test from "node:test";
import assert from "node:assert/strict";
import {
  postgresQueryPlugin,
  postgresUpsertPlugin,
  postgresDeletePlugin,
  postgresExecPlugin,
  buildBatchUpsert,
  buildBatchDelete
} from "../src/index.ts";
import {
  __setPoolFactory,
  acquire,
  assertLooksReadOnly,
  closeAllPools,
  getPool,
  poolCacheSize,
  quoteIdentifier,
  InvalidIdentifierError,
  type PoolClientLike,
  type PoolLike
} from "../src/postgres-core.ts";
import type { RuntimeContext } from "../../../packages/core/src/index.ts";

/**
 * Fake `pg` driver used across the Postgres plugin tests. Every call is
 * recorded on the returned `calls` array so assertions can inspect the
 * exact SQL text and bound parameter array — proving that runtime values
 * never reach SQL except through `$n` placeholders.
 *
 * `responses` is a queue: each `client.query` call shifts the next
 * response off the front. Tests that don't care about results can leave
 * it empty (defaults to `{ rows: [], rowCount: 0 }`).
 */
interface QueryCall {
  text: string;
  values?: unknown[];
}
interface FakeDriver {
  pools: FakePool[];
  calls: QueryCall[];
  enqueue(response: { rows?: Array<Record<string, unknown>>; rowCount?: number }): void;
  /** Queue an error to be thrown on the next non-tx-control query. */
  enqueueError(error: Error): void;
}
interface FakePool extends PoolLike {
  acquireCount: number;
  closed: boolean;
}

function installFakeDriver(t: { after(fn: () => void | Promise<void>): void }): FakeDriver {
  const driver: FakeDriver = {
    pools: [],
    calls: [],
    enqueue(response) {
      pendingResponses.push({
        kind: "rows",
        rows: response.rows ?? [],
        rowCount: response.rowCount ?? response.rows?.length ?? 0
      });
    },
    enqueueError(error) {
      pendingResponses.push({ kind: "error", error });
    }
  };
  type PendingResponse =
    | { kind: "rows"; rows: Array<Record<string, unknown>>; rowCount: number }
    | { kind: "error"; error: Error };
  const pendingResponses: PendingResponse[] = [];
  const factory = async (): Promise<PoolLike> => {
    const pool: FakePool = {
      acquireCount: 0,
      closed: false,
      async connect(): Promise<PoolClientLike> {
        pool.acquireCount += 1;
        const client: PoolClientLike = {
          async query<R = Record<string, unknown>>(
            cfg: string | { text: string; values?: unknown[] },
            values?: unknown[]
          ): Promise<{ rows: R[]; rowCount: number | null }> {
            const text = typeof cfg === "string" ? cfg : cfg.text;
            const vals = typeof cfg === "string" ? values : cfg.values;
            driver.calls.push({ text, values: vals });
            // Transaction control statements never consume a queued
            // response — tests enqueue rows for the real workload only.
            const isTxControl = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(text);
            if (isTxControl) {
              return { rows: [] as R[], rowCount: 0 };
            }
            const next = pendingResponses.shift() ?? { kind: "rows" as const, rows: [], rowCount: 0 };
            if (next.kind === "error") throw next.error;
            return { rows: next.rows as R[], rowCount: next.rowCount };
          },
          release() {
            /* fake */
          }
        };
        return client;
      },
      async end() {
        pool.closed = true;
      },
      on() {
        return pool;
      }
    };
    driver.pools.push(pool);
    return pool;
  };
  const prev = __setPoolFactory(factory);
  t.after(async () => {
    await closeAllPools();
    __setPoolFactory(prev);
  });
  return driver;
}

function ctx(tenantId = "t1"): RuntimeContext {
  return {
    requestId: "req-1",
    executionId: "exec-1",
    tenantId,
    pipelineId: "pipe-1",
    pipelineVersionId: "v1",
    environment: "test",
    resolvedConfig: {
      pipelineId: "pipe-1",
      pipelineVersionId: "v1",
      tenantId,
      environment: "test",
      values: {},
      violations: []
    }
  };
}

function pluginInput(overrides: {
  config: Record<string, unknown>;
  secrets?: Record<string, string>;
  inputs?: Record<string, unknown>;
}) {
  return {
    context: ctx(),
    node: { id: "n1", plugin: { category: "tool" as const, id: "postgres_query", version: "1.0.0" } },
    inputs: overrides.inputs ?? {},
    config: overrides.config,
    secrets: overrides.secrets ?? { dsn: "postgres://test:test@localhost:5432/test" }
  };
}

// ---------------------------------------------------------------------------
// Pure helpers: identifier quoting + read-only gate
// ---------------------------------------------------------------------------

test("quoteIdentifier accepts a plain identifier and double-quotes it", () => {
  assert.equal(quoteIdentifier("users"), `"users"`);
  assert.equal(quoteIdentifier("user_id"), `"user_id"`);
  assert.equal(quoteIdentifier("_underscore_lead"), `"_underscore_lead"`);
});

test("quoteIdentifier accepts schema.table and quotes each part", () => {
  assert.equal(quoteIdentifier("public.users"), `"public"."users"`);
});

test("quoteIdentifier rejects injection attempts", () => {
  const evils = [
    `users"; DROP TABLE x; --`,
    `users; DELETE FROM x`,
    `users WHERE 1=1`,
    `users.x.y`, // 3-part name
    `"already_quoted"`,
    "",
    "1starts_with_digit"
  ];
  for (const evil of evils) {
    assert.throws(
      () => quoteIdentifier(evil),
      InvalidIdentifierError,
      `expected ${JSON.stringify(evil)} to be rejected`
    );
  }
});

test("assertLooksReadOnly: SELECT / WITH / VALUES / SHOW pass", () => {
  assertLooksReadOnly("SELECT 1");
  assertLooksReadOnly("  select * from users  ");
  assertLooksReadOnly("WITH x AS (SELECT 1) SELECT * FROM x");
  assertLooksReadOnly("VALUES (1, 2)");
  assertLooksReadOnly("SHOW TIMEZONE");
});

test("assertLooksReadOnly: writes and DDL are rejected", () => {
  const evils = [
    "INSERT INTO users VALUES (1)",
    "UPDATE users SET x=1",
    "DELETE FROM users",
    "DROP TABLE users",
    "ALTER TABLE users ADD x INT",
    "TRUNCATE users",
    "SET ROLE admin"
  ];
  for (const evil of evils) {
    assert.throws(() => assertLooksReadOnly(evil), /read-only/i, evil);
  }
});

// ---------------------------------------------------------------------------
// buildBatchUpsert: the SQL shape is unit-testable without a database.
// ---------------------------------------------------------------------------

test("buildBatchUpsert: plain INSERT — no conflict target", () => {
  const { text, values } = buildBatchUpsert({
    quotedTable: `"public"."users"`,
    quotedColumns: [`"id"`, `"name"`],
    columns: ["id", "name"],
    rows: [
      { id: 1, name: "ada" },
      { id: 2, name: "lin" }
    ]
  });
  assert.equal(
    text,
    `INSERT INTO "public"."users" ("id", "name") VALUES ($1, $2), ($3, $4) RETURNING (xmax = 0) AS inserted`
  );
  assert.deepEqual(values, [1, "ada", 2, "lin"]);
});

test("buildBatchUpsert: ON CONFLICT DO NOTHING when no updateColumns", () => {
  const { text } = buildBatchUpsert({
    quotedTable: `"t"`,
    quotedColumns: [`"id"`, `"v"`],
    columns: ["id", "v"],
    rows: [{ id: 1, v: 9 }],
    quotedConflict: [`"id"`]
  });
  assert.match(text, /ON CONFLICT \("id"\) DO NOTHING/);
});

test("buildBatchUpsert: ON CONFLICT DO UPDATE when updateColumns provided", () => {
  const { text } = buildBatchUpsert({
    quotedTable: `"t"`,
    quotedColumns: [`"id"`, `"v"`],
    columns: ["id", "v"],
    rows: [{ id: 1, v: 9 }],
    quotedConflict: [`"id"`],
    quotedUpdate: [`"v"`]
  });
  assert.match(text, /ON CONFLICT \("id"\) DO UPDATE SET "v" = EXCLUDED."v"/);
});

test("buildBatchUpsert: missing keys bind NULL, extra keys are ignored", () => {
  const { values } = buildBatchUpsert({
    quotedTable: `"t"`,
    quotedColumns: [`"a"`, `"b"`],
    columns: ["a", "b"],
    rows: [{ a: 1, c: "ignored" }, { b: "only" }]
  });
  assert.deepEqual(values, [1, null, null, "only"]);
});

// ---------------------------------------------------------------------------
// postgres_query: read-only, parameterised, injection-safe.
// ---------------------------------------------------------------------------

test("postgres_query: opens READ ONLY txn, runs parameterised SQL, returns rows", async (t) => {
  const driver = installFakeDriver(t);
  driver.enqueue({ rows: [{ id: 1 }, { id: 2 }] });
  const result = await postgresQueryPlugin.execute(
    pluginInput({
      config: { sql: "SELECT id FROM users WHERE tenant_id = $1", maxRows: 1000 },
      inputs: { params: ["acme"] }
    })
  );
  assert.deepEqual(result.outputs.rows, [{ id: 1 }, { id: 2 }]);
  assert.equal(result.outputs.rowCount, 2);
  assert.equal(result.outputs.truncated, false);
  // Round-trip should be: BEGIN READ ONLY, SELECT, COMMIT.
  assert.equal(driver.calls.length, 3);
  assert.match(driver.calls[0].text, /BEGIN READ ONLY/);
  assert.equal(driver.calls[1].text, "SELECT id FROM users WHERE tenant_id = $1");
  assert.deepEqual(driver.calls[1].values, ["acme"]);
  assert.match(driver.calls[2].text, /COMMIT/);
});

test("postgres_query: maxRows truncates and flags truncated:true", async (t) => {
  const driver = installFakeDriver(t);
  driver.enqueue({ rows: [{ x: 1 }, { x: 2 }, { x: 3 }] });
  const result = await postgresQueryPlugin.execute(
    pluginInput({ config: { sql: "SELECT 1", maxRows: 2 } })
  );
  assert.equal(result.outputs.rowCount, 2);
  assert.equal(result.outputs.truncated, true);
});

test("postgres_query: SQL-injection payload in params is bound as data, not interpolated", async (t) => {
  const driver = installFakeDriver(t);
  driver.enqueue({ rows: [] });
  const injection = "x'; DROP TABLE users; --";
  await postgresQueryPlugin.execute(
    pluginInput({
      config: { sql: "SELECT * FROM users WHERE name = $1" },
      inputs: { params: [injection] }
    })
  );
  // SQL text MUST contain only the literal config string. The payload
  // travels separately in the values array — the driver parameterises it
  // safely. This is the property the whole plugin family guarantees.
  assert.equal(driver.calls[1].text, "SELECT * FROM users WHERE name = $1");
  assert.deepEqual(driver.calls[1].values, [injection]);
  assert.ok(
    !driver.calls.some((c) => /DROP TABLE/i.test(c.text)),
    "injection payload must NEVER appear in any SQL text"
  );
});

test("postgres_query: refuses non-SELECT statements pre-flight", async (t) => {
  installFakeDriver(t);
  await assert.rejects(
    postgresQueryPlugin.execute(
      pluginInput({ config: { sql: "DELETE FROM users" } })
    ),
    /read-only/i
  );
});

test("postgres_query: refuses readOnly:false (reserved field)", async (t) => {
  installFakeDriver(t);
  await assert.rejects(
    postgresQueryPlugin.execute(
      pluginInput({ config: { sql: "SELECT 1", readOnly: false } })
    ),
    /reserved/i
  );
});

test("postgres_query: requires a dsn secret", async (t) => {
  installFakeDriver(t);
  await assert.rejects(
    postgresQueryPlugin.execute({
      ...pluginInput({ config: { sql: "SELECT 1" } }),
      secrets: {}
    }),
    /dsn/i
  );
});

// ---------------------------------------------------------------------------
// postgres_upsert: identifier validation, params-only, conflict modes.
// ---------------------------------------------------------------------------

test("postgres_upsert: validates identifiers and binds row values as parameters", async (t) => {
  const driver = installFakeDriver(t);
  driver.enqueue({ rows: [{ inserted: true }, { inserted: true }] });
  const result = await postgresUpsertPlugin.execute(
    pluginInput({
      config: {
        table: "public.users",
        columns: ["id", "email"],
        conflictTarget: ["id"],
        updateColumns: ["email"]
      },
      inputs: {
        rows: [
          { id: 1, email: "a@x" },
          { id: 2, email: "b@x" }
        ]
      }
    })
  );
  assert.equal(result.outputs.inserted, 2);
  assert.equal(result.outputs.updated, 0);
  // BEGIN, INSERT, COMMIT.
  assert.equal(driver.calls.length, 3);
  assert.equal(driver.calls[0].text, "BEGIN");
  const insertCall = driver.calls[1];
  assert.match(
    insertCall.text,
    /INSERT INTO "public"."users" \("id", "email"\) VALUES \(\$1, \$2\), \(\$3, \$4\) ON CONFLICT \("id"\) DO UPDATE SET "email" = EXCLUDED\."email"/
  );
  assert.deepEqual(insertCall.values, [1, "a@x", 2, "b@x"]);
});

test("postgres_upsert: rejects table name containing SQL", async (t) => {
  installFakeDriver(t);
  await assert.rejects(
    postgresUpsertPlugin.execute(
      pluginInput({
        config: {
          table: `users"; DROP TABLE x; --`,
          columns: ["id"]
        },
        inputs: { rows: [{ id: 1 }] }
      })
    ),
    InvalidIdentifierError
  );
});

test("postgres_upsert: rejects column name containing SQL", async (t) => {
  installFakeDriver(t);
  await assert.rejects(
    postgresUpsertPlugin.execute(
      pluginInput({
        config: {
          table: "t",
          columns: ["id, DROP TABLE x; --"]
        },
        inputs: { rows: [{}] }
      })
    ),
    InvalidIdentifierError
  );
});

test("postgres_upsert: updateColumns without conflictTarget is rejected", async (t) => {
  installFakeDriver(t);
  await assert.rejects(
    postgresUpsertPlugin.execute(
      pluginInput({
        config: { table: "t", columns: ["id"], updateColumns: ["x"] },
        inputs: { rows: [{ id: 1 }] }
      })
    ),
    /conflictTarget/i
  );
});

test("postgres_upsert: zero rows is a no-op", async (t) => {
  const driver = installFakeDriver(t);
  const result = await postgresUpsertPlugin.execute(
    pluginInput({
      config: { table: "t", columns: ["id"] },
      inputs: { rows: [] }
    })
  );
  assert.deepEqual(result.outputs, { inserted: 0, updated: 0 });
  assert.equal(driver.calls.length, 0);
});

test("postgres_upsert: counts UPDATEs separately via xmax flag", async (t) => {
  const driver = installFakeDriver(t);
  driver.enqueue({ rows: [{ inserted: true }, { inserted: false }, { inserted: false }] });
  const result = await postgresUpsertPlugin.execute(
    pluginInput({
      config: { table: "t", columns: ["id"], conflictTarget: ["id"], updateColumns: ["id"] },
      inputs: { rows: [{ id: 1 }, { id: 2 }, { id: 3 }] }
    })
  );
  assert.equal(result.outputs.inserted, 1);
  assert.equal(result.outputs.updated, 2);
  // Even though buildBatchUpsert is shared, the driver call count is what
  // proves we batched all three rows into one INSERT.
  assert.equal(driver.calls.filter((c) => /INSERT/.test(c.text)).length, 1);
});

// ---------------------------------------------------------------------------
// postgres_exec: hard-gated DDL.
// ---------------------------------------------------------------------------

test("postgres_exec: refuses without allowDDL:true", async (t) => {
  installFakeDriver(t);
  await assert.rejects(
    postgresExecPlugin.execute(
      pluginInput({
        config: { statements: ["CREATE TABLE x (id INT)"] }
      })
    ),
    /allowDDL/i
  );
  // Even an explicit `false` is refused — the field must be the literal true.
  await assert.rejects(
    postgresExecPlugin.execute(
      pluginInput({
        config: { statements: ["CREATE TABLE x (id INT)"], allowDDL: false }
      })
    ),
    /allowDDL/i
  );
});

test("postgres_exec: executes each statement once when allowDDL:true", async (t) => {
  const driver = installFakeDriver(t);
  driver.enqueue({});
  driver.enqueue({});
  const result = await postgresExecPlugin.execute(
    pluginInput({
      config: {
        allowDDL: true,
        statements: [
          "CREATE TABLE x (id INT)",
          "CREATE INDEX x_id ON x (id)"
        ]
      }
    })
  );
  assert.equal(result.outputs.executed, 2);
  assert.equal(driver.calls.length, 2);
  assert.match(driver.calls[0].text, /CREATE TABLE x/);
  assert.match(driver.calls[1].text, /CREATE INDEX/);
});

// ---------------------------------------------------------------------------
// Pool reuse: the most architecturally important property of the family.
// ---------------------------------------------------------------------------

test("getPool: identical DSNs share one PoolEntry across calls", async (t) => {
  installFakeDriver(t);
  const a = await getPool({ dsn: "postgres://u:p@h/db", name: "alpha" });
  const b = await getPool({ dsn: "postgres://u:p@h/db", name: "beta-different-label" });
  assert.equal(a, b, "same DSN must yield the same PoolEntry");
  assert.equal(poolCacheSize(), 1);
});

test("getPool: different DSNs yield independent pools", async (t) => {
  installFakeDriver(t);
  const a = await getPool({ dsn: "postgres://u:p@h/db", name: "x" });
  const b = await getPool({ dsn: "postgres://u:p@h/other", name: "x" });
  assert.notEqual(a, b);
  assert.equal(poolCacheSize(), 2);
});

test("pool reuse across plugin invocations: postgres_query twice -> one underlying pool", async (t) => {
  const driver = installFakeDriver(t);
  driver.enqueue({ rows: [{ a: 1 }] });
  driver.enqueue({ rows: [{ a: 2 }] });
  await postgresQueryPlugin.execute(pluginInput({ config: { sql: "SELECT 1" } }));
  await postgresQueryPlugin.execute(pluginInput({ config: { sql: "SELECT 2" } }));
  assert.equal(driver.pools.length, 1, "second invocation must reuse the same pool");
});

test("acquire: records wait time and acquire count on the PoolEntry", async (t) => {
  installFakeDriver(t);
  const entry = await getPool({ dsn: "postgres://u:p@h/db", name: "x" });
  const before = entry.acquireCount;
  const client = await acquire(entry);
  client.release();
  assert.equal(entry.acquireCount, before + 1);
  assert.ok(entry.acquireWaitMs >= 0);
});

// ---------------------------------------------------------------------------
// Manifest categorisation: protects against accidental regressions that
// would change the surface (category, contract, ports) of these plugins.
// ---------------------------------------------------------------------------

test("manifest categorisation: postgres_query is a `tool` with declared ports", () => {
  const m = postgresQueryPlugin.manifest;
  assert.equal(m.id, "postgres_query");
  assert.equal(m.category, "tool");
  assert.equal(m.contract ?? 1, 1, "no Dataset binding required");
  assert.ok(m.configSchema?.required?.includes("sql"));
  assert.ok(m.secretsSchema?.required?.includes("dsn"));
  assert.deepEqual(
    m.outputPorts?.map((p) => p.name),
    ["rows", "rowCount", "truncated"]
  );
});

test("manifest categorisation: postgres_upsert is a `sink` with rows input port", () => {
  const m = postgresUpsertPlugin.manifest;
  assert.equal(m.category, "sink");
  assert.equal(m.inputPorts?.[0]?.name, "rows");
  assert.equal(m.inputPorts?.[0]?.required, true);
});

test("manifest categorisation: postgres_exec is a `tool`, flagged `dangerous`", () => {
  const m = postgresExecPlugin.manifest;
  assert.equal(m.category, "tool");
  assert.ok(m.capabilities?.includes("dangerous"));
  assert.ok(m.configSchema?.required?.includes("allowDDL"));
});

test("manifest categorisation: postgres_delete is a `sink` requiring table+where", () => {
  const m = postgresDeletePlugin.manifest;
  assert.equal(m.category, "sink");
  assert.equal(m.inputPorts?.[0]?.name, "rows");
  assert.equal(m.inputPorts?.[0]?.required, true);
  assert.deepEqual(m.configSchema?.required, ["table", "where"]);
});

// ---------------------------------------------------------------------------
// buildBatchDelete: pure SQL builder unit-tested without a database
// ---------------------------------------------------------------------------

test("buildBatchDelete: single-column where uses `= ANY($1)` fast path", () => {
  const { text, values } = buildBatchDelete({
    quotedTable: `"docs"`,
    quotedWhere: [`"doc_id"`],
    whereCols: ["doc_id"],
    rows: [{ doc_id: "a.md" }, { doc_id: "b.md" }, { doc_id: "c.md" }]
  });
  assert.equal(text, `DELETE FROM "docs" WHERE "doc_id" = ANY($1)`);
  // One parameter binds the entire array — one round-trip, one prepared plan.
  assert.deepEqual(values, [["a.md", "b.md", "c.md"]]);
});

test("buildBatchDelete: multi-column where uses tuple IN-list with per-cell placeholders", () => {
  const { text, values } = buildBatchDelete({
    quotedTable: `"chunks"`,
    quotedWhere: [`"tenant_id"`, `"doc_id"`],
    whereCols: ["tenant_id", "doc_id"],
    rows: [
      { tenant_id: "t-1", doc_id: "a.md" },
      { tenant_id: "t-1", doc_id: "b.md" }
    ]
  });
  assert.equal(
    text,
    `DELETE FROM "chunks" WHERE ("tenant_id", "doc_id") IN (($1, $2), ($3, $4))`
  );
  // Per-row, per-column placeholders bind values in row-major order.
  assert.deepEqual(values, ["t-1", "a.md", "t-1", "b.md"]);
});

// ---------------------------------------------------------------------------
// postgres_delete: end-to-end through the fake pg driver
// ---------------------------------------------------------------------------

test("postgres_delete: single-column where sends one DELETE with `= ANY($1)`", async (t) => {
  const driver = installFakeDriver(t);
  // BEGIN + COMMIT are tx-control (auto-handled, no enqueue). Only the
  // DELETE itself consumes a queued response.
  driver.enqueue({ rowCount: 3 });
  const out = await postgresDeletePlugin.execute(
    pluginInput({
      config: { table: "docs", where: ["docId"] },
      inputs: { rows: [{ docId: "a.md" }, { docId: "b.md" }, { docId: "c.md" }] }
    })
  );
  assert.equal(out.outputs.deleted, 3, "reports the rowCount from the DELETE");
  // BEGIN + DELETE + COMMIT — three queries, in order.
  assert.equal(driver.calls.length, 3);
  assert.equal(driver.calls[0]!.text, "BEGIN");
  assert.equal(driver.calls[1]!.text, `DELETE FROM "docs" WHERE "docId" = ANY($1)`);
  assert.deepEqual(driver.calls[1]!.values, [["a.md", "b.md", "c.md"]]);
  assert.equal(driver.calls[2]!.text, "COMMIT");
});

test("postgres_delete: multi-column where for tenant-scoped deletes", async (t) => {
  const driver = installFakeDriver(t);
  driver.enqueue({ rowCount: 2 });
  const out = await postgresDeletePlugin.execute(
    pluginInput({
      config: { table: "chunks", where: ["tenant_id", "doc_id"] },
      inputs: {
        rows: [
          { tenant_id: "t-1", doc_id: "a.md" },
          { tenant_id: "t-1", doc_id: "b.md" }
        ]
      }
    })
  );
  assert.equal(out.outputs.deleted, 2);
  assert.equal(
    driver.calls[1]!.text,
    `DELETE FROM "chunks" WHERE ("tenant_id", "doc_id") IN (($1, $2), ($3, $4))`
  );
});

test("postgres_delete: refuses up front when a row is missing a where-column key", async (t) => {
  installFakeDriver(t);
  await assert.rejects(
    () =>
      postgresDeletePlugin.execute(
        pluginInput({
          config: { table: "docs", where: ["doc_id"] },
          inputs: { rows: [{ doc_id: "a.md" }, { other: "b.md" }] }
        })
      ),
    /missing required where-column "doc_id"/
  );
});

test("postgres_delete: empty rows array no-ops without opening a transaction", async (t) => {
  const driver = installFakeDriver(t);
  const out = await postgresDeletePlugin.execute(
    pluginInput({
      config: { table: "docs", where: ["doc_id"] },
      inputs: { rows: [] }
    })
  );
  assert.equal(out.outputs.deleted, 0);
  assert.equal(driver.calls.length, 0, "no BEGIN — the empty case bails before pool acquire");
});

test("postgres_delete: identifier validation rejects injection attempts in `where`", async (t) => {
  installFakeDriver(t);
  await assert.rejects(
    () =>
      postgresDeletePlugin.execute(
        pluginInput({
          config: { table: "docs", where: [`doc_id"; DROP TABLE x; --`] },
          inputs: { rows: [{ "doc_id": "a.md" }] }
        })
      ),
    /identifier|config\.where/i
  );
});

test("postgres_delete: rolls back on a DELETE failure mid-transaction", async (t) => {
  const driver = installFakeDriver(t);
  // BEGIN + ROLLBACK are tx-control and don't consume the queue; the
  // single queued error fires on the DELETE call.
  driver.enqueueError(new Error("connection terminated"));
  await assert.rejects(
    () =>
      postgresDeletePlugin.execute(
        pluginInput({
          config: { table: "docs", where: ["doc_id"] },
          inputs: { rows: [{ doc_id: "a.md" }] }
        })
      ),
    /connection terminated/
  );
  // BEGIN → DELETE (threw) → ROLLBACK — three queries recorded.
  assert.equal(driver.calls[0]!.text, "BEGIN");
  assert.equal(driver.calls[1]!.text.startsWith("DELETE FROM"), true);
  assert.equal(driver.calls[2]!.text, "ROLLBACK");
});
