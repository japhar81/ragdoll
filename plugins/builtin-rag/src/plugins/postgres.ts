/**
 * Postgres plugin family: read-only parameterised query, bulk upsert, and
 * a hard-gated DDL / migration runner. All three share the pooled-connection
 * core in `../postgres-core.ts` so a single pipeline that combines query +
 * upsert against the same external database re-uses ONE pg.Pool per
 * worker / API process.
 *
 * Architectural rules baked into this file (and the matching ADR 0020):
 *
 * 1. **SQL is config, params are data.** Every SQL string lives on the node's
 *    `config.sql` or `config.statements`. Runtime values from upstream nodes
 *    only enter the database via bound parameters (`$1`, `$2`, …). There is
 *    no path by which `inputs.params` can be string-interpolated into SQL.
 *
 * 2. **Identifiers are validated, not interpolated.** Postgres won't bind
 *    table or column names as parameters, so `postgres_upsert` quotes them
 *    after validating against a strict identifier regex
 *    (`postgres-core.quoteIdentifier`).
 *
 * 3. **Connections are secrets.** The DSN is provided via `secrets.dsn`
 *    (a secret-ref); `config.connection` is just an operator-facing label.
 *    The pool cache is keyed by the resolved DSN, NOT the label.
 *
 * 4. **Read-only by default.** `postgres_query` opens a READ ONLY
 *    transaction so any write attempt fails at the database, even if a
 *    determined operator tried to slip an INSERT past the pre-flight check.
 *
 * 5. **DDL is opt-in and obvious.** `postgres_exec` refuses to run unless
 *    `config.allowDDL === true`. Pipelines that need migrations or one-time
 *    schema changes set this literal; everything else can't accidentally
 *    DROP a table.
 */

import type { InProcessPlugin, JsonSchemaLike } from "../../../../packages/plugin-sdk/src/index.ts";
import {
  acquire,
  assertLooksReadOnly,
  getPool,
  quoteIdentifier
} from "../postgres-core.ts";

const POSTGRES_SECRETS_SCHEMA: JsonSchemaLike = {
  type: "object",
  required: ["dsn"],
  properties: {
    dsn: {
      type: "string",
      format: "secret-ref",
      description:
        "Postgres connection string (e.g. postgres://user:pass@host:5432/db). Resolved per-environment by the secret store; the same `connection` label backed by different DSNs in dev vs prod is the expected pattern."
    }
  },
  additionalProperties: false
};

function dsnFromSecrets(secrets: Record<string, string>): string {
  const dsn = secrets.dsn;
  if (!dsn || typeof dsn !== "string") {
    throw new Error(
      "postgres plugins require a `dsn` secret-ref (set node.secrets.dsn to a managed secret)."
    );
  }
  return dsn;
}

function connectionLabel(config: Record<string, unknown>): string {
  const raw = config.connection;
  if (raw === undefined || raw === null || raw === "") return "default";
  return String(raw);
}

function rowLimitFrom(config: Record<string, unknown>, fallback: number): number {
  const raw = config.maxRows ?? fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function paramsFromInputs(inputs: Record<string, unknown>): unknown[] {
  const raw = inputs.params;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("postgres_query: inputs.params must be an array of bind values.");
  }
  return raw;
}

// ---------------------------------------------------------------------------
// postgres_query — the retrieval workhorse.
// ---------------------------------------------------------------------------
//
// The SQL lives entirely in `config.sql`; nothing from upstream nodes
// reaches it except via `inputs.params`. The transaction is opened READ
// ONLY before the statement runs, so even a config typo that wrote a
// destructive statement would be rejected by Postgres.
//
// Categorisation: registered as `tool` (not `retriever`) because the result
// shape is rows-of-records, not the embedding-based document set the
// `retriever` category implies. Pipelines that want to mix rows into a
// rerank flow can wrap this node and an embedding plugin behind a
// `merge_rrf` — that's a pipeline-author concern, not a plugin one.
export const postgresQueryPlugin: InProcessPlugin = {
  manifest: {
    id: "postgres_query",
    name: "Postgres Query",
    version: "1.0.0",
    category: "tool",
    description:
      "Runs a parameterised SELECT against an external Postgres database. The SQL is fixed in config; runtime values flow only through `inputs.params` as bound parameters. Opens a READ ONLY transaction so writes fail at the database, never at the application.",
    configSchema: {
      type: "object",
      required: ["sql"],
      properties: {
        connection: {
          type: "string",
          default: "default",
          description:
            "Operator-facing label for this connection (e.g. `email-facts-db`). Used in logs and pool metrics; pool identity is keyed by the resolved DSN, not the label."
        },
        sql: {
          type: "string",
          description:
            "Parameterised SQL statement. Use $1, $2, … placeholders for any runtime value; never string-interpolate."
        },
        readOnly: {
          type: "boolean",
          default: true,
          description:
            "When true (the default) the statement runs inside a READ ONLY transaction. Setting this to false is not yet supported; the field is reserved so it remains visible in the schema."
        },
        maxRows: {
          type: "integer",
          default: 1000,
          description:
            "Hard cap on rows returned. Excess rows are truncated and `truncated: true` is added to the output."
        }
      },
      additionalProperties: false
    },
    secretsSchema: POSTGRES_SECRETS_SCHEMA,
    inputPorts: [
      {
        name: "params",
        description:
          "Optional bind parameters as an array, matching the $1, $2, … placeholders in `config.sql`."
      }
    ],
    outputPorts: [
      { name: "rows", description: "Array of result rows as plain objects." },
      { name: "rowCount", description: "Number of rows returned (after maxRows truncation)." },
      { name: "truncated", description: "True if the rowCount equals maxRows and more rows were available." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "database",
      color: "#336791",
      paletteGroup: "External data",
      formHints: {
        sql: { widget: "textarea", rows: 4 },
        maxRows: { widget: "number", min: 1, step: 100 }
      }
    }
  },
  async execute(input) {
    const { inputs, config, secrets } = input;
    const sql = config.sql;
    if (typeof sql !== "string" || sql.trim().length === 0) {
      throw new Error("postgres_query requires `config.sql` (a parameterised SELECT).");
    }
    if (config.readOnly === false) {
      throw new Error(
        "postgres_query.readOnly:false is reserved and not implemented — use postgres_exec for writes."
      );
    }
    assertLooksReadOnly(sql);
    const params = paramsFromInputs(inputs);
    const maxRows = rowLimitFrom(config, 1000);
    // `LIMIT $n+1` would be cleaner but we can't append unconditionally —
    // operator-supplied SQL may already have its own LIMIT, and many
    // analytic queries use OFFSET. We cap by slicing the result set
    // post-fetch; the maxRows is also enforced as a row-count budget so
    // a pathologically large query still trips it via row truncation.
    const entry = await getPool({ dsn: dsnFromSecrets(secrets), name: connectionLabel(config) });
    const client = await acquire(entry);
    const startedAt = Date.now();
    try {
      await client.query("BEGIN READ ONLY");
      const result = await client.query<Record<string, unknown>>({ text: sql, values: params });
      await client.query("COMMIT");
      const allRows = (result.rows ?? []) as Array<Record<string, unknown>>;
      const rows = allRows.slice(0, maxRows);
      const truncated = allRows.length > maxRows;
      return {
        outputs: {
          rows,
          rowCount: rows.length,
          truncated
        },
        metadata: {
          connection: connectionLabel(config),
          latencyMs: Date.now() - startedAt,
          poolAcquireWaitMs: entry.acquireWaitMs,
          poolAcquireCount: entry.acquireCount
        }
      };
    } catch (error) {
      // ROLLBACK is best-effort: if the connection is gone, the txn is
      // already dead and pg will surface the original error first.
      try {
        await client.query("ROLLBACK");
      } catch {
        /* intentionally empty */
      }
      throw error;
    } finally {
      client.release();
    }
  }
};

// ---------------------------------------------------------------------------
// postgres_upsert — the write path for ingest pipelines.
// ---------------------------------------------------------------------------
//
// Multi-row insert per transaction. Identifiers (`table`, `columns`,
// `conflictTarget`, `updateColumns`) are author-controlled, validated, and
// quoted; values bind as parameters. Two operating modes:
//
//   - Without `conflictTarget`: pure INSERT. Conflicts raise.
//   - With `conflictTarget` and NO `updateColumns`: INSERT … ON CONFLICT
//     DO NOTHING. The `updated` count is always zero in this mode.
//   - With `conflictTarget` and `updateColumns`: INSERT … ON CONFLICT
//     DO UPDATE SET <col = EXCLUDED.col>. xmax > 0 distinguishes an
//     UPDATE from an INSERT in `RETURNING (xmax = 0) AS inserted`.
export const postgresUpsertPlugin: InProcessPlugin = {
  manifest: {
    id: "postgres_upsert",
    name: "Postgres Upsert",
    version: "1.0.0",
    category: "sink",
    description:
      "Bulk-inserts (and optionally updates on conflict) rows into an external Postgres table. Identifiers come from config and are validated/quoted; values bind as parameters.",
    configSchema: {
      type: "object",
      required: ["table", "columns"],
      properties: {
        connection: { type: "string", default: "default", description: "Operator-facing label." },
        table: {
          type: "string",
          description:
            "Target table name. Accepts `schema.table`; each segment validated against the Postgres identifier grammar."
        },
        columns: {
          type: "array",
          items: { type: "string" },
          description: "Ordered column list; each row in `inputs.rows` is mapped against this order."
        },
        conflictTarget: {
          type: "array",
          items: { type: "string" },
          description:
            "Conflict target columns (the unique index or primary key). Required to enable upsert semantics."
        },
        updateColumns: {
          type: "array",
          items: { type: "string" },
          description:
            "Columns to SET on conflict. Omit (with a conflictTarget present) to ON CONFLICT DO NOTHING."
        },
        batchSize: {
          type: "integer",
          default: 500,
          description: "Maximum rows per multi-row insert; transactions chain batches together."
        }
      },
      additionalProperties: false
    },
    secretsSchema: POSTGRES_SECRETS_SCHEMA,
    inputPorts: [
      {
        name: "rows",
        required: true,
        description:
          "Array of row objects. Keys must match `config.columns`; extra keys are ignored, missing keys bind NULL."
      }
    ],
    outputPorts: [
      { name: "inserted", description: "Count of newly-inserted rows." },
      { name: "updated", description: "Count of rows that hit the ON CONFLICT … DO UPDATE branch." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "database",
      color: "#336791",
      paletteGroup: "External data",
      formHints: {
        columns: { widget: "tags" },
        conflictTarget: { widget: "tags" },
        updateColumns: { widget: "tags" },
        batchSize: { widget: "number", min: 1, step: 50 }
      }
    }
  },
  async execute(input) {
    const { inputs, config, secrets } = input;
    const rows = inputs.rows;
    if (!Array.isArray(rows)) {
      throw new Error("postgres_upsert requires `inputs.rows` to be an array.");
    }
    if (rows.length === 0) {
      return { outputs: { inserted: 0, updated: 0 } };
    }
    const tableRaw = config.table;
    if (typeof tableRaw !== "string" || tableRaw.length === 0) {
      throw new Error("postgres_upsert requires `config.table`.");
    }
    const columnsRaw = config.columns;
    if (!Array.isArray(columnsRaw) || columnsRaw.length === 0) {
      throw new Error("postgres_upsert requires `config.columns` to be a non-empty array.");
    }
    const columns = columnsRaw.map((col, i) => {
      if (typeof col !== "string") {
        throw new Error(`postgres_upsert config.columns[${i}] must be a string identifier.`);
      }
      return col;
    });
    const conflictRaw = config.conflictTarget;
    const updateRaw = config.updateColumns;
    if (conflictRaw !== undefined && !Array.isArray(conflictRaw)) {
      throw new Error("postgres_upsert config.conflictTarget must be an array of column names.");
    }
    if (updateRaw !== undefined && !Array.isArray(updateRaw)) {
      throw new Error("postgres_upsert config.updateColumns must be an array of column names.");
    }
    if (updateRaw !== undefined && conflictRaw === undefined) {
      throw new Error(
        "postgres_upsert: updateColumns requires a conflictTarget — there is no UPDATE branch without one."
      );
    }
    const quotedTable = quoteIdentifier(tableRaw, "config.table");
    const quotedColumns = columns.map((c) => quoteIdentifier(c, "config.columns"));
    const quotedConflict = (conflictRaw as string[] | undefined)?.map((c) =>
      quoteIdentifier(c, "config.conflictTarget")
    );
    const quotedUpdate = (updateRaw as string[] | undefined)?.map((c) =>
      quoteIdentifier(c, "config.updateColumns")
    );
    const batchSize = Math.max(1, Math.floor(Number(config.batchSize ?? 500)));

    const dsn = dsnFromSecrets(secrets);
    const entry = await getPool({ dsn, name: connectionLabel(config) });
    const client = await acquire(entry);
    let inserted = 0;
    let updated = 0;
    const startedAt = Date.now();
    try {
      await client.query("BEGIN");
      for (let i = 0; i < rows.length; i += batchSize) {
        const slice = rows.slice(i, i + batchSize) as Array<Record<string, unknown>>;
        const { text, values } = buildBatchUpsert({
          quotedTable,
          quotedColumns,
          columns,
          rows: slice,
          quotedConflict,
          quotedUpdate
        });
        const result = await client.query({ text, values });
        // RETURNING (xmax = 0) AS inserted: TRUE on a fresh row, FALSE on an
        // UPDATE. ON CONFLICT DO NOTHING returns zero rows for conflicting
        // tuples; we infer those as "skipped" and count neither.
        for (const row of (result.rows ?? []) as Array<{ inserted?: boolean }>) {
          if (row.inserted === true) inserted += 1;
          else if (row.inserted === false) updated += 1;
        }
      }
      await client.query("COMMIT");
      return {
        outputs: { inserted, updated },
        metadata: {
          connection: connectionLabel(config),
          batches: Math.ceil(rows.length / batchSize),
          latencyMs: Date.now() - startedAt,
          poolAcquireWaitMs: entry.acquireWaitMs,
          poolAcquireCount: entry.acquireCount
        }
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* intentionally empty */
      }
      throw error;
    } finally {
      client.release();
    }
  }
};

interface BuildBatchUpsertArgs {
  quotedTable: string;
  quotedColumns: string[];
  columns: string[];
  rows: Array<Record<string, unknown>>;
  quotedConflict?: string[];
  quotedUpdate?: string[];
}

/** Pure builder so the SQL shape is unit-testable without a database. */
export function buildBatchUpsert(args: BuildBatchUpsertArgs): { text: string; values: unknown[] } {
  const { quotedTable, quotedColumns, columns, rows, quotedConflict, quotedUpdate } = args;
  const values: unknown[] = [];
  const placeholders: string[] = [];
  let placeholderIndex = 1;
  for (const row of rows) {
    const rowParts: string[] = [];
    for (const col of columns) {
      values.push(Object.prototype.hasOwnProperty.call(row, col) ? row[col] : null);
      rowParts.push(`$${placeholderIndex}`);
      placeholderIndex += 1;
    }
    placeholders.push(`(${rowParts.join(", ")})`);
  }
  let onConflict = "";
  if (quotedConflict && quotedConflict.length > 0) {
    if (quotedUpdate && quotedUpdate.length > 0) {
      const sets = quotedUpdate.map((c) => `${c} = EXCLUDED.${c}`).join(", ");
      onConflict = ` ON CONFLICT (${quotedConflict.join(", ")}) DO UPDATE SET ${sets}`;
    } else {
      onConflict = ` ON CONFLICT (${quotedConflict.join(", ")}) DO NOTHING`;
    }
  }
  const text =
    `INSERT INTO ${quotedTable} (${quotedColumns.join(", ")}) ` +
    `VALUES ${placeholders.join(", ")}` +
    onConflict +
    " RETURNING (xmax = 0) AS inserted";
  return { text, values };
}

// ---------------------------------------------------------------------------
// postgres_delete — bulk delete by operator-specified match columns.
// ---------------------------------------------------------------------------
//
// Operator picks the table + which columns identify a row to delete
// (`where`). One row per delete; rows are batched into a single
// statement per batch. Pairs with `delta_filter.deleted` for delta-aware
// ingestion: the operator wires `where: ["docId"]` (or whatever their
// column is named) and the `{ deleted: [{docId}] }` array slots in
// directly. Multi-column match (e.g. `where: ["tenant_id", "doc_id"]`)
// gives defense-in-depth for multi-tenant tables.
//
// SQL shape:
//   - single-column `where`: `DELETE FROM t WHERE col = ANY($1)` — one
//     parameter binding an array. Fastest path.
//   - multi-column `where`: `DELETE FROM t WHERE (c1, c2) IN ((..),(..))`
//     with per-tuple placeholders. Batched.
//
// All identifiers validated via `quoteIdentifier` (same as upsert);
// values bind as parameters — never interpolated.
export const postgresDeletePlugin: InProcessPlugin = {
  manifest: {
    id: "postgres_delete",
    name: "Postgres Delete",
    version: "1.0.0",
    category: "sink",
    description:
      "Bulk-deletes rows from an external Postgres table whose `where` columns match the input rows. Pairs with `delta_filter.deleted` for delta-aware ingestion when the operator's table has a column matching the delta input's key (typically `docId`). Identifiers come from config and are validated/quoted; values bind as parameters. Multi-column `where` (e.g. `[\"tenant_id\", \"doc_id\"]`) is recommended for multi-tenant tables as defense-in-depth.",
    configSchema: {
      type: "object",
      required: ["table", "where"],
      properties: {
        connection: { type: "string", default: "default", description: "Operator-facing label." },
        table: {
          type: "string",
          description:
            "Target table name. Accepts `schema.table`; each segment validated against the Postgres identifier grammar."
        },
        where: {
          type: "array",
          items: { type: "string" },
          description:
            "Match column(s) — every value present in an input row's matching keys becomes part of the WHERE clause. Single column → `WHERE col = ANY(values)`; multi-column → `WHERE (c1, c2) IN ((..),(..))`. A row missing any `where`-column key is rejected up front (NULL-vs-not-NULL ambiguity in SQL would otherwise silently skip rows)."
        },
        batchSize: {
          type: "integer",
          default: 500,
          description: "Maximum rows per multi-row delete; transactions chain batches together."
        }
      },
      additionalProperties: false
    },
    secretsSchema: POSTGRES_SECRETS_SCHEMA,
    inputPorts: [
      {
        name: "rows",
        required: true,
        description:
          "Array of row objects carrying the `where`-column values. For delta-driven use, wire `delta_filter.deleted` (which emits `[{docId}]`) here when `where: [\"docId\"]`."
      }
    ],
    outputPorts: [
      { name: "deleted", description: "Count of rows actually removed (reported by Postgres rowCount)." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "trash",
      color: "#dc2626",
      paletteGroup: "External data",
      formHints: {
        where: { widget: "tags" },
        batchSize: { widget: "number", min: 1, step: 50 }
      }
    }
  },
  async execute(input) {
    const { inputs, config, secrets } = input;
    const rows = inputs.rows;
    if (!Array.isArray(rows)) {
      throw new Error("postgres_delete requires `inputs.rows` to be an array.");
    }
    if (rows.length === 0) {
      return { outputs: { deleted: 0 } };
    }
    const tableRaw = config.table;
    if (typeof tableRaw !== "string" || tableRaw.length === 0) {
      throw new Error("postgres_delete requires `config.table`.");
    }
    const whereRaw = config.where;
    if (!Array.isArray(whereRaw) || whereRaw.length === 0) {
      throw new Error("postgres_delete requires `config.where` to be a non-empty array.");
    }
    const whereCols = whereRaw.map((col, i) => {
      if (typeof col !== "string") {
        throw new Error(`postgres_delete config.where[${i}] must be a string identifier.`);
      }
      return col;
    });
    const quotedTable = quoteIdentifier(tableRaw, "config.table");
    const quotedWhere = whereCols.map((c) => quoteIdentifier(c, "config.where"));
    const batchSize = Math.max(1, Math.floor(Number(config.batchSize ?? 500)));
    // Up-front validation: every row MUST carry every `where` key. SQL would
    // otherwise let NULL slip into IN-list comparisons (NULL never matches
    // anything, including itself), silently failing to delete rows that
    // happen to have a NULL key — surprising and hard to debug. Loud here.
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as Record<string, unknown>;
      for (const col of whereCols) {
        if (!Object.prototype.hasOwnProperty.call(row, col)) {
          throw new Error(
            `postgres_delete: rows[${i}] is missing required where-column "${col}".`
          );
        }
      }
    }

    const dsn = dsnFromSecrets(secrets);
    const entry = await getPool({ dsn, name: connectionLabel(config) });
    const client = await acquire(entry);
    let deleted = 0;
    const startedAt = Date.now();
    try {
      await client.query("BEGIN");
      for (let i = 0; i < rows.length; i += batchSize) {
        const slice = rows.slice(i, i + batchSize) as Array<Record<string, unknown>>;
        const { text, values } = buildBatchDelete({
          quotedTable,
          quotedWhere,
          whereCols,
          rows: slice
        });
        const result = await client.query({ text, values });
        deleted += result.rowCount ?? 0;
      }
      await client.query("COMMIT");
      return {
        outputs: { deleted },
        metadata: {
          connection: connectionLabel(config),
          batches: Math.ceil(rows.length / batchSize),
          latencyMs: Date.now() - startedAt,
          poolAcquireWaitMs: entry.acquireWaitMs,
          poolAcquireCount: entry.acquireCount
        }
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Rollback failure on top of a primary failure: surface the
        // original error; the connection's about to be released and any
        // half-applied state is the operator's problem to diagnose.
      }
      throw error;
    } finally {
      client.release();
    }
  }
};

interface BuildBatchDeleteArgs {
  quotedTable: string;
  quotedWhere: string[];
  whereCols: string[];
  rows: Array<Record<string, unknown>>;
}

/** Pure builder so the SQL shape is unit-testable without a database.
 *  Single-column `where` → `WHERE col = ANY($1)` (one array param).
 *  Multi-column `where` → `WHERE (c1, c2) IN (($1, $2), ($3, $4), ...)`. */
export function buildBatchDelete(args: BuildBatchDeleteArgs): { text: string; values: unknown[] } {
  const { quotedTable, quotedWhere, whereCols, rows } = args;
  if (whereCols.length === 1) {
    // Fast path: one parameter that binds an array; Postgres uses
    // `= ANY($1)` for IN-list-via-array.
    const col = whereCols[0]!;
    const values = rows.map((r) => r[col]);
    const text = `DELETE FROM ${quotedTable} WHERE ${quotedWhere[0]} = ANY($1)`;
    return { text, values: [values] };
  }
  const values: unknown[] = [];
  const tuples: string[] = [];
  let placeholderIndex = 1;
  for (const row of rows) {
    const tupleParts: string[] = [];
    for (const col of whereCols) {
      values.push(row[col]);
      tupleParts.push(`$${placeholderIndex}`);
      placeholderIndex += 1;
    }
    tuples.push(`(${tupleParts.join(", ")})`);
  }
  const text =
    `DELETE FROM ${quotedTable} WHERE (${quotedWhere.join(", ")}) IN (${tuples.join(", ")})`;
  return { text, values };
}

// ---------------------------------------------------------------------------
// postgres_exec — DDL / migration runner. Hard-gated.
// ---------------------------------------------------------------------------
//
// Refuses to run without `config.allowDDL === true`. Intended for one-shot
// schema setup, NOT for use inside synchronous or hot-path pipelines.
// Pipelines that include this node should typically NOT be MCP-exposed —
// the doc explains why and how to prevent it (set `metadata.mcpExpose:
// false`, which is also the default).
export const postgresExecPlugin: InProcessPlugin = {
  manifest: {
    id: "postgres_exec",
    name: "Postgres Exec (DDL)",
    version: "1.0.0",
    category: "tool",
    description:
      "Runs DDL / one-shot SQL statements against an external Postgres. Hard-gated by `allowDDL: true` to prevent accidental destructive runs. NOT recommended inside synchronous or MCP-exposed pipelines.",
    configSchema: {
      type: "object",
      required: ["statements", "allowDDL"],
      properties: {
        connection: { type: "string", default: "default", description: "Operator-facing label." },
        statements: {
          type: "array",
          items: { type: "string" },
          description: "Ordered list of SQL statements to execute, each as its own round-trip."
        },
        allowDDL: {
          type: "boolean",
          description:
            "Must be set to the literal true to authorise execution. Any other value (including undefined) refuses the run with a clear error."
        }
      },
      additionalProperties: false
    },
    secretsSchema: POSTGRES_SECRETS_SCHEMA,
    outputPorts: [
      { name: "executed", description: "Count of statements executed successfully." }
    ],
    capabilities: ["dangerous", "setup"],
    ui: {
      icon: "database",
      color: "#9333ea",
      paletteGroup: "External data",
      formHints: {
        statements: { widget: "textarea", rows: 6 },
        allowDDL: { widget: "checkbox" }
      }
    }
  },
  async execute(input) {
    const { config, secrets } = input;
    if (config.allowDDL !== true) {
      throw new Error(
        "postgres_exec refused: set `config.allowDDL: true` (literal) to authorise DDL execution."
      );
    }
    const statementsRaw = config.statements;
    if (!Array.isArray(statementsRaw) || statementsRaw.length === 0) {
      throw new Error("postgres_exec requires `config.statements` to be a non-empty array.");
    }
    const statements = statementsRaw.map((stmt, i) => {
      if (typeof stmt !== "string" || stmt.trim().length === 0) {
        throw new Error(`postgres_exec config.statements[${i}] must be a non-empty string.`);
      }
      return stmt;
    });

    const dsn = dsnFromSecrets(secrets);
    const entry = await getPool({ dsn, name: connectionLabel(config) });
    const client = await acquire(entry);
    let executed = 0;
    const startedAt = Date.now();
    try {
      for (const statement of statements) {
        await client.query(statement);
        executed += 1;
      }
      return {
        outputs: { executed },
        metadata: {
          connection: connectionLabel(config),
          latencyMs: Date.now() - startedAt,
          poolAcquireWaitMs: entry.acquireWaitMs,
          poolAcquireCount: entry.acquireCount
        }
      };
    } finally {
      client.release();
    }
  }
};
