/**
 * Dgraph plugins for the `graph` modality.
 *
 *  * `dgraph_upsert` — sink. Takes an array of nodes (and optional
 *    edges) and writes them to the configured graph backend. Every
 *    node gets the executing tenant id stamped on `tenant_id` so the
 *    store can enforce per-tenant isolation on reads + cleanup.
 *
 *  * `dgraph_query` — retriever. Runs a DQL query (the operator
 *    writes the query string in config); emits the data block back
 *    as `results`. The tenantId is exposed to the query via the
 *    `$tenant_id` variable so queries can filter without the operator
 *    knowing the platform's internal IDs.
 *
 * Both plugins declare `contract: 2` + `datasetModalities: ["graph"]`,
 * so the Builder's slug picker only offers datasets whose modalities
 * include `graph` and the validator catches mis-wired pipelines at
 * edit time.
 */
import type {
  InProcessPlugin,
  PluginExecutionInput
} from "../../../packages/plugin-sdk/src/index.ts";
import {
  createGraphStore,
  type GraphNode,
  type GraphStore
} from "../../../packages/graph/src/index.ts";

/** Per-execution store cache: a real Dgraph connection is heavier
 *  than the in-memory store; reuse the same instance for the rest
 *  of the execution. Keyed by URL so two executions with different
 *  DGRAPH_URLs still get distinct stores. */
const STORE_CACHE = new Map<string, GraphStore>();
function getStore(url: string | undefined): GraphStore {
  const key = url ?? "(memory)";
  let store = STORE_CACHE.get(key);
  if (!store) {
    store = createGraphStore({ url });
    STORE_CACHE.set(key, store);
  }
  return store;
}

/** Test-only: clear the cached stores so each test gets a fresh
 *  in-memory graph. Don't call this in production code. */
export function resetGraphStoreCache(): void {
  STORE_CACHE.clear();
}

function pickGraphUrl(input: PluginExecutionInput): string | undefined {
  // Three ways to point the plugin at a Dgraph endpoint, in order:
  //   1. explicit `config.url` on the node;
  //   2. the resolved dataset's `backends.graph.url` (so a per-env
  //      override on the Datasets screen flows through);
  //   3. the platform default DGRAPH_URL env, picked by
  //      createGraphStore when the explicit ones are missing.
  const cfgUrl = (input.config as { url?: unknown } | undefined)?.url;
  if (typeof cfgUrl === "string" && cfgUrl) return cfgUrl;
  const backend = (input.dataset as
    | { backends?: { graph?: { url?: string } } }
    | undefined)?.backends?.graph;
  if (backend?.url) return backend.url;
  return undefined;
}

// ===========================================================================
// dgraph_upsert
// ===========================================================================

export const dgraphUpsertPlugin: InProcessPlugin = {
  manifest: {
    id: "dgraph_upsert",
    name: "Dgraph Upsert",
    version: "1.0.0",
    category: "sink",
    contract: 2,
    datasetModalities: ["graph"],
    description:
      "Writes nodes (and edges, encoded as nested-object arrays under the predicate name) into Dgraph. Stamps `tenant_id` on every node so multi-tenant isolation is enforced at the storage layer.",
    configSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Dgraph HTTP endpoint. Falls back to the dataset's graph backend, then to the DGRAPH_URL env, then to the in-memory store."
        },
        schema: {
          type: "string",
          description:
            "Optional DQL schema fragment applied via /alter before the first write. Idempotent on Dgraph's side. Use this to declare indexed predicates."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      {
        name: "nodes",
        required: true,
        description:
          "Array of node objects. Each may carry `uid` (real or `_:alias`), `dgraph.type`, and arbitrary predicate fields."
      }
    ],
    outputPorts: [
      {
        name: "upserted",
        description: "Count of nodes accepted by the mutation."
      },
      {
        name: "uids",
        description:
          "Map of `_:alias` → real uid for every blank-node reference Dgraph minted on this call."
      }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "share-2",
      color: "#7c3aed",
      paletteGroup: "Graph",
      formHints: {
        url: { widget: "text" },
        schema: { widget: "code" }
      }
    }
  },
  async execute(input) {
    const { inputs, config, context } = input;
    const store = getStore(pickGraphUrl(input));
    const schema = (config as { schema?: string }).schema;
    if (schema && store.alterSchema) {
      // /alter is idempotent in Dgraph; we still wrap so an in-memory
      // store (no alterSchema) silently no-ops.
      await store.alterSchema(schema);
    }
    const nodes = (inputs.nodes as GraphNode[] | undefined) ?? [];
    if (!Array.isArray(nodes) || nodes.length === 0) {
      return { outputs: { upserted: 0, uids: {} } };
    }
    const { uids } = await store.mutate({
      tenantId: context.tenantId,
      setJson: nodes
    });
    return { outputs: { upserted: nodes.length, uids } };
  }
};

// ===========================================================================
// dgraph_query
// ===========================================================================

export const dgraphQueryPlugin: InProcessPlugin = {
  manifest: {
    id: "dgraph_query",
    name: "Dgraph Query",
    version: "1.0.0",
    category: "retriever",
    contract: 2,
    datasetModalities: ["graph"],
    description:
      "Runs a DQL query against Dgraph and emits the data block as `results`. The current tenantId is exposed to the query as `$tenant_id` so queries can filter without hardcoding ids.",
    configSchema: {
      type: "object",
      required: ["query"],
      properties: {
        url: {
          type: "string",
          description:
            "Dgraph HTTP endpoint. Same fallback chain as dgraph_upsert."
        },
        query: {
          type: "string",
          description:
            "DQL query. Use `$tenant_id` as a variable to scope to the executing tenant."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      {
        name: "vars",
        description:
          "Optional map of GraphQL-style variables forwarded to the query. `$tenant_id` is always overwritten by the platform."
      }
    ],
    outputPorts: [
      { name: "results", description: "Raw `data` block returned by Dgraph." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "search",
      color: "#7c3aed",
      paletteGroup: "Graph",
      formHints: {
        url: { widget: "text" },
        query: { widget: "code" }
      }
    }
  },
  async execute(input) {
    const { inputs, config, context } = input;
    const query = String((config as { query?: unknown }).query ?? "");
    if (!query) {
      throw new Error("dgraph_query: `query` is required");
    }
    const store = getStore(pickGraphUrl(input));
    const vars = (inputs.vars as Record<string, string> | undefined) ?? {};
    const results = await store.query({
      tenantId: context.tenantId,
      query,
      vars
    });
    return { outputs: { results } };
  }
};
