/**
 * MongoDB plugin family — manifests + execute paths against a stubbed
 * client. The real driver lazy-imports `mongodb` inside its create()
 * factory, so this test never spawns a Mongo connection: we register a
 * fake driver for kind "mongodb" before each test that returns a stub
 * client matching the methods the plugins call.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mongoFindPlugin,
  mongoInsertPlugin,
  mongoDeletePlugin,
  mongoAggregatePlugin
} from "../src/index.ts";
import {
  registerConnectionDriver,
  resetConnectionRegistry
} from "../../../packages/external-connections/src/index.ts";
import type { PluginExecutionInput } from "../../../packages/plugin-sdk/src/index.ts";

interface Stub {
  inserts: Record<string, any[]>;
  deletes: Array<{ collection: string; filter: any }>;
  aggregates: Array<{ collection: string; pipeline: any[] }>;
  findResult: any[];
  aggregateResult: any[];
  insertedCount: number;
  deletedCount: number;
}

function buildStub(seed: Partial<Stub> = {}): { stub: Stub; client: any } {
  const stub: Stub = {
    inserts: {},
    deletes: [],
    aggregates: [],
    findResult: seed.findResult ?? [],
    aggregateResult: seed.aggregateResult ?? [],
    insertedCount: seed.insertedCount ?? 0,
    deletedCount: seed.deletedCount ?? 0
  };
  const client = {
    db: () => ({
      collection: (name: string) => ({
        find: () => ({
          project: () => ({
            sort: () => ({ limit: () => ({ toArray: async () => stub.findResult }) }),
            limit: () => ({ toArray: async () => stub.findResult })
          }),
          sort: () => ({ limit: () => ({ toArray: async () => stub.findResult }) }),
          limit: () => ({ toArray: async () => stub.findResult })
        }),
        insertMany: async (docs: any[]) => {
          stub.inserts[name] = [...(stub.inserts[name] ?? []), ...docs];
          return { insertedCount: stub.insertedCount || docs.length };
        },
        deleteMany: async (filter: any) => {
          stub.deletes.push({ collection: name, filter });
          return { deletedCount: stub.deletedCount };
        },
        aggregate: (pipeline: any[]) => {
          stub.aggregates.push({ collection: name, pipeline });
          return { toArray: async () => stub.aggregateResult };
        }
      })
    }),
    close: async () => undefined
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
      tenantId: "t1",
      pipelineId: "p1",
      pipelineVersionId: "v1",
      environment: "dev",
      resolvedConfig: {
        pipelineId: "p1",
        tenantId: "t1",
        environment: "dev",
        values: {},
        violations: []
      }
    },
    node: {
      id: "mongo",
      plugin: { category: "retriever", id: args.pluginId, version: "1.0.0" }
    },
    inputs: args.inputs ?? {},
    config: args.config,
    secrets: {},
    connection:
      args.hasConnection === false
        ? undefined
        : {
            id: "conn-1",
            slug: "acme",
            kind: "mongodb",
            secret: "mongodb://stub",
            options: { database: "acme" },
            cascadeReason: "global"
          }
  };
}

// All tests share the registry; reset between them so a previous test's
// stub doesn't leak.
function withFakeDriver(client: any, run: () => Promise<void>): Promise<void> {
  resetConnectionRegistry();
  registerConnectionDriver("mongodb", {
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

test("mongo_find manifest declares the expected ports", () => {
  assert.equal(mongoFindPlugin.manifest.id, "mongo_find");
  assert.equal(mongoFindPlugin.manifest.contract, 2);
  assert.equal(mongoFindPlugin.manifest.category, "retriever");
});

test("mongo_insert / mongo_delete are sinks with contract: 2", () => {
  assert.equal(mongoInsertPlugin.manifest.category, "sink");
  assert.equal(mongoDeletePlugin.manifest.category, "sink");
  assert.equal(mongoInsertPlugin.manifest.contract, 2);
  assert.equal(mongoDeletePlugin.manifest.contract, 2);
});

test("mongo_aggregate is a transformer with required pipeline + collection", () => {
  assert.equal(mongoAggregatePlugin.manifest.category, "transformer");
  const schema = mongoAggregatePlugin.manifest.configSchema as any;
  assert.deepEqual(schema.required.sort(), ["collection", "pipeline"]);
});

// Execute paths ----------------------------------------------------------

test("mongo_find: returns documents from the stubbed cursor", async () => {
  const { client, stub } = buildStub({ findResult: [{ _id: 1 }, { _id: 2 }] });
  await withFakeDriver(client, async () => {
    const out = await mongoFindPlugin.execute(
      makeInput({ pluginId: "mongo_find", config: { collection: "users" } })
    );
    assert.equal(out.outputs.count, 2);
    assert.equal((out.outputs.documents as any[]).length, 2);
    void stub;
  });
});

test("mongo_insert: forwards documents to insertMany + returns count", async () => {
  const { client, stub } = buildStub({ insertedCount: 3 });
  await withFakeDriver(client, async () => {
    const out = await mongoInsertPlugin.execute(
      makeInput({
        pluginId: "mongo_insert",
        config: { collection: "events" },
        inputs: { documents: [{ a: 1 }, { a: 2 }, { a: 3 }] }
      })
    );
    assert.equal(out.outputs.insertedCount, 3);
    assert.equal(stub.inserts.events.length, 3);
  });
});

test("mongo_insert: empty input -> short-circuits without touching the client", async () => {
  const { client, stub } = buildStub();
  await withFakeDriver(client, async () => {
    const out = await mongoInsertPlugin.execute(
      makeInput({
        pluginId: "mongo_insert",
        config: { collection: "events" },
        inputs: { documents: [] }
      })
    );
    assert.equal(out.outputs.insertedCount, 0);
    assert.equal(Object.keys(stub.inserts).length, 0);
  });
});

test("mongo_delete: inputs.deleted -> filter on { tenantId, docId: $in }", async () => {
  const { client, stub } = buildStub({ deletedCount: 2 });
  await withFakeDriver(client, async () => {
    await mongoDeletePlugin.execute(
      makeInput({
        pluginId: "mongo_delete",
        config: { collection: "chunks" },
        inputs: { deleted: [{ docId: "a" }, { docId: "b" }, { foo: "skip" }] }
      })
    );
    assert.equal(stub.deletes.length, 1);
    assert.equal(stub.deletes[0].filter.tenantId, "t1");
    assert.deepEqual(stub.deletes[0].filter.docId.$in.sort(), ["a", "b"]);
  });
});

test("mongo_delete: config.filter path merges tenantId guard", async () => {
  const { client, stub } = buildStub({ deletedCount: 1 });
  await withFakeDriver(client, async () => {
    await mongoDeletePlugin.execute(
      makeInput({
        pluginId: "mongo_delete",
        config: { collection: "logs", filter: { level: "debug" } }
      })
    );
    assert.equal(stub.deletes[0].filter.tenantId, "t1");
    assert.equal(stub.deletes[0].filter.level, "debug");
  });
});

test("mongo_aggregate: concatenates inputs.extraStages onto config.pipeline", async () => {
  const { client, stub } = buildStub({ aggregateResult: [{ count: 5 }] });
  await withFakeDriver(client, async () => {
    const out = await mongoAggregatePlugin.execute(
      makeInput({
        pluginId: "mongo_aggregate",
        config: {
          collection: "users",
          pipeline: [{ $match: { active: true } }]
        },
        inputs: { extraStages: [{ $count: "count" }] }
      })
    );
    assert.equal(out.outputs.count, 1);
    assert.equal(stub.aggregates[0].pipeline.length, 2);
  });
});

test("any mongo plugin without connection -> throws a clear error", async () => {
  const { client } = buildStub();
  await withFakeDriver(client, async () => {
    await assert.rejects(
      mongoFindPlugin.execute(
        makeInput({
          pluginId: "mongo_find",
          config: { collection: "x" },
          hasConnection: false
        })
      ),
      /missing connection/
    );
  });
});

test("any mongo plugin with wrong-kind connection -> throws a clear error", async () => {
  const { client } = buildStub();
  await withFakeDriver(client, async () => {
    // Override the connection kind in the input.
    const input = makeInput({ pluginId: "mongo_find", config: { collection: "x" } });
    (input as any).connection.kind = "clickhouse";
    await assert.rejects(mongoFindPlugin.execute(input), /expected connection\.kind="mongodb"/);
  });
});
