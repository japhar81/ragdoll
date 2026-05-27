/**
 * OpenSearch plugin family: BM25 lexical retriever, dense-vector
 * retriever, hybrid retriever (fuses both), plus a passthrough input
 * and an indexing output. The hybrid score-fusion math
 * (`fuseHybridResults`) lives here too so it's unit-testable directly.
 *
 * Extracted from index.ts to keep the OpenSearch-specific wiring (≈700
 * lines including the secrets schema, client factory, and question
 * extraction) out of the main barrel.
 */
import type { InProcessPlugin } from "../../../../packages/plugin-sdk/src/index.ts";
import type { DistanceMetric } from "../../../../packages/vector/src/index.ts";
import {
  OpenSearchClient,
  OpenSearchVectorStore,
  createOpenSearchClient
} from "../../../../packages/opensearch/src/index.ts";
import { pickBackendName } from "../dataset-binding.ts";
import { embedTexts } from "../helpers.ts";

const OPENSEARCH_SECRETS_SCHEMA = {
  type: "object",
  properties: {
    username: {
      type: "string",
      format: "secret-ref",
      description: "OpenSearch basic-auth username (omit for a security-disabled cluster)."
    },
    password: {
      type: "string",
      format: "secret-ref",
      description: "OpenSearch basic-auth password."
    },
    authorization: {
      type: "string",
      format: "secret-ref",
      description: "Raw Authorization header value (e.g. an API key). Overrides username/password."
    }
  },
  additionalProperties: false
} as const;

/** Build an OpenSearch client from loosely-typed plugin config + secrets, or throw. */
function openSearchClientFrom(
  config: Record<string, unknown>,
  secrets: Record<string, string>,
  resolved: Record<string, { value: unknown } | undefined>
): OpenSearchClient {
  const endpoint =
    (config.endpoint ? String(config.endpoint) : undefined) ??
    (resolved["opensearch.url"]?.value as string | undefined);
  const client = createOpenSearchClient({
    endpoint,
    username: secrets.username,
    password: secrets.password,
    authorization: secrets.authorization
  });
  if (!client) {
    throw new Error(
      "OpenSearch endpoint not configured (set config.endpoint, the opensearch.url config value, or the OPENSEARCH_URL env var)."
    );
  }
  return client;
}

function questionFrom(inputs: Record<string, unknown>): string {
  return String(
    inputs.question ?? (inputs.input as { question?: unknown } | undefined)?.question ?? inputs.text ?? ""
  );
}

/**
 * Build a tenant-isolation filter clause for BM25 / `_search` bool queries.
 * Matches whether the field was created as `keyword` (the shape
 * `opensearch_output` ensures) OR was left to OpenSearch's dynamic mapping,
 * which stores it as `text` with a `<field>.keyword` sub-field. A plain
 * `term` against the text parent silently 0-matches; we OR both shapes via
 * `bool.should` so either mapping works.
 */
function tenantFilterClause(tenantField: string, tenantId: string): Record<string, unknown> {
  return {
    bool: {
      should: [
        { term: { [tenantField]: tenantId } },
        { term: { [`${tenantField}.keyword`]: tenantId } }
      ],
      minimum_should_match: 1
    }
  };
}

/**
 * Build a tenant-isolation filter clause for the Lucene kNN engine, which
 * rejects compound `bool.should` queries inside `knn.filter` with a "Rewrite
 * first" exception. kNN-bearing indexes are always created by
 * `opensearch_output` (or fail validation up front), and that writer
 * guarantees `tenantId: keyword` — so a plain leaf `term` is correct and
 * safe here.
 */
function tenantFilterClauseForKnn(tenantField: string, tenantId: string): Record<string, unknown> {
  return { term: { [tenantField]: tenantId } };
}

/**
 * Normalize a user-supplied `filter` config into an array of raw OpenSearch
 * filter clauses. Two shapes are accepted:
 *  - **Array** — passed through verbatim. Use this for `range`, `prefix`,
 *    `exists`, `bool`, etc. that need the full DSL.
 *  - **Object** — each entry becomes a `term` (scalar) or `terms` (array)
 *    clause. Convenient for simple exact-match constraints; mirrors the
 *    existing BM25 / kNN retriever plugins' `filter` shape so all three are
 *    interchangeable from the outside.
 */
function normalizeFilterConfig(raw: unknown): Array<Record<string, unknown>> {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) {
    return raw.filter(
      (c): c is Record<string, unknown> =>
        typeof c === "object" && c !== null && !Array.isArray(c)
    );
  }
  if (typeof raw === "object") {
    const out: Array<Record<string, unknown>> = [];
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out.push(Array.isArray(v) ? { terms: { [k]: v } } : { term: { [k]: v } });
    }
    return out;
  }
  return [];
}

interface RankedDoc {
  id: string;
  score: number;
  source: Record<string, unknown>;
}

/**
 * Fuse two ranked result lists. Pure + exported so the fusion math is unit
 * tested directly.
 *  - `rrf` (default): Reciprocal Rank Fusion, score = Σ 1/(rrfK + rank). Rank
 *    is 1-based and per-arm; robust because it ignores raw score scales.
 *  - `weighted`: min-max normalize each arm to [0,1] then
 *    alpha*vector + (1-alpha)*lexical.
 */
export function fuseHybridResults(
  lexical: RankedDoc[],
  vector: RankedDoc[],
  opts: { mode?: "rrf" | "weighted"; rrfK?: number; alpha?: number; topK: number }
): RankedDoc[] {
  const mode = opts.mode ?? "rrf";
  const byId = new Map<string, { source: Record<string, unknown>; score: number }>();

  if (mode === "weighted") {
    const alpha = Math.min(1, Math.max(0, opts.alpha ?? 0.5));
    const norm = (list: RankedDoc[]): Map<string, number> => {
      const scores = list.map((d) => d.score);
      const min = Math.min(...scores, 0);
      const max = Math.max(...scores, 0);
      const span = max - min;
      const out = new Map<string, number>();
      for (const d of list) {
        out.set(d.id, span === 0 ? (list.length ? 1 : 0) : (d.score - min) / span);
      }
      return out;
    };
    const lexN = norm(lexical);
    const vecN = norm(vector);
    for (const d of [...lexical, ...vector]) {
      const fused = alpha * (vecN.get(d.id) ?? 0) + (1 - alpha) * (lexN.get(d.id) ?? 0);
      const prev = byId.get(d.id);
      byId.set(d.id, { source: { ...(prev?.source ?? {}), ...d.source }, score: fused });
    }
  } else {
    const rrfK = opts.rrfK ?? 60;
    const accumulate = (list: RankedDoc[]) => {
      list.forEach((d, index) => {
        const contribution = 1 / (rrfK + index + 1);
        const prev = byId.get(d.id);
        byId.set(d.id, {
          source: { ...(prev?.source ?? {}), ...d.source },
          score: (prev?.score ?? 0) + contribution
        });
      });
    };
    accumulate(lexical);
    accumulate(vector);
  }

  return [...byId.entries()]
    .map(([id, v]) => ({ id, score: v.score, source: v.source }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, opts.topK));
}

export const openSearchInputPlugin: InProcessPlugin = {
  manifest: {
    id: "opensearch_input",
    name: "OpenSearch Input",
    version: "1.0.0",
    category: "datasource",
    contract: 2,
    description:
      "Reads documents from an OpenSearch index (optionally filtered by a query_string) and emits them for ingestion or context.",
    configSchema: {
      type: "object",
      properties: {
        endpoint: {
          type: "string",
          description: "OpenSearch base URL. Falls back to the opensearch.url config value / OPENSEARCH_URL env."
        },
        index: { type: "string", default: "default", description: "Index to read from." },
        query: {
          type: "string",
          description: "Optional Lucene query_string. When unset, all documents are returned (match_all)."
        },
        size: { type: "integer", default: 100, description: "Maximum number of documents to fetch." },
        textField: {
          type: "string",
          default: "text",
          description: "Source field mapped onto each emitted document's `text`."
        },
        tenantField: {
          type: "string",
          description: "If set, restrict the read to docs where this field equals the execution tenant id."
        }
      },
      additionalProperties: false
    },
    secretsSchema: OPENSEARCH_SECRETS_SCHEMA,
    outputPorts: [
      { name: "documents", description: "Array of { id, text, metadata } documents read from the index." },
      { name: "pageCount", description: "Number of documents in this page." },
      { name: "total", description: "Total hit count reported by OpenSearch." }
    ],
    capabilities: ["ingestion", "query"],
    ui: {
      icon: "database",
      color: "#005EB8",
      formHints: {
        size: { widget: "number", min: 1, step: 10 },
        query: { widget: "textarea", rows: 2 }
      }
    }
  },
  async execute(input) {
    const { config, secrets, context } = input;
    const client = openSearchClientFrom(config, secrets, context.resolvedConfig.values);
    const index = String(pickBackendName(input, "keyword") ?? "default");
    const size = Math.max(1, Number(config.size ?? 100));
    const textField = String(config.textField ?? "text");
    const tenantField = config.tenantField ? String(config.tenantField) : undefined;
    const queryStr = config.query ? String(config.query) : undefined;

    const must: Array<Record<string, unknown>> = [
      queryStr ? { query_string: { query: queryStr } } : { match_all: {} }
    ];
    const filter = tenantField ? [tenantFilterClause(tenantField, context.tenantId)] : [];

    const { hits, total } = await client.search(index, {
      size,
      query: { bool: { must, filter } }
    });
    const documents = hits.map((hit) => {
      const { [textField]: text, ...metadata } = hit.source;
      return { id: hit.id, text: text !== undefined ? String(text) : "", metadata };
    });
    return { outputs: { documents, pageCount: documents.length, total } };
  }
};

export const openSearchOutputPlugin: InProcessPlugin = {
  manifest: {
    id: "opensearch_output",
    name: "OpenSearch Output",
    version: "1.0.0",
    category: "sink",
    contract: 2,
    datasetModalities: ["text"],
    description:
      "Bulk-indexes documents (or embedded chunks) into an OpenSearch index. Tags each doc with the tenant id and can provision a kNN index.",
    configSchema: {
      type: "object",
      properties: {
        endpoint: {
          type: "string",
          description: "OpenSearch base URL. Falls back to the opensearch.url config value / OPENSEARCH_URL env."
        },
        index: { type: "string", default: "default", description: "Target index." },
        idField: {
          type: "string",
          description: "Document field to use as the OpenSearch _id. Auto-generated when unset."
        },
        vectorField: {
          type: "string",
          description: "When set, embedded vectors from `inputs.vectors` are written to this field."
        },
        dimensions: {
          type: "integer",
          description: "Vector dimensionality (used only when provisioning a kNN index)."
        },
        distance: {
          type: "string",
          enum: ["cosine", "dot", "euclidean"],
          default: "cosine",
          description: "kNN space metric used when a kNN index is provisioned."
        },
        createKnnIndex: {
          type: "boolean",
          default: false,
          description: "When true and a vectorField/dimensions are set, create a kNN-enabled index if missing."
        }
      },
      additionalProperties: false
    },
    secretsSchema: OPENSEARCH_SECRETS_SCHEMA,
    inputPorts: [
      { name: "documents", description: "Pre-shaped documents to bulk-index. Takes priority over chunks/vectors." },
      { name: "chunks", description: "Chunks to bulk-index when no documents are supplied." },
      { name: "vectors", description: "Optional embedding vectors written to `vectorField` per row." }
    ],
    outputPorts: [
      { name: "indexed", description: "Number of documents written to the index." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "database",
      color: "#005EB8",
      formHints: {
        distance: { widget: "select" },
        dimensions: { widget: "number", min: 1, step: 1 }
      }
    }
  },
  async execute(input) {
    const { inputs, config, secrets, context } = input;
    const client = openSearchClientFrom(config, secrets, context.resolvedConfig.values);
    const index = String(pickBackendName(input, "keyword") ?? "default");
    const idField = config.idField ? String(config.idField) : undefined;
    const vectorField = config.vectorField ? String(config.vectorField) : undefined;

    const documents = (inputs.documents as Array<Record<string, unknown>> | undefined) ?? undefined;
    const chunks =
      (inputs.chunks as Array<{ text?: string; index?: number } & Record<string, unknown>> | undefined) ?? [];
    const vectors = (inputs.vectors as number[][] | undefined) ?? [];

    const docs: Array<{ id?: string; doc: Record<string, unknown> }> = [];
    if (documents && documents.length > 0) {
      documents.forEach((source, i) => {
        const doc: Record<string, unknown> = { ...source, tenantId: context.tenantId };
        if (vectorField && vectors[i]) doc[vectorField] = vectors[i];
        const id = idField ? source[idField] : source.id;
        docs.push({ id: id !== undefined ? String(id) : undefined, doc });
      });
    } else {
      chunks.forEach((chunk, i) => {
        const { text, index: chunkIndex, ...rest } = chunk;
        const doc: Record<string, unknown> = {
          text: text ?? "",
          chunkIndex: chunkIndex ?? i,
          tenantId: context.tenantId,
          ...rest
        };
        if (vectorField && vectors[i]) doc[vectorField] = vectors[i];
        docs.push({ id: chunk.id !== undefined ? String(chunk.id) : undefined, doc });
      });
    }

    if (docs.length === 0) return { outputs: { indexed: 0 } };

    // ALWAYS ensure the index has a `tenantId: keyword` mapping before
    // writing. If we let OpenSearch's dynamic mapping fire on the first
    // doc, `tenantId` ends up as `text` with a `.keyword` sub-field — and
    // a later retriever's `term: { tenantId: ... }` filter silently
    // 0-matches because `term` doesn't query analysed text fields.
    //
    // When this writer carries vectors AND `createKnnIndex` is set, we
    // also need the vector field mapped as `knn_vector`. The tricky case:
    // a sibling BM25 writer can have ALREADY created the index (without
    // the knn field) by the time we run. In that case `ensureIndex` is a
    // no-op and we have to `putMapping` to graft the kNN field on
    // afterwards — OpenSearch lets you ADD new fields to a live index,
    // just not change an existing field's type. Doing nothing here is
    // what produced "vector: float" auto-mapping (and the resulting kNN
    // 400 at query time) in earlier runs.
    if (config.createKnnIndex === true && vectorField && config.dimensions) {
      const space = { cosine: "cosinesimil", dot: "innerproduct", euclidean: "l2" }[
        String(config.distance ?? "cosine") as DistanceMetric
      ];
      const knnFieldMapping = {
        type: "knn_vector",
        dimension: Number(config.dimensions),
        method: { name: "hnsw", engine: "lucene", space_type: space }
      };
      await client.ensureIndex(index, {
        settings: { index: { knn: true } },
        mappings: {
          properties: {
            [vectorField]: knnFieldMapping,
            tenantId: { type: "keyword" }
          }
        }
      });
      // If the index was already there (sibling writer ran first), our
      // ensureIndex was a no-op and the kNN field is still missing or
      // — worse — auto-mapped as `float`. Try to graft it on.
      const existing = await client.getMappingProperties(index);
      const existingVector = (existing[vectorField] as { type?: string } | undefined)?.type;
      if (existingVector === undefined) {
        await client.putMapping(index, { [vectorField]: knnFieldMapping });
      } else if (existingVector !== "knn_vector") {
        throw new Error(
          `opensearch_output: index "${index}" already has field "${vectorField}" mapped as "${existingVector}" — kNN requires "knn_vector". Drop the index and re-run the vector ingest before any other writer.`
        );
      }
    } else {
      await client.ensureIndex(index, {
        mappings: { properties: { tenantId: { type: "keyword" } } }
      });
    }

    const { indexed } = await client.bulkIndex(index, docs, true);
    return { outputs: { indexed } };
  }
};

export const openSearchBm25RetrieverPlugin: InProcessPlugin = {
  manifest: {
    id: "opensearch_bm25_retriever",
    name: "OpenSearch BM25 Retriever",
    version: "1.0.0",
    category: "retriever",
    contract: 2,
    datasetModalities: ["text"],
    description:
      "Lexical (BM25) retrieval over an OpenSearch index using multi_match, scoped to the execution tenant.",
    configSchema: {
      type: "object",
      properties: {
        endpoint: {
          type: "string",
          description: "OpenSearch base URL. Falls back to the opensearch.url config value / OPENSEARCH_URL env."
        },
        index: { type: "string", default: "default", description: "Index to search." },
        fields: {
          type: "array",
          items: { type: "string" },
          default: ["text"],
          description: "Fields scored by multi_match (best_fields)."
        },
        topK: { type: "integer", default: 5, description: "Number of hits to return." },
        tenantField: {
          type: "string",
          default: "tenantId",
          description: "Tenant keyword field for isolation. Set empty to disable the tenant filter."
        },
        filter: {
          type: "object",
          additionalProperties: true,
          description: "Optional exact-match term/terms filter applied alongside the query."
        }
      },
      additionalProperties: false
    },
    secretsSchema: OPENSEARCH_SECRETS_SCHEMA,
    inputPorts: [
      { name: "question", required: true, description: "Lexical search query." }
    ],
    outputPorts: [
      { name: "documents", description: "Hits with id, score, and source fields." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "search",
      color: "#005EB8",
      formHints: {
        topK: { widget: "number", min: 1, step: 1 },
        fields: { widget: "json" },
        filter: { widget: "json" }
      }
    }
  },
  async execute(input) {
    const { inputs, config, secrets, context } = input;
    const client = openSearchClientFrom(config, secrets, context.resolvedConfig.values);
    const index = String(pickBackendName(input, "keyword") ?? "default");
    const topK = Math.max(1, Number(config.topK ?? 5));
    const fields = Array.isArray(config.fields) ? (config.fields as string[]) : ["text"];
    const tenantField =
      config.tenantField === undefined ? "tenantId" : String(config.tenantField);
    const question = questionFrom(inputs);

    const filter: Array<Record<string, unknown>> = [];
    if (tenantField) filter.push(tenantFilterClause(tenantField, context.tenantId));
    const cfgFilter = config.filter as Record<string, unknown> | undefined;
    if (cfgFilter) {
      for (const [k, v] of Object.entries(cfgFilter)) {
        filter.push(Array.isArray(v) ? { terms: { [k]: v } } : { term: { [k]: v } });
      }
    }

    const { hits } = await client.search(index, {
      size: topK,
      query: {
        bool: {
          must: [{ multi_match: { query: question, fields, type: "best_fields" } }],
          filter
        }
      }
    });
    const documents = hits.map((hit) => ({ id: hit.id, score: hit.score, ...hit.source }));
    return { outputs: { documents } };
  }
};

export const openSearchVectorRetrieverPlugin: InProcessPlugin = {
  manifest: {
    id: "opensearch_vector_retriever",
    name: "OpenSearch Vector Retriever",
    version: "1.0.0",
    category: "retriever",
    datasetModalities: ["vector"],
    contract: 2,
    description:
      "kNN vector retrieval over an OpenSearch knn_vector index. Embeds the question when no queryVector is supplied.",
    configSchema: {
      type: "object",
      properties: {
        endpoint: {
          type: "string",
          description: "OpenSearch base URL. Falls back to the opensearch.url config value / OPENSEARCH_URL env."
        },
        index: { type: "string", default: "default", description: "kNN index to query." },
        topK: { type: "integer", default: 5, description: "Number of nearest documents to return." },
        filter: {
          type: "object",
          additionalProperties: true,
          description: "Optional exact-match term/terms filter applied to the kNN query."
        },
        provider: {
          type: "string",
          enum: ["openai", "anthropic", "ollama"],
          default: "ollama",
          description: "Embedding provider used to embed the query when no queryVector is supplied."
        },
        model: {
          type: "string",
          default: "nomic-embed-text",
          description: "Embedding model used to embed the query."
        },
        baseUrl: {
          type: "string",
          description: "Override the embedding provider base URL (e.g. a remote self-hosted Ollama)."
        }
      },
      additionalProperties: false
    },
    secretsSchema: {
      type: "object",
      properties: {
        ...OPENSEARCH_SECRETS_SCHEMA.properties,
        apiKey: {
          type: "string",
          format: "secret-ref",
          description: "Embedding provider API key secret (used for query embedding)."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "question", description: "Natural-language question. Embedded on the fly when no queryVector is supplied." },
      { name: "queryVector", description: "Pre-computed embedding for the query." }
    ],
    outputPorts: [
      { name: "documents", description: "kNN hits with id, score, and payload fields." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "search",
      color: "#005EB8",
      formHints: {
        provider: { widget: "select" },
        topK: { widget: "number", min: 1, step: 1 },
        filter: { widget: "json" }
      }
    }
  },
  async execute(input) {
    const { inputs, config, secrets, context } = input;
    const client = openSearchClientFrom(config, secrets, context.resolvedConfig.values);
    const store = new OpenSearchVectorStore({ client });
    // OpenSearch's "index" is the same physical store name regardless of
    // whether it's used for vector or keyword reads; the dataset's
    // backendCollections.keyword wins, then vector (when the dataset is
    // vector-only and points at the same OS index), then legacy config.
    const collection = String(
      pickBackendName(input, "keyword") ??
        pickBackendName(input, "vector") ??
        context.resolvedConfig.values["vector.collection"]?.value ??
        "default"
    );
    const topK = Number(config.topK ?? context.resolvedConfig.values["retriever.top_k"]?.value ?? 5);

    let queryVector = inputs.queryVector as number[] | undefined;
    let usage: { provider?: string; model?: string; embeddingTokens?: number } | undefined;
    if (!queryVector || queryVector.length === 0) {
      const embedded = await embedTexts({
        texts: [questionFrom(inputs)],
        config,
        secrets,
        tenantId: context.tenantId,
        resolvedValues: context.resolvedConfig.values
      });
      queryVector = embedded.vectors[0] ?? [];
      usage = { provider: embedded.provider, model: embedded.model, embeddingTokens: embedded.embeddingTokens };
    }

    const results = await store.query(collection, {
      vector: queryVector,
      topK,
      filter: (config.filter as Record<string, unknown> | undefined) ?? undefined,
      tenantId: context.tenantId
    });
    const documents = results.map((result) => ({
      id: result.id,
      score: result.score,
      ...(result.payload ?? {})
    }));
    return { outputs: { documents }, ...(usage ? { usage } : {}) };
  }
};

export const openSearchHybridRetrieverPlugin: InProcessPlugin = {
  manifest: {
    id: "opensearch_hybrid_retriever",
    name: "OpenSearch Hybrid Retriever",
    version: "1.0.0",
    category: "retriever",
    contract: 2,
    datasetModalities: ["vector", "text"],
    description:
      "Hybrid retrieval: runs BM25 lexical and kNN vector search over one OpenSearch index and fuses them (RRF or weighted).",
    configSchema: {
      type: "object",
      properties: {
        endpoint: {
          type: "string",
          description: "OpenSearch base URL. Falls back to the opensearch.url config value / OPENSEARCH_URL env."
        },
        index: {
          type: "string",
          default: "default",
          description: "Index holding both the text fields and a `vector` knn_vector field."
        },
        fields: {
          type: "array",
          items: { type: "string" },
          default: ["text"],
          description: "Fields scored by the BM25 (lexical) arm."
        },
        topK: { type: "integer", default: 5, description: "Final number of fused results to return." },
        candidateK: {
          type: "integer",
          description: "Candidates pulled from each arm before fusion. Defaults to max(topK*4, 20)."
        },
        mode: {
          type: "string",
          enum: ["rrf", "weighted"],
          default: "rrf",
          description: "Fusion strategy: Reciprocal Rank Fusion or min-max weighted blend."
        },
        alpha: {
          type: "number",
          default: 0.5,
          description: "weighted mode only: weight on the vector arm (0..1); lexical gets 1-alpha."
        },
        rrfK: {
          type: "integer",
          default: 60,
          description: "rrf mode only: rank constant in 1/(rrfK+rank)."
        },
        tenantField: {
          type: "string",
          default: "tenantId",
          description: "Tenant keyword field for isolation on both arms. Set empty to disable."
        },
        provider: {
          type: "string",
          enum: ["openai", "anthropic", "ollama"],
          default: "ollama",
          description: "Embedding provider for the vector arm when no queryVector is supplied."
        },
        model: {
          type: "string",
          default: "nomic-embed-text",
          description: "Embedding model for the vector arm."
        },
        baseUrl: {
          type: "string",
          description: "Override the embedding provider base URL (e.g. a remote self-hosted Ollama)."
        },
        filter: {
          description:
            "Optional OpenSearch filter clauses applied to both arms (lexical and kNN). Accepts either an array of raw clauses (e.g. [{range: {date_received: {gte: 'now-14d/d'}}}, {prefix: {'folder_path.keyword': 'Inbox'}}]) or an object whose entries become term/terms clauses (legacy shape)."
        }
      },
      additionalProperties: false
    },
    secretsSchema: {
      type: "object",
      properties: {
        ...OPENSEARCH_SECRETS_SCHEMA.properties,
        apiKey: {
          type: "string",
          format: "secret-ref",
          description: "Embedding provider API key secret (used for query embedding)."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "question", description: "Lexical + embedding query text." },
      { name: "queryVector", description: "Pre-computed embedding for the kNN arm." }
    ],
    outputPorts: [
      { name: "documents", description: "Fused, ranked documents." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "search",
      color: "#005EB8",
      formHints: {
        mode: { widget: "select" },
        provider: { widget: "select" },
        topK: { widget: "number", min: 1, step: 1 },
        alpha: { widget: "range", min: 0, max: 1, step: 0.05 },
        fields: { widget: "json" },
        filter: { widget: "json" }
      }
    }
  },
  async execute(input) {
    const { inputs, config, secrets, context } = input;
    const client = openSearchClientFrom(config, secrets, context.resolvedConfig.values);
    const index = String(
      pickBackendName(input, "keyword") ??
        pickBackendName(input, "vector") ??
        "default"
    );
    const topK = Math.max(1, Number(config.topK ?? 5));
    const candidateK = Math.max(topK, Number(config.candidateK ?? Math.max(topK * 4, 20)));
    const fields = Array.isArray(config.fields) ? (config.fields as string[]) : ["text"];
    const tenantField =
      config.tenantField === undefined ? "tenantId" : String(config.tenantField);
    const question = questionFrom(inputs);
    // Two different filter shapes: BM25 uses the mapping-tolerant
    // bool.should clause; kNN can't (Lucene engine rejects nested bool with
    // "Rewrite first") and needs a leaf `term`. Both target the same field.
    const tenantFilter = tenantField ? [tenantFilterClause(tenantField, context.tenantId)] : [];
    const tenantFilterKnn = tenantField ? [tenantFilterClauseForKnn(tenantField, context.tenantId)] : [];
    const userFilter = normalizeFilterConfig(config.filter);
    const bm25Filter = [...tenantFilter, ...userFilter];
    const knnFilterClauses = [...tenantFilterKnn, ...userFilter];

    let queryVector = inputs.queryVector as number[] | undefined;
    let usage: { provider?: string; model?: string; embeddingTokens?: number } | undefined;
    if (!queryVector || queryVector.length === 0) {
      const embedded = await embedTexts({
        texts: [question],
        config,
        secrets,
        tenantId: context.tenantId,
        resolvedValues: context.resolvedConfig.values
      });
      queryVector = embedded.vectors[0] ?? [];
      usage = { provider: embedded.provider, model: embedded.model, embeddingTokens: embedded.embeddingTokens };
    }

    const [lexical, vector] = await Promise.all([
      client.search(index, {
        size: candidateK,
        query: {
          bool: {
            must: [{ multi_match: { query: question, fields, type: "best_fields" } }],
            filter: bm25Filter
          }
        }
      }),
      client.search(index, {
        size: candidateK,
        query: {
          knn: {
            vector: {
              vector: queryVector,
              k: candidateK,
              filter:
                knnFilterClauses.length === 1
                  ? knnFilterClauses[0]
                  : { bool: { must: knnFilterClauses } }
            }
          }
        }
      })
    ]);

    const fused = fuseHybridResults(
      lexical.hits.map((h) => ({ id: h.id, score: h.score, source: h.source })),
      vector.hits.map((h) => ({ id: h.id, score: h.score, source: h.source })),
      {
        mode: (config.mode as "rrf" | "weighted" | undefined) ?? "rrf",
        rrfK: Number(config.rrfK ?? 60),
        alpha: Number(config.alpha ?? 0.5),
        topK
      }
    );
    const documents = fused.map((d) => {
      const { vector: _v, ...rest } = d.source;
      return { id: d.id, score: d.score, ...rest };
    });
    return { outputs: { documents }, ...(usage ? { usage } : {}) };
  }
};

