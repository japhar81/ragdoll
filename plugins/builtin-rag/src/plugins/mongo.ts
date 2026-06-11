/**
 * MongoDB plugin family — ADR-0021's first non-Postgres family.
 *
 * Four plugins, all v2 (contract: 2), all consuming a registered
 * external connection via `input.connection`:
 *
 *   mongo_find      — read documents (retriever-shaped)
 *   mongo_insert    — write documents (ingest sink)
 *   mongo_delete    — delete documents (delta-aware, matches qdrant_delete)
 *   mongo_aggregate — run an aggregation pipeline (transformer)
 *
 * Connection contract:
 *   - Pipeline node carries `connection: { slug }`.
 *   - The runtime resolves it via the env -> tenant -> global cascade
 *     and hands the plugin a ResolvedExternalConnection on
 *     `input.connection`. We expect:
 *       * connection.kind === "mongodb"
 *       * connection.secret  -> a `mongodb://` URI (URI may carry creds)
 *       * connection.options -> { database: string, ... }
 *
 * Driver pool:
 *   - `registerConnectionDriver("mongodb", mongoDriver)` runs once at
 *     module load. The driver factory builds a MongoClient per
 *     connection.id; the runtime caches it. Two pipelines using the
 *     SAME connection share one client; different connections (even
 *     pointing at the same URI by accident) get different clients.
 *
 * Lazy import:
 *   - The `mongodb` npm module is imported inside the driver factory
 *     so unit tests that never construct a Mongo client stay
 *     install-free. The package is in `dependencies`, not
 *     `devDependencies` — production needs it.
 */

import type { InProcessPlugin } from "../../../../packages/plugin-sdk/src/index.ts";
import { defineConnectionDriverPlugin } from "../../../../packages/external-connections/src/index.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type MongoClient = any;
type Db = any;

interface MongoConnectionOptions {
  database?: string;
  appName?: string;
  maxPoolSize?: number;
}

// Driver: builds (and pools) one MongoClient per connection.id.
// Shipped as an ADR-0024 connection-driver plugin: the loader auto-
// discovers it through the standard module scan, registers the driver
// hooks into the imperative driver map, and surfaces the manifest under
// /api/plugins + /api/connection-kinds so the Connections UI renders a
// schema-driven form (database / appName / maxPoolSize) without
// hand-rolled per-kind TSX.
export const mongodbConnectionDriver = defineConnectionDriverPlugin<MongoClient>({
  kind: "mongodb",
  driver: {
    async create(conn) {
      if (!conn.secret) {
        throw new Error(
          `mongodb connection "${conn.slug}" has no secret — set a secretRefKey pointing at the URI`
        );
      }
      const opts = (conn.options ?? {}) as MongoConnectionOptions;
      const mod = (await import("mongodb")) as { MongoClient: new (uri: string, opts?: any) => MongoClient };
      const client = new mod.MongoClient(conn.secret, {
        appName: opts.appName ?? "ragdoll",
        maxPoolSize: opts.maxPoolSize ?? 10
      });
      await client.connect();
      return client;
    },
    async dispose(client) {
      await client.close().catch(() => undefined);
    },
    async probe(client) {
      // `admin().ping()` is the canonical liveness check.
      await client.db("admin").command({ ping: 1 });
    }
  },
  manifest: {
    displayName: "MongoDB",
    description:
      "Document store. Used by mongo_find / mongo_insert / mongo_delete / mongo_aggregate.",
    configSchema: {
      type: "object",
      properties: {
        database: {
          type: "string",
          description: "Default database name. Plugins read input.connection.options.database."
        },
        appName: {
          type: "string",
          default: "ragdoll",
          description: "appName advertised to the server (visible in mongostat)."
        },
        maxPoolSize: {
          type: "integer",
          default: 10,
          description: "Maximum pool size for the underlying driver."
        }
      },
      required: ["database"],
      additionalProperties: false
    },
    secretSchema: {
      type: "string",
      description: "mongodb:// or mongodb+srv:// URI (may include credentials)."
    },
    // Mongo today is a tool-only kind — no Dataset binding wires through
    // to mongo_*. Atlas Vector Search support would add "vectors" here.
    datasetBindings: [],
    transport: "in_process"
  }
});

function dbFor(client: MongoClient, conn: { options: Record<string, unknown> }): Db {
  const dbName = String(conn.options.database ?? "");
  if (!dbName) {
    throw new Error(
      `mongodb plugin: connection.options.database is required (none set)`
    );
  }
  return client.db(dbName);
}

/** Require a registered, kind-checked external connection on input. */
function requireMongoConnection(
  input: { connection?: { kind: string } },
  pluginId: string
): asserts input is { connection: { kind: string; id: string; slug: string; options: Record<string, unknown>; secret?: string } } {
  if (!input.connection) {
    throw new Error(
      `${pluginId}: node missing connection — add \`connection: { slug: ... }\` to the spec`
    );
  }
  if (input.connection.kind !== "mongodb") {
    throw new Error(
      `${pluginId}: expected connection.kind="mongodb", got "${input.connection.kind}"`
    );
  }
}

// ===========================================================================
// mongo_find
// ===========================================================================

export const mongoFindPlugin: InProcessPlugin = {
  manifest: {
    id: "mongo_find",
    name: "MongoDB Find",
    version: "1.0.0",
    category: "retriever",
    contract: 2,
    description:
      "Reads documents from a MongoDB collection via find(). Connection is supplied through ADR-0021 external connections; query is interpolated from `inputs.filter` (a JSON object) merged with `config.filter`.",
    configSchema: {
      type: "object",
      properties: {
        collection: {
          type: "string",
          description: "Collection name to query."
        },
        filter: {
          type: "object",
          description: "Static filter merged with inputs.filter at execute time."
        },
        projection: {
          type: "object",
          description: "MongoDB projection — { field: 1, _id: 0 }."
        },
        limit: { type: "integer", default: 100 },
        sort: {
          type: "object",
          description: "Sort spec — { createdAt: -1 }."
        }
      },
      required: ["collection"],
      additionalProperties: false
    },
    inputPorts: [
      { name: "filter", description: "Optional runtime filter merged onto config.filter (runtime wins)." }
    ],
    outputPorts: [
      { name: "documents", description: "Array of result documents." },
      { name: "count", description: "Number of documents returned." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "database",
      formHints: {
        collection: { widget: "text" },
        filter: { widget: "textarea" },
        projection: { widget: "textarea" },
        sort: { widget: "textarea" },
        limit: { widget: "number", min: 1 }
      }
    }
  },
  async execute(input) {
    requireMongoConnection(input, "mongo_find");
    const { acquireClient } = await import(
      "../../../../packages/external-connections/src/index.ts"
    );
    const client = await acquireClient<MongoClient>(input.connection);
    const db = dbFor(client, input.connection);
    const collectionName = String(input.config.collection);
    const runtimeFilter =
      input.inputs.filter && typeof input.inputs.filter === "object"
        ? (input.inputs.filter as Record<string, unknown>)
        : {};
    const staticFilter =
      input.config.filter && typeof input.config.filter === "object"
        ? (input.config.filter as Record<string, unknown>)
        : {};
    const filter = { ...staticFilter, ...runtimeFilter };
    let cursor = db.collection(collectionName).find(filter);
    if (input.config.projection) cursor = cursor.project(input.config.projection);
    if (input.config.sort) cursor = cursor.sort(input.config.sort);
    cursor = cursor.limit(Number(input.config.limit ?? 100));
    const documents = await cursor.toArray();
    return { outputs: { documents, count: documents.length } };
  }
};

// ===========================================================================
// mongo_insert
// ===========================================================================

export const mongoInsertPlugin: InProcessPlugin = {
  manifest: {
    id: "mongo_insert",
    name: "MongoDB Insert",
    version: "1.0.0",
    category: "sink",
    contract: 2,
    description:
      "Inserts documents into a MongoDB collection. Uses insertMany for batches; documents come from inputs.documents.",
    configSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Target collection name." },
        ordered: {
          type: "boolean",
          default: false,
          description: "MongoDB ordered insert (true = fail-fast on first error)."
        }
      },
      required: ["collection"],
      additionalProperties: false
    },
    inputPorts: [
      {
        name: "documents",
        required: true,
        description: "Array of documents to insert."
      }
    ],
    outputPorts: [
      { name: "insertedCount", description: "Number of documents persisted." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "database",
      formHints: {
        collection: { widget: "text" }
      }
    }
  },
  async execute(input) {
    requireMongoConnection(input, "mongo_insert");
    const { acquireClient } = await import(
      "../../../../packages/external-connections/src/index.ts"
    );
    const client = await acquireClient<MongoClient>(input.connection);
    const db = dbFor(client, input.connection);
    const collectionName = String(input.config.collection);
    const docs = Array.isArray(input.inputs.documents) ? input.inputs.documents : [];
    if (docs.length === 0) return { outputs: { insertedCount: 0 } };
    const result = await db
      .collection(collectionName)
      .insertMany(docs, { ordered: Boolean(input.config.ordered) });
    return { outputs: { insertedCount: result.insertedCount ?? docs.length } };
  }
};

// ===========================================================================
// mongo_delete
// ===========================================================================

export const mongoDeletePlugin: InProcessPlugin = {
  manifest: {
    id: "mongo_delete",
    name: "MongoDB Delete",
    version: "1.0.0",
    category: "sink",
    contract: 2,
    description:
      "Deletes documents from a MongoDB collection. Two modes: by filter (config.filter), or by docId list (inputs.deleted: [{docId}], matching delta_filter's output shape). Tenant-scoped: every delete includes a tenantId equality filter as defense-in-depth.",
    configSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Target collection name." },
        filter: {
          type: "object",
          description: "Optional static filter merged with the tenantId guard."
        },
        docIdField: {
          type: "string",
          default: "docId",
          description: "Document field that holds the docId (for the inputs.deleted path)."
        }
      },
      required: ["collection"],
      additionalProperties: false
    },
    inputPorts: [
      { name: "deleted", description: "Array of { docId } entries from delta_filter.deleted." }
    ],
    outputPorts: [
      { name: "deletedCount", description: "Number of documents removed." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "trash",
      color: "#dc2626",
      formHints: { collection: { widget: "text" }, filter: { widget: "textarea" } }
    }
  },
  async execute(input) {
    requireMongoConnection(input, "mongo_delete");
    const { acquireClient } = await import(
      "../../../../packages/external-connections/src/index.ts"
    );
    const client = await acquireClient<MongoClient>(input.connection);
    const db = dbFor(client, input.connection);
    const collectionName = String(input.config.collection);
    const tenantId = input.context.tenantId;
    const docIdField = String(input.config.docIdField ?? "docId");
    let filter: Record<string, unknown>;
    const deleted = input.inputs.deleted;
    if (Array.isArray(deleted) && deleted.length > 0) {
      const docIds = deleted
        .map((e: any) => (typeof e?.docId === "string" ? e.docId : undefined))
        .filter((id): id is string => !!id);
      if (docIds.length === 0) return { outputs: { deletedCount: 0 } };
      filter = { tenantId, [docIdField]: { $in: docIds } };
    } else if (
      input.config.filter &&
      typeof input.config.filter === "object"
    ) {
      filter = { tenantId, ...(input.config.filter as Record<string, unknown>) };
    } else {
      return { outputs: { deletedCount: 0 } };
    }
    const result = await db.collection(collectionName).deleteMany(filter);
    return { outputs: { deletedCount: result.deletedCount ?? 0 } };
  }
};

// ===========================================================================
// mongo_aggregate
// ===========================================================================

export const mongoAggregatePlugin: InProcessPlugin = {
  manifest: {
    id: "mongo_aggregate",
    name: "MongoDB Aggregate",
    version: "1.0.0",
    category: "transformer",
    contract: 2,
    description:
      "Runs a MongoDB aggregation pipeline. `config.pipeline` is the static stages; `inputs.extraStages` (optional) is appended at the end so a downstream node can filter results.",
    configSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Source collection." },
        pipeline: {
          type: "array",
          description: "Aggregation pipeline stages, e.g. [{ $match: { ... } }, { $group: { ... } }]."
        },
        allowDiskUse: {
          type: "boolean",
          default: false,
          description: "Permit aggregation stages to spill to disk on large datasets."
        }
      },
      required: ["collection", "pipeline"],
      additionalProperties: false
    },
    inputPorts: [
      { name: "extraStages", description: "Optional extra stages appended after config.pipeline." }
    ],
    outputPorts: [
      { name: "documents", description: "Aggregation result documents." },
      { name: "count", description: "Number of result documents." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "diagram",
      formHints: {
        collection: { widget: "text" },
        pipeline: { widget: "textarea" }
      }
    }
  },
  async execute(input) {
    requireMongoConnection(input, "mongo_aggregate");
    const { acquireClient } = await import(
      "../../../../packages/external-connections/src/index.ts"
    );
    const client = await acquireClient<MongoClient>(input.connection);
    const db = dbFor(client, input.connection);
    const collectionName = String(input.config.collection);
    const staticStages = Array.isArray(input.config.pipeline)
      ? (input.config.pipeline as unknown[])
      : [];
    const extra = Array.isArray(input.inputs.extraStages)
      ? (input.inputs.extraStages as unknown[])
      : [];
    const stages = [...staticStages, ...extra];
    const cursor = db.collection(collectionName).aggregate(stages, {
      allowDiskUse: Boolean(input.config.allowDiskUse)
    });
    const documents = await cursor.toArray();
    return { outputs: { documents, count: documents.length } };
  }
};
