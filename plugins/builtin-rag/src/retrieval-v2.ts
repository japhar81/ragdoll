/**
 * Phase 9 of dataset/RBAC/retrieval refactor: the new retrieval plugin
 * set that makes synchronous (chat-style) RAG pipelines worth
 * assembling.
 *
 * Plugins here all declare `contract: 2` and lean on Phase 4's Dataset
 * abstraction + Phase 5's runtime resolver. They are intentionally
 * dependency-light: every LLM call goes through @ragdoll/providers, no
 * extra HTTP/embeddings package. That keeps the install-free test
 * surface intact and matches every other built-in plugin in this
 * package.
 *
 * Categories used:
 *  - `retriever`  for dataset_search / merge_rrf
 *  - `sink`       for dataset_upsert
 *  - `transformer` for query_hyde / query_fanout / rerank_llm /
 *                  conversation_rewrite / topic_shift_detect
 *
 * Things explicitly NOT in this file (parked for a follow-up):
 *  - `rerank_bge` — needs a cross-encoder model. We don't ship a runtime
 *    that loads HF weights yet; would land alongside a tiny model-loader
 *    seam.
 *  - `pipeline_call` — needs a slug→spec lookup the runtime doesn't
 *    expose to plugins today; structurally bigger than the rest.
 */
import type { InProcessPlugin, PluginExecutionInput } from "../../../packages/plugin-sdk/src/index.ts";
import { executeRegisteredPlugin } from "../../../packages/plugin-sdk/src/transport.ts";
import {
  OpenAIProvider,
  AnthropicProvider,
  OllamaCompatibleProvider,
  ProviderRegistry,
  type ChatMessage
} from "../../../packages/providers/src/index.ts";
import { createVectorStore, type VectorPoint } from "../../../packages/vector/src/index.ts";
import { createOpenSearchClient } from "../../../packages/opensearch/src/index.ts";
import { pickBackendName } from "./dataset-binding.ts";
import { validateAgainstSchema } from "./schema-validate.ts";

function buildProviderRegistry(): ProviderRegistry {
  const providers = new ProviderRegistry();
  providers.register(new OpenAIProvider());
  providers.register(new AnthropicProvider());
  providers.register(new OllamaCompatibleProvider());
  return providers;
}

/** Tiny chat call helper shared by every LLM-driven plugin below.
 *  Honors `provider` / `model` / `temperature` from config with a sane
 *  default chain that ends at local Ollama. */
async function chat(input: PluginExecutionInput, messages: ChatMessage[]): Promise<{ text: string; provider: string; model: string; usage?: Record<string, unknown> }> {
  const { config, secrets, context } = input;
  const providers = buildProviderRegistry();
  const providerId = String(
    config.provider ?? context.resolvedConfig.values["llm.provider"]?.value ?? "ollama"
  );
  const provider = providers.require(providerId);
  const response = await provider.chat({
    tenantId: context.tenantId,
    model: String(
      config.model ?? context.resolvedConfig.values["llm.model"]?.value ?? "llama3.1"
    ),
    messages,
    temperature: Number(config.temperature ?? 0.2),
    maxTokens: Number(config.maxTokens ?? 1024),
    apiKey: secrets.apiKey,
    baseUrl: config.baseUrl ? String(config.baseUrl) : undefined
  });
  return {
    text: response.text,
    provider: response.provider,
    model: response.model,
    usage: response.usage as Record<string, unknown> | undefined
  };
}

const LLM_CONFIG_SCHEMA = {
  type: "object" as const,
  properties: {
    provider: {
      type: "string",
      enum: ["openai", "anthropic", "ollama"],
      default: "ollama",
      description: "Chat provider adapter."
    },
    model: { type: "string", default: "llama3.1" },
    temperature: { type: "number", default: 0.2 },
    maxTokens: { type: "integer", default: 1024 }
  },
  additionalProperties: false
};

const LLM_SECRETS_SCHEMA = {
  type: "object" as const,
  properties: {
    apiKey: {
      type: "string",
      format: "secret-ref",
      description: "Provider API key (OpenAI/Anthropic). Unused for local Ollama."
    }
  },
  additionalProperties: false
};

function questionFrom(inputs: Record<string, unknown>): string {
  if (typeof inputs.question === "string") return inputs.question;
  if (typeof inputs.text === "string") return inputs.text;
  if (typeof inputs.query === "string") return inputs.query;
  return "";
}

// ===========================================================================
// dataset_search — v2-native retrieval primitive
// ===========================================================================

/**
 * Replaces qdrant_retriever / opensearch_*_retriever for v2 pipelines.
 * Dispatches to the right backend based on the resolved dataset:
 * vector → createVectorStore (Qdrant or pgvector per env);
 * keyword → OpenSearchClient. The plugin asks the dataset which
 * modality to use via `config.modality`; defaults to `vector` when the
 * dataset only carries one.
 *
 * Inputs: `question` (text) or `queryVector` (pre-embedded).
 * Outputs: `documents` (ranked array with id/score/payload).
 */
export const datasetSearchPlugin: InProcessPlugin = {
  manifest: {
    id: "dataset_search",
    name: "Dataset Search",
    version: "1.0.0",
    category: "retriever",
    contract: 2,
    description:
      "Dataset-aware retrieval. Picks the right backend (Qdrant / pgvector / OpenSearch) based on the resolved Dataset's declared modalities.",
    configSchema: {
      type: "object",
      properties: {
        modality: {
          type: "string",
          enum: ["vector", "keyword"],
          default: "vector",
          description: "Which side of the dataset to query."
        },
        topK: { type: "integer", default: 5 },
        filter: {
          type: "object",
          additionalProperties: true,
          description: "Optional flat key/value payload filter."
        },
        // Embedding fallback for vector mode when no queryVector is supplied.
        provider: { type: "string", enum: ["openai", "anthropic", "ollama"], default: "ollama" },
        model: { type: "string", default: "nomic-embed-text" }
      },
      additionalProperties: false
    },
    secretsSchema: LLM_SECRETS_SCHEMA,
    inputPorts: [
      { name: "question", description: "Natural-language query. Embedded on the fly for vector mode." },
      { name: "queryVector", description: "Pre-computed embedding for vector mode." }
    ],
    outputPorts: [
      { name: "documents", description: "Ranked array of { id, score, ...payload }." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "search",
      color: "#16a34a",
      paletteGroup: "Retrieval",
      formHints: {
        modality: { widget: "select" },
        topK: { widget: "number", min: 1, step: 1 },
        filter: { widget: "json" },
        provider: { widget: "select" },
        apiKey: { widget: "secret" }
      }
    }
  },
  async execute(input) {
    const { inputs, config, secrets, context, dataset } = input;
    if (!dataset) {
      throw new Error("dataset_search requires node.dataset to be wired");
    }
    const modality = String(config.modality ?? "vector") as "vector" | "keyword";
    const topK = Math.max(1, Number(config.topK ?? 5));
    const filter = (config.filter as Record<string, unknown> | undefined) ?? undefined;

    if (modality === "vector") {
      // Decide backend by what's declared on the dataset; createVectorStore
      // honors RAGDOLL_VECTOR_BACKEND but the dataset wins.
      const vectorBackend = (
        (dataset as unknown as { backends?: { vector?: { provider?: string } } })
          .backends?.vector?.provider
      ) as "qdrant" | "pgvector" | undefined;
      const collection = pickBackendName(input, "vector");
      if (!collection) {
        throw new Error("dataset_search: dataset has no vector backend collection");
      }
      const store = createVectorStore({
        ...(vectorBackend ? { provider: vectorBackend } : {})
      });
      // Embed the question on the fly when no pre-computed vector is given.
      let queryVector: number[] = (inputs.queryVector as number[] | undefined) ?? [];
      let usage: Record<string, unknown> | undefined;
      if (queryVector.length === 0) {
        const providers = buildProviderRegistry();
        const provider = providers.require(String(config.provider ?? "ollama"));
        if (!provider.embeddings) {
          throw new Error(
            `dataset_search: provider ${provider.id} does not support embeddings`
          );
        }
        const embedded = await provider.embeddings({
          tenantId: context.tenantId,
          model: String(config.model ?? "nomic-embed-text"),
          input: [questionFrom(inputs)],
          apiKey: secrets.apiKey
        });
        queryVector = embedded.vectors[0] ?? [];
        usage = {
          provider: embedded.provider,
          model: embedded.model,
          embeddingTokens: embedded.usage?.embeddingTokens ?? 0
        };
      }
      const results = await store.query(collection, {
        vector: queryVector,
        topK,
        filter,
        tenantId: context.tenantId
      });
      return {
        outputs: {
          documents: results.map((r) => ({
            id: r.id,
            score: r.score,
            ...(r.payload ?? {})
          }))
        },
        ...(usage ? { usage } : {})
      };
    }

    // keyword modality → OpenSearch.
    const index = pickBackendName(input, "keyword");
    if (!index) {
      throw new Error("dataset_search: dataset has no keyword backend index");
    }
    const client = createOpenSearchClient({
      endpoint:
        (config.endpoint ? String(config.endpoint) : undefined) ??
        (context.resolvedConfig.values["opensearch.url"]?.value as string | undefined),
      username: secrets.username,
      password: secrets.password,
      authorization: secrets.authorization
    });
    if (!client) {
      throw new Error("dataset_search: OpenSearch endpoint not configured");
    }
    const must: Array<Record<string, unknown>> = [
      { multi_match: { query: questionFrom(inputs), fields: ["text"], type: "best_fields" } }
    ];
    const filterClauses: Array<Record<string, unknown>> = [
      { term: { tenantId: context.tenantId } }
    ];
    if (filter) {
      for (const [k, v] of Object.entries(filter)) {
        filterClauses.push(Array.isArray(v) ? { terms: { [k]: v } } : { term: { [k]: v } });
      }
    }
    const { hits } = await client.search(index, {
      size: topK,
      query: { bool: { must, filter: filterClauses } }
    });
    return {
      outputs: {
        documents: hits.map((hit) => ({ id: hit.id, score: hit.score, ...hit.source }))
      }
    };
  }
};

// ===========================================================================
// dataset_upsert — v2-native write primitive
// ===========================================================================

/**
 * Replaces vector_upsert for v2 pipelines. Dispatches to the right
 * vector backend declared on the resolved dataset.
 */
export const datasetUpsertPlugin: InProcessPlugin = {
  manifest: {
    id: "dataset_upsert",
    name: "Dataset Upsert",
    version: "1.0.0",
    category: "sink",
    contract: 2,
    description: "Upsert chunks + embeddings into a Dataset's vector backend.",
    configSchema: {
      type: "object",
      properties: {
        distance: { type: "string", enum: ["cosine", "dot", "euclidean"], default: "cosine" },
        dimensions: { type: "integer", description: "Inferred from first vector when unset." },
        idPrefix: { type: "string", description: "Prefix combined with chunk id." }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "chunks", required: true, description: "Chunks with text + metadata." },
      { name: "vectors", required: true, description: "Embedding vectors aligned with chunks." }
    ],
    outputPorts: [
      { name: "upserted", description: "Number of points written." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "database",
      color: "#16a34a",
      paletteGroup: "Ingestion",
      formHints: {
        distance: { widget: "select" },
        dimensions: { widget: "number", min: 1, step: 1 }
      }
    }
  },
  async execute(input) {
    const { inputs, config, context, dataset } = input;
    if (!dataset) {
      throw new Error("dataset_upsert requires node.dataset to be wired");
    }
    const collection = pickBackendName(input, "vector");
    if (!collection) {
      throw new Error("dataset_upsert: dataset has no vector backend collection");
    }
    const vectorBackend = (
      (dataset as unknown as { backends?: { vector?: { provider?: string } } })
        .backends?.vector?.provider
    ) as "qdrant" | "pgvector" | undefined;
    const store = createVectorStore({
      ...(vectorBackend ? { provider: vectorBackend } : {})
    });

    const chunks =
      (inputs.chunks as Array<{ text?: string; index?: number } & Record<string, unknown>> | undefined) ?? [];
    const vectors = (inputs.vectors as number[][] | undefined) ?? [];
    if (vectors.length === 0) return { outputs: { upserted: 0 } };
    const dimensions = Number(config.dimensions ?? vectors[0]?.length ?? 0);
    const distance = String(config.distance ?? "cosine") as "cosine" | "dot" | "euclidean";
    await store.ensureCollection(collection, { dimensions, distance });
    const idPrefix = config.idPrefix
      ? String(config.idPrefix)
      : `${context.executionId}:`;
    // Phase 13 follow-up: strict schema validation on writes when the
    // Dataset declares a chunk_schema. Empty / no-schema datasets pass
    // every record (back-compat with everything minted before this
    // existed). Errors are aggregated across the whole batch so the
    // caller sees every offending record at once, not just the first.
    const chunkSchema = dataset.chunkSchema as unknown;
    const schemaErrors: string[] = [];
    const points: VectorPoint[] = vectors.map((vector, i) => {
      const chunk = chunks[i] ?? {};
      const { text, index: _idx, ...rest } = chunk;
      const payload = { text: text ?? "", chunkIndex: i, ...rest };
      if (chunkSchema) {
        const errs = validateAgainstSchema(payload, chunkSchema);
        for (const e of errs) {
          schemaErrors.push(`chunks[${i}]${e.path}: ${e.message}`);
        }
      }
      return {
        id: `${idPrefix}${i}`,
        vector,
        tenantId: context.tenantId,
        payload
      };
    });
    if (schemaErrors.length > 0) {
      throw new Error(
        `dataset_upsert: chunk_schema validation failed for ${schemaErrors.length} field(s):\n` +
          schemaErrors.slice(0, 20).join("\n") +
          (schemaErrors.length > 20 ? `\n…and ${schemaErrors.length - 20} more` : "")
      );
    }
    await store.upsert(collection, points);
    return { outputs: { upserted: points.length } };
  }
};

// ===========================================================================
// query_hyde — Hypothetical Document Embeddings
// ===========================================================================

export const queryHydePlugin: InProcessPlugin = {
  manifest: {
    id: "query_hyde",
    name: "HyDE Query Expansion",
    version: "1.0.0",
    category: "transformer",
    contract: 2,
    description:
      "Generates a hypothetical answer to the user's question via LLM; downstream retrievers embed the hypothetical text instead of the bare query to surface semantically closer chunks.",
    configSchema: {
      ...LLM_CONFIG_SCHEMA,
      properties: {
        ...LLM_CONFIG_SCHEMA.properties,
        promptTemplate: {
          type: "string",
          description: "Override the HyDE prompt; `{{question}}` is interpolated.",
          default:
            "Write a short, factual paragraph that would answer the following question. Do not include citations or hedging.\n\nQuestion: {{question}}\n\nAnswer:"
        }
      }
    },
    secretsSchema: LLM_SECRETS_SCHEMA,
    inputPorts: [{ name: "question", required: true, description: "User question." }],
    outputPorts: [
      { name: "hypothetical", description: "Hypothetical answer text." },
      { name: "question", description: "Original question, passed through." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "sparkles",
      color: "#7c3aed",
      paletteGroup: "Retrieval",
      formHints: {
        provider: { widget: "select" },
        temperature: { widget: "range", min: 0, max: 2, step: 0.1 },
        promptTemplate: { widget: "textarea", rows: 4 },
        apiKey: { widget: "secret" }
      }
    }
  },
  async execute(input) {
    const { inputs, config } = input;
    const question = questionFrom(inputs);
    if (!question) {
      throw new Error("query_hyde: question input is required");
    }
    const template = String(
      config.promptTemplate ??
        "Write a short, factual paragraph that would answer the following question. Do not include citations or hedging.\n\nQuestion: {{question}}\n\nAnswer:"
    );
    const prompt = template.replace(/\{\{question\}\}/g, question);
    const result = await chat(input, [{ role: "user", content: prompt }]);
    return {
      outputs: { hypothetical: result.text.trim(), question },
      usage: { provider: result.provider, model: result.model, ...result.usage }
    };
  }
};

// ===========================================================================
// query_fanout — N query variants
// ===========================================================================

export const queryFanoutPlugin: InProcessPlugin = {
  manifest: {
    id: "query_fanout",
    name: "Query Fan-out",
    version: "1.0.0",
    category: "transformer",
    contract: 2,
    description:
      "Generates N alternative phrasings of the user's question. Pairs with merge_rrf to combine retrieval results across variants.",
    configSchema: {
      ...LLM_CONFIG_SCHEMA,
      properties: {
        ...LLM_CONFIG_SCHEMA.properties,
        numVariants: { type: "integer", default: 3, description: "How many variants to generate." }
      }
    },
    secretsSchema: LLM_SECRETS_SCHEMA,
    inputPorts: [{ name: "question", required: true, description: "User question." }],
    outputPorts: [
      { name: "queries", description: "Array of N reworded questions (original first)." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "shuffle",
      color: "#7c3aed",
      paletteGroup: "Retrieval",
      formHints: {
        provider: { widget: "select" },
        temperature: { widget: "range", min: 0, max: 2, step: 0.1 },
        numVariants: { widget: "number", min: 1, step: 1 },
        apiKey: { widget: "secret" }
      }
    }
  },
  async execute(input) {
    const { inputs, config } = input;
    const question = questionFrom(inputs);
    if (!question) throw new Error("query_fanout: question input is required");
    const n = Math.max(1, Number(config.numVariants ?? 3));
    const prompt = `Rewrite the following question in ${n} different ways. Each variant should explore a different angle of the same intent. Respond as a JSON array of strings — only the JSON, no preamble.\n\nQuestion: ${question}`;
    const result = await chat(input, [{ role: "user", content: prompt }]);
    let variants: string[] = [];
    try {
      const parsed = JSON.parse(result.text.trim());
      if (Array.isArray(parsed)) {
        variants = parsed.filter((v) => typeof v === "string").slice(0, n);
      }
    } catch {
      // Model returned prose; fall back to one-per-line splitting.
      variants = result.text
        .split(/\n+/)
        .map((line) => line.replace(/^\s*[-\d.]+\s*/, "").trim())
        .filter(Boolean)
        .slice(0, n);
    }
    // Always include the original question first; some retrievers benefit
    // from the verbatim phrasing.
    const queries = [question, ...variants].slice(0, n + 1);
    return {
      outputs: { queries },
      usage: { provider: result.provider, model: result.model, ...result.usage }
    };
  }
};

// ===========================================================================
// merge_rrf — Reciprocal Rank Fusion of multiple ranked lists
// ===========================================================================

interface RankedDoc {
  id: string;
  score?: number;
  [k: string]: unknown;
}

export const mergeRrfPlugin: InProcessPlugin = {
  manifest: {
    id: "merge_rrf",
    name: "Merge (RRF)",
    version: "1.0.0",
    category: "transformer",
    contract: 2,
    description:
      "Reciprocal Rank Fusion: combine N ranked lists (one per query variant or arm) into a single ranking. Score for a doc at rank r is 1/(k+r); summed across lists.",
    configSchema: {
      type: "object",
      properties: {
        k: { type: "integer", default: 60, description: "Rank constant in 1/(k+r)." },
        topK: { type: "integer", default: 10, description: "Final number of fused results." }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "lists", required: true, description: "Array of ranked-doc arrays to fuse." }
    ],
    outputPorts: [
      { name: "documents", description: "Fused, top-K ranked documents." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "git-merge",
      color: "#7c3aed",
      paletteGroup: "Retrieval",
      formHints: {
        k: { widget: "number", min: 1, step: 1 },
        topK: { widget: "number", min: 1, step: 1 }
      }
    }
  },
  async execute(input) {
    const { inputs, config } = input;
    const k = Math.max(1, Number(config.k ?? 60));
    const topK = Math.max(1, Number(config.topK ?? 10));
    const lists = (inputs.lists as RankedDoc[][] | undefined) ?? [];
    const aggregated = new Map<string, { doc: RankedDoc; score: number }>();
    for (const list of lists) {
      list.forEach((doc, rank) => {
        const contribution = 1 / (k + rank);
        const existing = aggregated.get(doc.id);
        if (existing) {
          existing.score += contribution;
        } else {
          aggregated.set(doc.id, { doc, score: contribution });
        }
      });
    }
    const fused = [...aggregated.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((entry) => ({ ...entry.doc, score: entry.score }));
    return { outputs: { documents: fused } };
  }
};

// ===========================================================================
// rerank_llm — LLM-driven reranking
// ===========================================================================

export const rerankLlmPlugin: InProcessPlugin = {
  manifest: {
    id: "rerank_llm",
    name: "LLM Reranker",
    version: "1.0.0",
    category: "reranker",
    contract: 2,
    description:
      "Ask an LLM to score each candidate's relevance to the query, then return the top-K by score. Slower than cross-encoder rerankers but lets you tune via prompt.",
    configSchema: {
      ...LLM_CONFIG_SCHEMA,
      properties: {
        ...LLM_CONFIG_SCHEMA.properties,
        topK: { type: "integer", default: 5, description: "How many to return after reranking." },
        textField: {
          type: "string",
          default: "text",
          description: "Document field the LLM should read."
        }
      }
    },
    secretsSchema: LLM_SECRETS_SCHEMA,
    inputPorts: [
      { name: "question", required: true, description: "User question." },
      { name: "documents", required: true, description: "Candidate documents." }
    ],
    outputPorts: [
      { name: "documents", description: "Top-K documents, reordered with `rerankScore`." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "list-ordered",
      color: "#7c3aed",
      paletteGroup: "Retrieval",
      formHints: {
        provider: { widget: "select" },
        temperature: { widget: "range", min: 0, max: 2, step: 0.1 },
        topK: { widget: "number", min: 1, step: 1 },
        apiKey: { widget: "secret" }
      }
    }
  },
  async execute(input) {
    const { inputs, config } = input;
    const question = questionFrom(inputs);
    const documents = (inputs.documents as RankedDoc[] | undefined) ?? [];
    const topK = Math.max(1, Number(config.topK ?? 5));
    const textField = String(config.textField ?? "text");
    if (documents.length === 0) return { outputs: { documents: [] } };
    // One prompt, batched scoring — far cheaper than one call per doc.
    const numbered = documents
      .map(
        (doc, i) =>
          `[${i}] ${String((doc as Record<string, unknown>)[textField] ?? "").slice(0, 800)}`
      )
      .join("\n\n");
    const prompt = `You are a relevance grader. Score each document's relevance to the question on a 0-10 scale. Respond as a JSON array of integers in the SAME order as the input documents — only the JSON, no preamble.\n\nQuestion: ${question}\n\nDocuments:\n${numbered}`;
    const result = await chat(input, [{ role: "user", content: prompt }]);
    let scores: number[] = [];
    try {
      const parsed = JSON.parse(result.text.trim());
      if (Array.isArray(parsed)) {
        scores = parsed.map((s) => Number(s)).filter((s) => Number.isFinite(s));
      }
    } catch {
      // Model returned prose; fall back to original order with neutral score.
      scores = documents.map(() => 5);
    }
    while (scores.length < documents.length) scores.push(0);
    const reranked = documents
      .map((doc, i) => ({ ...doc, rerankScore: scores[i] ?? 0 }))
      .sort((a, b) => (b.rerankScore as number) - (a.rerankScore as number))
      .slice(0, topK);
    return {
      outputs: { documents: reranked },
      usage: { provider: result.provider, model: result.model, ...result.usage }
    };
  }
};

// ===========================================================================
// conversation_rewrite — turn a follow-up into a standalone question
// ===========================================================================

export const conversationRewritePlugin: InProcessPlugin = {
  manifest: {
    id: "conversation_rewrite",
    name: "Conversation Rewrite",
    version: "1.0.0",
    category: "transformer",
    contract: 2,
    description:
      "Resolves anaphora and implicit references in a follow-up turn against the conversation history, producing a standalone question that retrieval pipelines can act on without context.",
    configSchema: {
      ...LLM_CONFIG_SCHEMA,
      properties: {
        ...LLM_CONFIG_SCHEMA.properties,
        historyWindow: {
          type: "integer",
          default: 6,
          description: "How many prior turns to include in the rewrite prompt."
        }
      }
    },
    secretsSchema: LLM_SECRETS_SCHEMA,
    inputPorts: [
      { name: "question", required: true, description: "Latest user turn." },
      { name: "history", description: "Array of {role, content} messages." }
    ],
    outputPorts: [
      { name: "question", description: "Standalone question; passes through if no rewrite needed." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "messages-square",
      color: "#7c3aed",
      paletteGroup: "Retrieval",
      formHints: {
        provider: { widget: "select" },
        temperature: { widget: "range", min: 0, max: 2, step: 0.1 },
        historyWindow: { widget: "number", min: 0, step: 1 },
        apiKey: { widget: "secret" }
      }
    }
  },
  async execute(input) {
    const { inputs, config } = input;
    const question = questionFrom(inputs);
    if (!question) throw new Error("conversation_rewrite: question is required");
    const history =
      (inputs.history as Array<{ role: string; content: string }> | undefined) ?? [];
    if (history.length === 0) {
      // No prior turns; nothing to rewrite. Pass through unchanged.
      return { outputs: { question } };
    }
    const window = Math.max(0, Number(config.historyWindow ?? 6));
    const recent = history.slice(-window);
    const transcript = recent.map((m) => `${m.role}: ${m.content}`).join("\n");
    const prompt = `Given the conversation history below, rewrite the user's follow-up into a single self-contained question. If the follow-up already stands on its own, return it unchanged. Respond with only the rewritten question — no preamble.\n\nHistory:\n${transcript}\n\nFollow-up: ${question}\n\nStandalone question:`;
    const result = await chat(input, [{ role: "user", content: prompt }]);
    return {
      outputs: { question: result.text.trim() || question },
      usage: { provider: result.provider, model: result.model, ...result.usage }
    };
  }
};

// ===========================================================================
// rerank_bge — cross-encoder reranking via HuggingFace Inference API
// ===========================================================================

/**
 * Calls a cross-encoder model on HuggingFace's Inference API to score
 * each (question, document) pair. The HF endpoint accepts a sentence-
 * pair classification request and returns a per-pair score; we batch
 * the candidates into one request to keep latency reasonable.
 *
 * No local model loading: that needs a Python sidecar + GPU/CPU model
 * weights, which is a separate ops decision. The HF Inference API is
 * the lowest-friction path that gives you a real cross-encoder
 * reranker today; later we can add a `provider: "local"` branch
 * pointing at a model-loader seam.
 */
export const rerankBgePlugin: InProcessPlugin = {
  manifest: {
    id: "rerank_bge",
    name: "BGE Cross-Encoder Reranker",
    version: "1.0.0",
    category: "reranker",
    contract: 2,
    description:
      "Rerank candidate documents against the question using a HuggingFace cross-encoder (BGE-Reranker by default). Two backends: `hf-api` (default, calls the HuggingFace Inference API; needs an hfApiKey secret) and `local` (calls the Python sidecar at PYTHON_PLUGIN_URL; loads the model in-process there).",
    configSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["hf-api", "local"],
          default: "hf-api",
          description:
            "Where to run the cross-encoder. `hf-api` hits HuggingFace Inference; `local` calls the Python sidecar (no API token, loads model in-process)."
        },
        model: {
          type: "string",
          default: "BAAI/bge-reranker-v2-m3",
          description: "HuggingFace model id of a cross-encoder."
        },
        endpoint: {
          type: "string",
          default: "https://api-inference.huggingface.co",
          description: "HF Inference API base URL (override for private endpoints)."
        },
        sidecarUrl: {
          type: "string",
          description: "Python sidecar base URL (defaults to PYTHON_PLUGIN_URL env). Used when provider=local."
        },
        topK: { type: "integer", default: 5 },
        textField: { type: "string", default: "text" },
        timeoutMs: { type: "integer", default: 30000 }
      },
      additionalProperties: false
    },
    secretsSchema: {
      type: "object",
      properties: {
        hfApiKey: {
          type: "string",
          format: "secret-ref",
          description: "HuggingFace API token (read scope is enough)."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "question", required: true },
      { name: "documents", required: true }
    ],
    outputPorts: [
      { name: "documents", description: "Top-K reranked documents with `rerankScore`." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "list-ordered",
      color: "#7c3aed",
      paletteGroup: "Retrieval",
      formHints: {
        model: { widget: "text" },
        topK: { widget: "number", min: 1, step: 1 },
        timeoutMs: { widget: "number", min: 1000, step: 1000 },
        hfApiKey: { widget: "secret" }
      }
    }
  },
  async execute(input) {
    const { inputs, config, secrets } = input;
    const question = questionFrom(inputs);
    const documents = (inputs.documents as RankedDoc[] | undefined) ?? [];
    if (documents.length === 0) return { outputs: { documents: [] } };
    const topK = Math.max(1, Number(config.topK ?? 5));
    const textField = String(config.textField ?? "text");
    const model = String(config.model ?? "BAAI/bge-reranker-v2-m3");
    const timeoutMs = Math.max(1000, Number(config.timeoutMs ?? 30000));
    const provider = String(config.provider ?? "hf-api");

    // Local cross-encoder via the Python sidecar. The sidecar loads the model
    // once and serves the rerank_bge_local plugin via the standard
    // PluginRuntime contract (ADR 0022). We dispatch through the SDK's
    // Connect transport rather than hand-rolling the wire so we get the
    // retry/timeout/cancellation policy + the contract-evolution coverage
    // for free; when the legacy /execute path is removed this still works
    // without changes.
    if (provider === "local") {
      const sidecar = String(
        config.sidecarUrl ??
          process.env.PYTHON_PLUGIN_URL ??
          "http://python-plugins:8000"
      );
      const result = await executeRegisteredPlugin(
        {
          mode: "external",
          manifest: {
            id: "rerank_bge_local",
            name: "rerank_bge_local",
            version: "1.0.0",
            category: "reranker",
            description: "local cross-encoder reranker"
          },
          external: { baseUrl: sidecar, timeoutMs }
        },
        {
          ...input,
          inputs: { question, documents },
          config: { model, topK, textField },
          secrets: {}
        }
      );
      const outDocs = (result.outputs as { documents?: RankedDoc[] }).documents ?? [];
      return {
        outputs: { documents: outDocs },
        ...(result.usage ? { usage: result.usage } : {})
      };
    }

    const endpoint = String(config.endpoint ?? "https://api-inference.huggingface.co");
    if (!secrets.hfApiKey) {
      throw new Error(
        "rerank_bge: hfApiKey secret is required (HuggingFace Inference API)"
      );
    }
    // The HF Inference API accepts a sentence-pair payload as
    // `{ inputs: { source_sentence, sentences } }` for sentence-similarity
    // pipelines; cross-encoder rerankers expose the same shape and
    // return one float per `sentences[i]`. One request, batched.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let scores: number[];
    try {
      const response = await fetch(
        `${endpoint}/models/${encodeURIComponent(model)}`,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${secrets.hfApiKey}`
          },
          body: JSON.stringify({
            inputs: {
              source_sentence: question,
              sentences: documents.map((d) =>
                String((d as Record<string, unknown>)[textField] ?? "").slice(0, 4000)
              )
            }
          })
        }
      );
      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `rerank_bge: HF API returned ${response.status}: ${text.slice(0, 400)}`
        );
      }
      const raw = await response.json();
      if (!Array.isArray(raw) || raw.some((s) => typeof s !== "number")) {
        throw new Error(
          `rerank_bge: unexpected HF response shape (expected number[]): ${JSON.stringify(raw).slice(0, 200)}`
        );
      }
      scores = raw as number[];
    } finally {
      clearTimeout(timer);
    }
    const reranked = documents
      .map((doc, i) => ({ ...doc, rerankScore: scores[i] ?? 0 }))
      .sort((a, b) => (b.rerankScore as number) - (a.rerankScore as number))
      .slice(0, topK);
    return {
      outputs: { documents: reranked },
      usage: { provider: "huggingface", model }
    };
  }
};

// ===========================================================================
// pipeline_call — synchronous nested pipeline invocation
// ===========================================================================

/**
 * Invokes another synchronous pipeline by slug and emits its terminal
 * output. The runtime injects `runPipelineByRef` on the execution
 * input ONLY when the surrounding execution is synchronous (the API
 * /invoke + /stream path), so trying to use this from a batch
 * pipeline fails fast with a clear error.
 *
 * Cycle and depth protection lives in the API helper:
 *  - calling yourself or any ancestor → throws "cycle detected"
 *  - depth > 8 → throws "depth limit exceeded"
 * Both errors propagate up the executor as plugin failures.
 */
export const pipelineCallPlugin: InProcessPlugin = {
  manifest: {
    id: "pipeline_call",
    name: "Call Pipeline",
    version: "1.0.0",
    category: "tool",
    contract: 2,
    description:
      "Invokes another synchronous pipeline by slug. The caller MUST itself be running synchronously; batch pipelines can't sub-invoke (BullMQ jobs aren't awaitable in-process). Cycles and depth > 8 are rejected.",
    configSchema: {
      type: "object",
      properties: {
        pipelineSlug: {
          type: "string",
          description: "Slug of the target pipeline."
        },
        environment: {
          type: "string",
          description: "Environment to invoke the target in. Defaults to the caller's env."
        }
      },
      required: ["pipelineSlug"],
      additionalProperties: false
    },
    inputPorts: [
      { name: "input", description: "Payload forwarded to the target pipeline's input node." }
    ],
    outputPorts: [
      { name: "output", description: "Terminal output of the target pipeline." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "git-pull-request",
      color: "#7c3aed",
      paletteGroup: "Tools",
      formHints: {
        pipelineSlug: { widget: "text" },
        environment: { widget: "text" }
      }
    }
  },
  async execute(input) {
    const { inputs, config, runPipelineByRef } = input;
    if (!runPipelineByRef) {
      throw new Error(
        "pipeline_call requires synchronous execution context (call this pipeline via /api/pipelines/:id/invoke, not /run)"
      );
    }
    const slug = String(config.pipelineSlug ?? "");
    if (!slug) {
      throw new Error("pipeline_call: pipelineSlug is required");
    }
    const environment = config.environment ? String(config.environment) : undefined;
    // The caller's `input` port becomes the nested pipeline's input;
    // fall back to the whole inputs object so flow-style wiring also
    // works ("just pass everything I got").
    const subInput = inputs.input ?? inputs;
    const result = await runPipelineByRef({ slug, input: subInput, environment });
    return { outputs: { output: result.output } };
  }
};

// ===========================================================================
// topic_shift_detect — has the conversation topic changed?
// ===========================================================================

export const topicShiftDetectPlugin: InProcessPlugin = {
  manifest: {
    id: "topic_shift_detect",
    name: "Topic Shift Detect",
    version: "1.0.0",
    category: "router",
    contract: 2,
    description:
      "Detects whether the latest turn shifts topic vs. the conversation so far. Output drives a router downstream (e.g. invalidate the retrieved context cache when shifted).",
    configSchema: LLM_CONFIG_SCHEMA,
    secretsSchema: LLM_SECRETS_SCHEMA,
    inputPorts: [
      { name: "question", required: true },
      { name: "history" }
    ],
    outputPorts: [
      { name: "shifted", description: "Boolean — true when the latest turn changes topic." },
      { name: "confidence", description: "Model-reported confidence in 0..1." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "compass",
      color: "#7c3aed",
      paletteGroup: "Retrieval",
      formHints: {
        provider: { widget: "select" },
        temperature: { widget: "range", min: 0, max: 2, step: 0.1 },
        apiKey: { widget: "secret" }
      }
    }
  },
  async execute(input) {
    const { inputs } = input;
    const question = questionFrom(inputs);
    const history =
      (inputs.history as Array<{ role: string; content: string }> | undefined) ?? [];
    if (history.length === 0) {
      return { outputs: { shifted: false, confidence: 1 } };
    }
    const transcript = history
      .slice(-6)
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");
    const prompt = `Given the conversation history below, decide whether the new turn changes the topic. Respond as compact JSON: {"shifted": true|false, "confidence": 0..1}. Only the JSON.\n\nHistory:\n${transcript}\n\nNew turn: ${question}\n\nJSON:`;
    const result = await chat(input, [{ role: "user", content: prompt }]);
    let shifted = false;
    let confidence = 0.5;
    try {
      const parsed = JSON.parse(result.text.trim());
      if (parsed && typeof parsed === "object") {
        shifted = parsed.shifted === true;
        confidence = Number.isFinite(parsed.confidence) ? Number(parsed.confidence) : 0.5;
      }
    } catch {
      // Best-effort prose fallback.
      shifted = /yes|true|shift|changed/i.test(result.text);
      confidence = 0.5;
    }
    return {
      outputs: { shifted, confidence },
      usage: { provider: result.provider, model: result.model, ...result.usage }
    };
  }
};
