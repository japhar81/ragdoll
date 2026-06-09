/**
 * ClickHouse plugin family — ADR-0021's second non-Postgres family.
 *
 * Three plugins, all v2:
 *
 *   clickhouse_query  — SELECT with parameter binding (tool-shaped read)
 *   clickhouse_insert — bulk INSERT from inputs.rows
 *   clickhouse_delete — ALTER TABLE … DELETE WHERE … (lightweight delete)
 *
 * Connection contract (via input.connection):
 *   - kind === "clickhouse"
 *   - secret -> password (optional — ClickHouse default user has no password)
 *   - options ->
 *       url:      string         "http(s)://host:port" (required)
 *       database: string         default "default"
 *       username: string         default "default"
 *
 * SQL safety:
 *   - clickhouse_query takes `sql` + `params` (parameterized via `{name:Type}`
 *     placeholders, NOT string interpolation). The official client supports
 *     parameterized queries with type hints — we expose them verbatim.
 *   - clickhouse_insert takes `table` + `rows`; rows are sent through the
 *     client's JSONEachRow path, no SQL string concatenation in plugin code.
 *   - clickhouse_delete takes `table` + `where` + `params`. The `where`
 *     clause is the operator's contract — same as raw SQL plugins
 *     elsewhere — but parameter binding is enforced.
 */

import type { InProcessPlugin } from "../../../../packages/plugin-sdk/src/index.ts";
import { registerConnectionDriver } from "../../../../packages/external-connections/src/index.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type ClickHouseClient = any;

interface ClickHouseConnectionOptions {
  url?: string;
  database?: string;
  username?: string;
}

registerConnectionDriver<ClickHouseClient>(
  "clickhouse",
  {
    async create(conn) {
      const opts = (conn.options ?? {}) as ClickHouseConnectionOptions;
      if (!opts.url) {
        throw new Error(
          `clickhouse connection "${conn.slug}" missing options.url (e.g. "http://localhost:8123")`
        );
      }
      const mod = (await import("@clickhouse/client")) as {
        createClient: (cfg: Record<string, unknown>) => ClickHouseClient;
      };
      return mod.createClient({
        url: opts.url,
        database: opts.database ?? "default",
        username: opts.username ?? "default",
        // Password is the only secret. ClickHouse accepts no-auth setups; an
        // absent secret is therefore legal — many local installs run that way.
        password: conn.secret ?? ""
      });
    },
    async dispose(client) {
      await client.close().catch(() => undefined);
    },
    async probe(client) {
      // ClickHouse's canonical liveness check.
      await client.ping();
    }
  },
  {
    displayName: "ClickHouse",
    description:
      "Analytics database. Used by clickhouse_query / clickhouse_insert / clickhouse_delete.",
    configSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Base URL — e.g. http://localhost:8123."
        },
        database: {
          type: "string",
          default: "default",
          description: "Default database. Plugins may override per-query."
        },
        username: {
          type: "string",
          default: "default",
          description: "Username for HTTP auth. Password lives in the secret ref."
        }
      },
      required: ["url"],
      additionalProperties: false
    },
    secretSchema: {
      type: "string",
      description: "Password for the configured username. Optional (no-auth installs)."
    },
    datasetBindings: [],
    transport: "in_process"
  }
);

function requireClickHouseConnection(
  input: { connection?: { kind: string } },
  pluginId: string
): asserts input is {
  connection: {
    kind: string;
    id: string;
    slug: string;
    options: Record<string, unknown>;
    secret?: string;
  };
} {
  if (!input.connection) {
    throw new Error(
      `${pluginId}: node missing connection — add \`connection: { slug: ... }\` to the spec`
    );
  }
  if (input.connection.kind !== "clickhouse") {
    throw new Error(
      `${pluginId}: expected connection.kind="clickhouse", got "${input.connection.kind}"`
    );
  }
}

// ===========================================================================
// clickhouse_query
// ===========================================================================

export const clickhouseQueryPlugin: InProcessPlugin = {
  manifest: {
    id: "clickhouse_query",
    name: "ClickHouse Query",
    version: "1.0.0",
    category: "retriever",
    contract: 2,
    description:
      "Runs a parameterized SELECT against ClickHouse and returns rows. Use {name:Type} placeholders in the SQL; pass values through inputs.params (preferred) or config.params.",
    configSchema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: "Parameterized SQL — use {name:Type} placeholders, e.g. 'SELECT * FROM events WHERE day = {day:Date}'."
        },
        format: {
          type: "string",
          default: "JSONEachRow",
          description: "Result format. JSONEachRow is the platform default."
        },
        params: {
          type: "object",
          description: "Static parameter bindings merged with inputs.params at execute time."
        }
      },
      required: ["sql"],
      additionalProperties: false
    },
    inputPorts: [
      { name: "params", description: "Runtime parameter overrides (wins over config.params)." }
    ],
    outputPorts: [
      { name: "rows", description: "Array of result rows." },
      { name: "count", description: "Number of rows returned." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "database",
      formHints: {
        sql: { widget: "textarea" },
        params: { widget: "textarea" }
      }
    }
  },
  async execute(input) {
    requireClickHouseConnection(input, "clickhouse_query");
    const { acquireClient } = await import(
      "../../../../packages/external-connections/src/index.ts"
    );
    const client = await acquireClient<ClickHouseClient>(input.connection);
    const sql = String(input.config.sql);
    const staticParams =
      input.config.params && typeof input.config.params === "object"
        ? (input.config.params as Record<string, unknown>)
        : {};
    const runtimeParams =
      input.inputs.params && typeof input.inputs.params === "object"
        ? (input.inputs.params as Record<string, unknown>)
        : {};
    const queryParams = { ...staticParams, ...runtimeParams };
    const res = await client.query({
      query: sql,
      query_params: queryParams,
      format: String(input.config.format ?? "JSONEachRow")
    });
    const rows = (await res.json()) as unknown[];
    return { outputs: { rows, count: rows.length } };
  }
};

// ===========================================================================
// clickhouse_insert
// ===========================================================================

export const clickhouseInsertPlugin: InProcessPlugin = {
  manifest: {
    id: "clickhouse_insert",
    name: "ClickHouse Insert",
    version: "1.0.0",
    category: "sink",
    contract: 2,
    description:
      "Bulk-inserts rows from inputs.rows into a ClickHouse table. Uses the client's JSONEachRow path — no SQL string concatenation.",
    configSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Target table name (qualified or unqualified)." }
      },
      required: ["table"],
      additionalProperties: false
    },
    inputPorts: [
      { name: "rows", required: true, description: "Array of row objects to insert." }
    ],
    outputPorts: [
      { name: "insertedCount", description: "Number of rows submitted (ClickHouse confirms async)." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "database",
      formHints: { table: { widget: "text" } }
    }
  },
  async execute(input) {
    requireClickHouseConnection(input, "clickhouse_insert");
    const { acquireClient } = await import(
      "../../../../packages/external-connections/src/index.ts"
    );
    const client = await acquireClient<ClickHouseClient>(input.connection);
    const table = String(input.config.table);
    const rows = Array.isArray(input.inputs.rows) ? input.inputs.rows : [];
    if (rows.length === 0) return { outputs: { insertedCount: 0 } };
    await client.insert({
      table,
      values: rows,
      format: "JSONEachRow"
    });
    return { outputs: { insertedCount: rows.length } };
  }
};

// ===========================================================================
// clickhouse_delete
// ===========================================================================

export const clickhouseDeletePlugin: InProcessPlugin = {
  manifest: {
    id: "clickhouse_delete",
    name: "ClickHouse Delete",
    version: "1.0.0",
    category: "sink",
    contract: 2,
    description:
      "Runs a lightweight DELETE against ClickHouse via `ALTER TABLE … DELETE WHERE`. Tenant-scoped: the `where` clause is AND-ed with `tenant_id = {tenant_id:String}` if a `tenantColumn` is configured (default: `tenant_id`).",
    configSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Target table." },
        where: {
          type: "string",
          description: "WHERE clause — use {name:Type} placeholders. e.g. 'doc_id IN {ids:Array(String)}'."
        },
        params: {
          type: "object",
          description: "Parameter bindings for the WHERE clause."
        },
        tenantColumn: {
          type: "string",
          default: "tenant_id",
          description: "Column the executing tenant id is compared against. Set to empty to disable the tenant guard (NOT recommended)."
        }
      },
      required: ["table", "where"],
      additionalProperties: false
    },
    outputPorts: [
      { name: "ok", description: "True when the DELETE statement was accepted (ClickHouse async)." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "trash",
      color: "#dc2626",
      formHints: {
        table: { widget: "text" },
        where: { widget: "textarea" },
        params: { widget: "textarea" }
      }
    }
  },
  async execute(input) {
    requireClickHouseConnection(input, "clickhouse_delete");
    const { acquireClient } = await import(
      "../../../../packages/external-connections/src/index.ts"
    );
    const client = await acquireClient<ClickHouseClient>(input.connection);
    const table = String(input.config.table);
    const tenantColumn = String(input.config.tenantColumn ?? "tenant_id");
    const baseWhere = String(input.config.where);
    const where = tenantColumn
      ? `(${baseWhere}) AND ${tenantColumn} = {__rgd_tenant_id:String}`
      : baseWhere;
    const baseParams =
      input.config.params && typeof input.config.params === "object"
        ? (input.config.params as Record<string, unknown>)
        : {};
    const params = tenantColumn
      ? { ...baseParams, __rgd_tenant_id: input.context.tenantId }
      : baseParams;
    await client.command({
      query: `ALTER TABLE ${table} DELETE WHERE ${where}`,
      query_params: params
    });
    return { outputs: { ok: true } };
  }
};
