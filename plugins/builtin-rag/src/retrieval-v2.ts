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
    const points: VectorPoint[] = vectors.map((vector, i) => {
      const chunk = chunks[i] ?? {};
      const { text, index: _idx, ...rest } = chunk;
      return {
        id: `${idPrefix}${i}`,
        vector,
        tenantId: context.tenantId,
        payload: { text: text ?? "", chunkIndex: i, ...rest }
      };
    });
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
