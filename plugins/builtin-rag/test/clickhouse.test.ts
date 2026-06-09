/**
 * ClickHouse plugin family — manifests + execute paths via a stubbed
 * driver registered through the public registerConnectionDriver API.
 * Like the mongo tests, this never starts a real ClickHouse process.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  clickhouseQueryPlugin,
  clickhouseInsertPlugin,
  clickhouseDeletePlugin
} from "../src/index.ts";
import {
  registerConnectionDriver,
  resetConnectionRegistry
} from "../../../packages/external-connections/src/index.ts";
import type { PluginExecutionInput } from "../../../packages/plugin-sdk/src/index.ts";

interface Stub {
  queries: Array<{ query: string; params: any; format?: string }>;
  inserts: Array<{ table: string; values: any[] }>;
  commands: Array<{ query: string; params: any }>;
  queryResult: any[];
}

function buildStub(seed: Partial<Stub> = {}): { stub: Stub; client: any } {
  const stub: Stub = {
    queries: [],
    inserts: [],
    commands: [],
    queryResult: seed.queryResult ?? []
  };
  const client = {
    query: async (req: any) => {
      stub.queries.push({ query: req.query, params: req.query_params, format: req.format });
      return { json: async () => stub.queryResult };
    },
    insert: async (req: any) => {
      stub.inserts.push({ table: req.table, values: req.values });
    },
    command: async (req: any) => {
      stub.commands.push({ query: req.query, params: req.query_params });
    },
    close: async () => undefined,
    ping: async () => ({ success: true })
  };
  return { stub, client };
}

function makeInput(args: {
  pluginId: string;
  config: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  hasConnection?: boolean;
}): PluginExecutionInput {
  return {
    context: {
      executionId: "e1",
      requestId: "r1",
      tenantId: "tenant-xyz",
      pipelineId: "p1",
      pipelineVersionId: "v1",
      environment: "dev",
      resolvedConfig: {
        pipelineId: "p1",
        tenantId: "tenant-xyz",
        environment: "dev",
        values: {},
        violations: []
      }
    },
    node: {
      id: "ch",
      plugin: { category: "retriever", id: args.pluginId, version: "1.0.0" }
    },
    inputs: args.inputs ?? {},
    config: args.config,
    secrets: {},
    connection:
      args.hasConnection === false
        ? undefined
        : {
            id: "conn-ch-1",
            slug: "warehouse",
            kind: "clickhouse",
            secret: "secret-pass",
            options: { url: "http://localhost:8123", database: "events" },
            cascadeReason: "tenant"
          }
  };
}

function withFakeDriver(client: any, run: () => Promise<void>): Promise<void> {
  resetConnectionRegistry();
  registerConnectionDriver("clickhouse", {
    async create() {
      return client;
    },
    async dispose(c: any) {
      await c.close?.();
    }
  });
  return run().finally(() => resetConnectionRegistry());
}

// Manifests --------------------------------------------------------------

test("manifests advertise contract: 2 + required fields", () => {
  assert.equal(clickhouseQueryPlugin.manifest.contract, 2);
  assert.equal(clickhouseInsertPlugin.manifest.contract, 2);
  assert.equal(clickhouseDeletePlugin.manifest.contract, 2);
  const qSchema = clickhouseQueryPlugin.manifest.configSchema as any;
  assert.deepEqual(qSchema.required, ["sql"]);
  const dSchema = clickhouseDeletePlugin.manifest.configSchema as any;
  assert.deepEqual(dSchema.required.sort(), ["table", "where"]);
});

// Execute paths ----------------------------------------------------------

test("clickhouse_query: passes SQL + merged params + format through", async () => {
  const { client, stub } = buildStub({
    queryResult: [{ id: 1 }, { id: 2 }]
  });
  await withFakeDriver(client, async () => {
    const out = await clickhouseQueryPlugin.execute(
      makeInput({
        pluginId: "clickhouse_query",
        config: {
          sql: "SELECT * FROM events WHERE day = {day:Date} AND tenant = {tenant:String}",
          params: { tenant: "static-tenant" }
        },
        inputs: { params: { day: "2026-06-01", tenant: "runtime-wins" } }
      })
    );
    assert.equal(out.outputs.count, 2);
    assert.equal(stub.queries.length, 1);
    // Runtime params win over static.
    assert.equal(stub.queries[0].params.tenant, "runtime-wins");
    assert.equal(stub.queries[0].params.day, "2026-06-01");
    assert.equal(stub.queries[0].format, "JSONEachRow");
  });
});

test("clickhouse_insert: sends rows via insert(); empty input is a no-op", async () => {
  const { client, stub } = buildStub();
  await withFakeDriver(client, async () => {
    const out = await clickhouseInsertPlugin.execute(
      makeInput({
        pluginId: "clickhouse_insert",
        config: { table: "events" },
        inputs: { rows: [{ id: 1 }, { id: 2 }, { id: 3 }] }
      })
    );
    assert.equal(out.outputs.insertedCount, 3);
    assert.equal(stub.inserts[0].table, "events");
    assert.equal(stub.inserts[0].values.length, 3);
    // Empty path:
    const empty = await clickhouseInsertPlugin.execute(
      makeInput({
        pluginId: "clickhouse_insert",
        config: { table: "events" },
        inputs: { rows: [] }
      })
    );
    assert.equal(empty.outputs.insertedCount, 0);
    assert.equal(stub.inserts.length, 1); // unchanged
  });
});

test("clickhouse_delete: AND-s a tenant guard onto the user where clause + binds the param", async () => {
  const { client, stub } = buildStub();
  await withFakeDriver(client, async () => {
    await clickhouseDeletePlugin.execute(
      makeInput({
        pluginId: "clickhouse_delete",
        config: {
          table: "events",
          where: "doc_id IN {ids:Array(String)}",
          params: { ids: ["a", "b"] }
        }
      })
    );
    assert.equal(stub.commands.length, 1);
    const { query, params } = stub.commands[0];
    assert.match(query, /^ALTER TABLE events DELETE WHERE /);
    assert.match(query, /tenant_id = \{__rgd_tenant_id:String\}/);
    assert.equal(params.__rgd_tenant_id, "tenant-xyz");
    assert.deepEqual(params.ids, ["a", "b"]);
  });
});

test("clickhouse_delete: tenantColumn='' disables the guard (escape hatch)", async () => {
  const { client, stub } = buildStub();
  await withFakeDriver(client, async () => {
    await clickhouseDeletePlugin.execute(
      makeInput({
        pluginId: "clickhouse_delete",
        config: {
          table: "events",
          where: "doc_id = {id:String}",
          params: { id: "x" },
          tenantColumn: ""
        }
      })
    );
    const { query, params } = stub.commands[0];
    assert.equal(query, "ALTER TABLE events DELETE WHERE doc_id = {id:String}");
    assert.equal(params.__rgd_tenant_id, undefined);
  });
});

test("missing connection / wrong-kind connection -> clear errors", async () => {
  const { client } = buildStub();
  await withFakeDriver(client, async () => {
    await assert.rejects(
      clickhouseQueryPlugin.execute(
        makeInput({
          pluginId: "clickhouse_query",
          config: { sql: "SELECT 1" },
          hasConnection: false
        })
      ),
      /missing connection/
    );
    const wrongKind = makeInput({
      pluginId: "clickhouse_query",
      config: { sql: "SELECT 1" }
    });
    (wrongKind as any).connection.kind = "mongodb";
    await assert.rejects(
      clickhouseQueryPlugin.execute(wrongKind),
      /expected connection\.kind="clickhouse"/
    );
  });
});
