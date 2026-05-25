import { createHash } from "node:crypto";
import type { InProcessPlugin } from "../../../packages/plugin-sdk/src/index.ts";
import { pickBackendName } from "./dataset-binding.ts";
import type { PipelineSpec } from "../../../packages/core/src/index.ts";
import { OpenAIProvider, AnthropicProvider, OllamaCompatibleProvider, ProviderRegistry } from "../../../packages/providers/src/index.ts";

/**
 * Derive a deterministic v5-style UUID from an arbitrary key. Qdrant point
 * ids are valid only as UUIDs or unsigned 64-bit ints — chunk fallbacks
 * like `${executionId}_${index}` (with embedded dashes followed by
 * non-hex tails) fail validation with `Bad Request`. Hashing the natural
 * key `${docId}::${chunkIndex}` keeps incremental upserts replacing the
 * same point instead of creating new ones on every run.
 */
function deterministicUuid(key: string): string {
  const hex = createHash("sha1").update(key).digest("hex");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20, 32)
  );
}

// Codebase + docs ingest plugins live in their own module to keep this file
// from sprawling further. Re-exported so the plugin-loader's namespace scan
// picks them up alongside everything else.
export {
  filesystemSourcePlugin,
  deltaFilterPlugin,
  codeChunkerPlugin,
  qdrantDeletePlugin,
  opensearchDeletePlugin,
  pathClassifierPlugin
} from "./ingest.ts";
// Data-shaping plugins (JSONata/JMESPath transform + XML codec) live in their
// own module; re-exported so the plugin-loader's namespace scan registers
// them alongside the rest.
export { transformPlugin, xmlCodecPlugin } from "./transform.ts";
// Phase 9 retrieval plugin set. v2-native, dataset-aware.
export {
  datasetSearchPlugin,
  datasetUpsertPlugin,
  queryHydePlugin,
  queryFanoutPlugin,
  mergeRrfPlugin,
  rerankLlmPlugin,
  rerankBgePlugin,
  pipelineCallPlugin,
  conversationRewritePlugin,
  topicShiftDetectPlugin
} from "./retrieval-v2.ts";
import { createVectorStore } from "../../../packages/vector/src/index.ts";
import type { DistanceMetric, VectorPoint } from "../../../packages/vector/src/index.ts";
import {
  OpenSearchClient,
  OpenSearchVectorStore,
  createOpenSearchClient
} from "../../../packages/opensearch/src/index.ts";

function buildProviderRegistry(): ProviderRegistry {
  const providers = new ProviderRegistry();
  providers.register(new OpenAIProvider());
  providers.register(new AnthropicProvider());
  providers.register(new OllamaCompatibleProvider());
  return providers;
}

async function embedTexts(args: {
  texts: string[];
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  tenantId: string;
  resolvedValues: Record<string, { value: unknown } | undefined>;
}): Promise<{ vectors: number[][]; dimensions: number; provider: string; model: string; embeddingTokens?: number }> {
  const providers = buildProviderRegistry();
  const providerId = String(
    args.config.provider ?? args.resolvedValues["embeddings.provider"]?.value ?? "ollama"
  );
  const provider = providers.require(providerId);
  if (!provider.embeddings) {
    throw new Error(`Provider ${providerId} does not support embeddings`);
  }
  const response = await provider.embeddings({
    tenantId: args.tenantId,
    model: String(args.config.model ?? args.resolvedValues["embeddings.model"]?.value ?? "nomic-embed-text"),
    input: args.texts,
    apiKey: args.secrets.apiKey,
    baseUrl: args.config.baseUrl ? String(args.config.baseUrl) : undefined
  });
  return {
    vectors: response.vectors,
    dimensions: response.dimensions ?? response.vectors[0]?.length ?? 0,
    provider: response.provider,
    model: response.model,
    embeddingTokens: response.usage?.embeddingTokens
  };
}

export const manualTextInputPlugin: InProcessPlugin = {
  manifest: {
    id: "manual_text_input",
    name: "Manual Text Input",
    version: "1.0.0",
    category: "datasource",
    description: "Passes runtime text input into the pipeline.",
    configSchema: {
      type: "object",
      description: "Manual input has no configuration; text is supplied at runtime.",
      properties: {},
      additionalProperties: false
    },
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    outputPorts: [
      { name: "text", description: "Raw text supplied at execution time." },
      { name: "question", description: "Question payload, when the runtime input set one." }
    ],
    capabilities: ["query", "ingestion"],
    ui: { icon: "keyboard" }
  },
  async execute({ inputs }) {
    // Emit on named ports AND preserve flat spread so legacy unported edges
    // (which use the flatten-at-root fallback) keep working unchanged.
    return { outputs: { ...inputs, text: inputs.text ?? inputs.input, question: inputs.question } };
  }
};

export const basicTextChunkerPlugin: InProcessPlugin = {
  manifest: {
    id: "basic_text_chunker",
    name: "Basic Text Chunker",
    version: "1.0.0",
    category: "chunker",
    description: "Splits text into overlapping character chunks.",
    configSchema: {
      type: "object",
      properties: {
        chunkSize: {
          type: "integer",
          default: 1000,
          description: "Maximum characters per chunk."
        },
        overlap: {
          type: "integer",
          default: 100,
          description: "Characters of overlap shared between adjacent chunks."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "documents", description: "Array of { content, path, docId? } documents to chunk individually." },
      { name: "text", description: "Single string to chunk; used when `documents` is unset (legacy)." }
    ],
    outputPorts: [
      { name: "chunks", description: "Array of { text, index, docId?, path? } chunks. When `documents` was the input, each chunk carries its source doc's docId/path so a downstream sink can keep provenance." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "scissors",
      formHints: {
        chunkSize: { widget: "number", min: 1, step: 50 },
        overlap: { widget: "number", min: 0, step: 10 }
      }
    }
  },
  async execute({ inputs, config }) {
    const chunkSize = Number(config.chunkSize ?? 1000);
    const overlap = Number(config.overlap ?? 100);
    const step = Math.max(1, chunkSize - overlap);

    /** Split one text string; tag each chunk with its source ids when given. */
    const chunkOne = (
      text: string,
      meta: { docId?: string; path?: string }
    ): Array<{ text: string; index: number; docId?: string; path?: string }> => {
      const out: Array<{ text: string; index: number; docId?: string; path?: string }> = [];
      for (let start = 0; start < text.length; start += step) {
        const chunk: { text: string; index: number; docId?: string; path?: string } = {
          text: text.slice(start, start + chunkSize),
          index: out.length
        };
        if (meta.docId !== undefined) chunk.docId = meta.docId;
        if (meta.path !== undefined) chunk.path = meta.path;
        out.push(chunk);
      }
      return out;
    };

    // Prefer the documents array (the `filesystem_source → delta_filter →
    // basic_text_chunker` path); fall back to a single-string `text` /
    // `input` for legacy callers.
    const documents = inputs.documents as
      | Array<{ content?: unknown; text?: unknown; path?: unknown; docId?: unknown }>
      | undefined;
    if (Array.isArray(documents) && documents.length > 0) {
      const chunks = documents.flatMap((doc) => {
        const text = String(doc.content ?? doc.text ?? "");
        const docId = typeof doc.docId === "string" ? doc.docId : typeof doc.path === "string" ? doc.path : undefined;
        const path = typeof doc.path === "string" ? doc.path : undefined;
        return chunkOne(text, { docId, path });
      });
      // Re-index across the flattened array so downstream nodes get a
      // single contiguous chunk stream.
      chunks.forEach((c, i) => (c.index = i));
      return { outputs: { chunks } };
    }

    const text = String(inputs.text ?? inputs.input ?? "");
    return { outputs: { chunks: chunkOne(text, {}) } };
  }
};

export const basicPromptTemplatePlugin: InProcessPlugin = {
  manifest: {
    id: "basic_rag_prompt",
    name: "Basic RAG Prompt",
    version: "1.0.0",
    category: "prompt_template",
    description: "Builds a compact RAG prompt from question and context.",
    configSchema: {
      type: "object",
      properties: {
        template: {
          type: "string",
          default: "Answer using only the context.\n\nContext:\n{{context}}\n\nQuestion: {{question}}",
          description:
            "Prompt template. {{context}} and {{question}} are substituted before sending to the model."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "question", required: true, description: "User question text the template substitutes into {{question}}." },
      { name: "documents", description: "Retrieved documents the template stringifies into {{context}}." }
    ],
    outputPorts: [
      { name: "messages", description: "Chat-style message array ready for an LLM plugin." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "file-text",
      formHints: { template: { widget: "textarea", rows: 6 } }
    }
  },
  async execute({ inputs, config }) {
    const question = String((inputs.input as any)?.question ?? inputs.question ?? "");
    const context = JSON.stringify(inputs.documents ?? (inputs.retrieve as any)?.documents ?? []);
    const template = String(config.template ?? "Answer using only the context.\n\nContext:\n{{context}}\n\nQuestion: {{question}}");
    return {
      outputs: {
        messages: [
          { role: "system", content: "You are a careful RAG assistant. Cite sources when available." },
          { role: "user", content: template.replace("{{context}}", context).replace("{{question}}", question) }
        ]
      }
    };
  }
};

export const providerChatPlugin: InProcessPlugin = {
  manifest: {
    id: "provider_chat",
    name: "Provider Chat",
    version: "1.0.0",
    category: "llm",
    description: "Calls OpenAI, Anthropic, or Ollama-compatible chat provider.",
    configSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["openai", "anthropic", "ollama"],
          default: "ollama",
          description: "Chat provider adapter to call."
        },
        model: {
          type: "string",
          default: "llama3.1",
          description: "Model id passed to the provider."
        },
        temperature: {
          type: "number",
          default: 0.2,
          description: "Sampling temperature."
        },
        maxTokens: {
          type: "integer",
          default: 1024,
          description: "Maximum tokens to generate."
        },
        baseUrl: {
          type: "string",
          description: "Override the provider base URL (e.g. self-hosted Ollama)."
        }
      },
      additionalProperties: false
    },
    secretsSchema: {
      type: "object",
      properties: {
        apiKey: {
          type: "string",
          format: "secret-ref",
          description:
            "Reference to the provider API key secret. Required for hosted providers (OpenAI/Anthropic)."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "messages", required: true, description: "Chat messages array from a prompt template." }
    ],
    outputPorts: [
      { name: "text", description: "Generated response text." },
      { name: "provider", description: "Provider id that handled the call." },
      { name: "model", description: "Model id that produced the text." }
    ],
    capabilities: ["query", "streaming"],
    ui: {
      icon: "message-square",
      color: "#7c3aed",
      formHints: {
        provider: { widget: "select" },
        temperature: { widget: "range", min: 0, max: 2, step: 0.1 },
        maxTokens: { widget: "number", min: 1, step: 64 },
        apiKey: { widget: "secret" }
      }
    }
  },
  async execute(input) {
    const { inputs, config, secrets, context, onToken } = input;
    const providers = new ProviderRegistry();
    providers.register(new OpenAIProvider());
    providers.register(new AnthropicProvider());
    providers.register(new OllamaCompatibleProvider());
    const providerId = String(config.provider ?? context.resolvedConfig.values["llm.provider"]?.value ?? "ollama");
    const provider = providers.require(providerId);
    const chatArgs = {
      tenantId: context.tenantId,
      model: String(config.model ?? context.resolvedConfig.values["llm.model"]?.value ?? "llama3.1"),
      messages: (inputs.messages ?? (inputs.prompt as any)?.messages ?? []) as any,
      temperature: Number(config.temperature ?? context.resolvedConfig.values["llm.temperature"]?.value ?? 0.2),
      maxTokens: Number(config.maxTokens ?? context.resolvedConfig.values["llm.max_tokens"]?.value ?? 1024),
      apiKey: secrets.apiKey,
      baseUrl: config.baseUrl ? String(config.baseUrl) : undefined
    };
    // Phase 13 follow-up: token-by-token streaming. When the executor
    // wired an `onToken` callback (i.e. this run is happening behind
    // /stream) AND the provider supports streamChat, we stream tokens
    // out as they arrive while still returning the full text in the
    // outputs at the end. Providers without streamChat silently fall
    // through to the synchronous chat call below.
    if (onToken && provider.streamChat) {
      let collected = "";
      for await (const event of provider.streamChat(chatArgs)) {
        if (event.type === "token" && event.token) {
          collected += event.token;
          onToken(event.token);
        } else if (event.type === "error" && event.error) {
          throw new Error(event.error);
        } else if (event.type === "done") {
          break;
        }
      }
      return {
        outputs: { text: collected, provider: provider.id, model: chatArgs.model }
      };
    }
    const response = await provider.chat({
      tenantId: context.tenantId,
      model: chatArgs.model,
      messages: chatArgs.messages,
      temperature: Number(config.temperature ?? context.resolvedConfig.values["llm.temperature"]?.value ?? 0.2),
      maxTokens: Number(config.maxTokens ?? context.resolvedConfig.values["llm.max_tokens"]?.value ?? 1024),
      apiKey: secrets.apiKey,
      baseUrl: config.baseUrl ? String(config.baseUrl) : undefined
    });
    return {
      outputs: { text: response.text, provider: response.provider, model: response.model },
      usage: { provider: response.provider, model: response.model, ...response.usage }
    };
  }
};

export const jsonOutputParserPlugin: InProcessPlugin = {
  manifest: {
    id: "json_output_parser",
    name: "JSON Output Parser",
    version: "1.0.0",
    category: "output_parser",
    description: "Attempts to parse model text as JSON.",
    configSchema: {
      type: "object",
      description: "No configuration; parses upstream model text as JSON.",
      properties: {},
      additionalProperties: false
    },
    inputPorts: [
      { name: "text", required: true, description: "Model text to parse as JSON." }
    ],
    outputPorts: [
      { name: "json", description: "Parsed JSON value, or null when parsing fails." },
      { name: "raw", description: "Original text string." }
    ],
    capabilities: ["query"],
    ui: { icon: "braces" }
  },
  async execute({ inputs }) {
    const text = String((inputs.llm as any)?.text ?? inputs.text ?? "");
    try {
      return { outputs: { json: JSON.parse(text), raw: text } };
    } catch {
      return { outputs: { json: null, raw: text, parseError: true } };
    }
  }
};

export const keywordGuardrailPlugin: InProcessPlugin = {
  manifest: {
    id: "simple_keyword_guardrail",
    name: "Simple Keyword Guardrail",
    version: "1.0.0",
    category: "guardrail",
    description: "Blocks configured keywords.",
    configSchema: {
      type: "object",
      properties: {
        blockedKeywords: {
          type: "array",
          items: { type: "string" },
          default: [],
          description: "Case-insensitive keywords that cause the request to be blocked."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "text", description: "Text or message payload to scan." },
      { name: "messages", description: "Chat messages to scan (any field is stringified before scanning)." }
    ],
    outputPorts: [
      { name: "messages", description: "Original messages, forwarded when no blocked keyword fires." },
      { name: "text", description: "Original text, forwarded when no blocked keyword fires." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "shield",
      formHints: { blockedKeywords: { widget: "tags" } }
    }
  },
  async execute({ inputs, config }) {
    const text = JSON.stringify(inputs);
    const blocked = (config.blockedKeywords as string[] | undefined ?? []).find((keyword) => text.toLowerCase().includes(keyword.toLowerCase()));
    if (blocked) throw new Error(`Guardrail blocked keyword: ${blocked}`);
    // Emit the spread + named slots so both port-based and flatten-fallback
    // edges resolve correctly (downstream sees `messages`/`text` at root).
    return { outputs: { ...inputs } };
  }
};

export const evaluatorStubPlugin: InProcessPlugin = {
  manifest: {
    id: "simple_evaluator_stub",
    name: "Simple Evaluator Stub",
    version: "1.0.0",
    category: "evaluator",
    description: "Returns a placeholder evaluation score.",
    configSchema: {
      type: "object",
      description: "Stub evaluator; no configuration.",
      properties: {},
      additionalProperties: false
    },
    outputPorts: [
      { name: "score", description: "Numeric score (placeholder)." },
      { name: "passed", description: "Boolean pass/fail (placeholder always true)." },
      { name: "notes", description: "Free-form notes string." }
    ],
    capabilities: ["evaluation"],
    ui: { icon: "check-circle" }
  },
  async execute() {
    return { outputs: { score: 1, passed: true, notes: "stub evaluator" } };
  }
};

export const providerEmbeddingsPlugin: InProcessPlugin = {
  manifest: {
    id: "provider_embeddings",
    name: "Provider Embeddings",
    version: "1.0.0",
    category: "embedder",
    description: "Embeds input texts using OpenAI or Ollama-compatible embedding provider.",
    configSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["openai", "anthropic", "ollama"],
          default: "ollama",
          description: "Embedding provider adapter to call."
        },
        model: {
          type: "string",
          default: "nomic-embed-text",
          description: "Embedding model id passed to the provider."
        },
        baseUrl: {
          type: "string",
          description: "Override the provider base URL (e.g. self-hosted Ollama)."
        }
      },
      additionalProperties: false
    },
    secretsSchema: {
      type: "object",
      properties: {
        apiKey: {
          type: "string",
          format: "secret-ref",
          description:
            "Reference to the provider API key secret. Required for hosted providers."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "texts", description: "Array of strings to embed. Takes priority over `text` and `chunks`." },
      { name: "text", description: "Single string to embed when `texts` is unset." },
      { name: "chunks", description: "Array of `{ text }` chunks; their texts are embedded." }
    ],
    outputPorts: [
      { name: "vectors", description: "Embeddings, one per input text." },
      { name: "dimensions", description: "Vector dimensionality." }
    ],
    capabilities: ["ingestion", "query"],
    ui: {
      icon: "vector",
      color: "#0ea5e9",
      formHints: {
        provider: { widget: "select" },
        apiKey: { widget: "secret" }
      }
    }
  },
  async execute({ inputs, config, secrets, context }) {
    const rawTexts =
      (inputs.texts as unknown[] | undefined) ??
      (inputs.chunks as Array<{ text?: string }> | undefined)?.map((chunk) => chunk?.text ?? "") ??
      (inputs.text !== undefined ? [inputs.text] : []);
    const texts = (rawTexts as unknown[]).map((value) => String(value ?? ""));
    if (texts.length === 0) {
      return { outputs: { vectors: [], dimensions: 0 } };
    }
    const embedded = await embedTexts({
      texts,
      config,
      secrets,
      tenantId: context.tenantId,
      resolvedValues: context.resolvedConfig.values
    });
    return {
      outputs: { vectors: embedded.vectors, dimensions: embedded.dimensions },
      usage: { provider: embedded.provider, model: embedded.model, embeddingTokens: embedded.embeddingTokens }
    };
  }
};

export const qdrantRetrieverPlugin: InProcessPlugin = {
  manifest: {
    id: "qdrant_retriever",
    name: "Qdrant Retriever",
    version: "1.0.0",
    category: "retriever",
    contract: 2,
    datasetModalities: ["vector"],
    description: "Queries a vector store (Qdrant or in-memory) for the top-K most similar documents.",
    configSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Qdrant URL. Falls back to the in-memory store when unset."
        },
        apiKey: {
          type: "string",
          description: "Qdrant API key (passed to the vector store client)."
        },
        collection: {
          type: "string",
          default: "default",
          description: "Collection to query."
        },
        topK: {
          type: "integer",
          default: 5,
          description: "Number of nearest documents to return."
        },
        filter: {
          type: "object",
          additionalProperties: true,
          description: "Optional payload filter applied to the query."
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
        }
      },
      additionalProperties: false
    },
    secretsSchema: {
      type: "object",
      properties: {
        apiKey: {
          type: "string",
          format: "secret-ref",
          description: "Reference to the embedding provider API key secret (used for query embedding)."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "question", description: "Natural-language question. Embedded on the fly when no queryVector is supplied." },
      { name: "queryVector", description: "Pre-computed embedding for the query. Skips on-the-fly embedding when present." }
    ],
    outputPorts: [
      { name: "documents", description: "Top-K nearest documents with score + payload fields." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "search",
      color: "#16a34a",
      formHints: {
        provider: { widget: "select" },
        topK: { widget: "number", min: 1, step: 1 },
        filter: { widget: "json" }
      }
    }
  },
  async execute(input) {
    const { inputs, config, secrets, context } = input;
    const store = createVectorStore({
      url: config.url ? String(config.url) : undefined,
      apiKey: config.apiKey ? String(config.apiKey) : undefined
    });
    const collection = String(
      pickBackendName(input, "vector") ??
        context.resolvedConfig.values["vector.collection"]?.value ??
        "default"
    );
    const topK = Number(config.topK ?? context.resolvedConfig.values["retriever.top_k"]?.value ?? 5);

    let queryVector = inputs.queryVector as number[] | undefined;
    let usage: { provider?: string; model?: string; embeddingTokens?: number } | undefined;
    if (!queryVector || queryVector.length === 0) {
      const question = String(inputs.question ?? (inputs.input as any)?.question ?? "");
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

export const vectorUpsertPlugin: InProcessPlugin = {
  manifest: {
    id: "vector_upsert",
    name: "Vector Upsert",
    version: "1.0.0",
    category: "sink",
    contract: 2,
    datasetModalities: ["vector"],
    description: "Ensures a collection exists and upserts embedded chunks into the vector store.",
    configSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Qdrant URL. Falls back to the in-memory store when unset."
        },
        apiKey: {
          type: "string",
          description: "Qdrant API key (passed to the vector store client)."
        },
        collection: {
          type: "string",
          default: "default",
          description: "Target collection name."
        },
        distance: {
          type: "string",
          enum: ["cosine", "dot", "euclidean"],
          default: "cosine",
          description: "Distance metric used when the collection is created."
        },
        dimensions: {
          type: "integer",
          description: "Vector dimensionality. Inferred from the first vector when unset."
        },
        idPrefix: {
          type: "string",
          description: "Prefix for generated point ids. Defaults to the execution id."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "chunks", required: true, description: "Chunks whose text + metadata is stored alongside each vector." },
      { name: "vectors", required: true, description: "Embedding vectors aligned with `chunks`." }
    ],
    outputPorts: [
      { name: "upserted", description: "Count of points written to the vector store." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "database",
      color: "#16a34a",
      formHints: {
        distance: { widget: "select" },
        dimensions: { widget: "number", min: 1, step: 1 }
      }
    }
  },
  async execute(input) {
    const { inputs, config, context } = input;
    const store = createVectorStore({
      url: config.url ? String(config.url) : undefined,
      apiKey: config.apiKey ? String(config.apiKey) : undefined
    });
    const collection = String(
      pickBackendName(input, "vector") ??
        context.resolvedConfig.values["vector.collection"]?.value ??
        "default"
    );
    const distance = String(
      config.distance ?? context.resolvedConfig.values["vector.distance"]?.value ?? "cosine"
    ) as DistanceMetric;

    const chunks = (inputs.chunks as Array<{ text?: string; index?: number } & Record<string, unknown>> | undefined) ?? [];
    const vectors = (inputs.vectors as number[][] | undefined) ?? [];
    if (vectors.length === 0) {
      return { outputs: { upserted: 0 } };
    }
    const dimensions = Number(config.dimensions ?? vectors[0]?.length ?? 0);
    await store.ensureCollection(collection, { dimensions, distance });

    const idPrefix = String(config.idPrefix ?? context.executionId ?? "doc");
    const points: VectorPoint[] = vectors.map((vector, index) => {
      const chunk = chunks[index] ?? {};
      const { text, index: chunkIndex, ...rest } = chunk;
      return {
        id: String(chunk.id ?? `${idPrefix}_${index}`),
        vector,
        tenantId: context.tenantId,
        payload: { text: text ?? "", chunkIndex: chunkIndex ?? index, ...rest }
      };
    });
    await store.upsert(collection, points);
    return { outputs: { upserted: points.length } };
  }
};

export const textDocumentLoaderPlugin: InProcessPlugin = {
  manifest: {
    id: "text_document_loader",
    name: "Text Document Loader",
    version: "1.0.0",
    category: "loader",
    description:
      "Normalizes raw text, a uri reference, or a documents array into a uniform { documents:[{text,metadata}] } shape.",
    configSchema: {
      type: "object",
      properties: {
        trim: {
          type: "boolean",
          default: true,
          description: "Trim leading/trailing whitespace from each document's text."
        },
        splitOnBlankLines: {
          type: "boolean",
          default: false,
          description: "Split a single text input into multiple documents on blank lines."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "documents", description: "Existing documents array to normalize (passed through with cleaning applied)." },
      { name: "text", description: "Raw text to wrap as a document. Used when `documents` is absent." },
      { name: "uri", description: "Optional source URI added to document metadata." }
    ],
    outputPorts: [
      { name: "documents", description: "Normalized { text, metadata } array." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "file-input",
      formHints: {
        trim: { widget: "checkbox" },
        splitOnBlankLines: { widget: "checkbox" }
      }
    }
  },
  async execute({ inputs, config }) {
    const trim = config.trim !== false;
    const splitOnBlankLines = config.splitOnBlankLines === true;
    const normalize = (value: string): string => (trim ? value.trim() : value);

    const documents: Array<{ text: string; metadata: Record<string, unknown> }> = [];

    const existing = inputs.documents as Array<unknown> | undefined;
    if (Array.isArray(existing) && existing.length > 0) {
      for (const entry of existing) {
        if (typeof entry === "string") {
          documents.push({ text: normalize(entry), metadata: {} });
        } else if (entry && typeof entry === "object") {
          const record = entry as Record<string, unknown>;
          const text = normalize(String(record.text ?? record.content ?? ""));
          const metadata = (record.metadata as Record<string, unknown> | undefined) ?? {};
          documents.push({ text, metadata });
        }
      }
    }

    if (documents.length === 0) {
      const uri = inputs.uri !== undefined ? String(inputs.uri) : undefined;
      const rawText =
        inputs.text !== undefined
          ? String(inputs.text)
          : inputs.input !== undefined
            ? String(inputs.input)
            : "";
      if (rawText.length > 0) {
        const pieces = splitOnBlankLines
          ? rawText.split(/\n\s*\n/).map(normalize).filter((piece) => piece.length > 0)
          : [normalize(rawText)];
        for (const piece of pieces) {
          documents.push({ text: piece, metadata: uri ? { uri } : {} });
        }
      } else if (uri) {
        documents.push({ text: "", metadata: { uri } });
      }
    }

    return { outputs: { documents } };
  }
};

export const textParserPlugin: InProcessPlugin = {
  manifest: {
    id: "text_parser",
    name: "Text Parser",
    version: "1.0.0",
    category: "parser",
    description:
      "Extracts and cleans plain text from common input shapes (text, documents, chunks) into a single { text } string.",
    configSchema: {
      type: "object",
      properties: {
        stripHtml: {
          type: "boolean",
          default: false,
          description: "Remove HTML tags from the extracted text."
        },
        collapseWhitespace: {
          type: "boolean",
          default: true,
          description: "Collapse runs of whitespace into single spaces and trim."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "text", description: "Single string to clean." },
      { name: "documents", description: "Array of { text } documents to concatenate then clean." },
      { name: "chunks", description: "Array of { text } chunks to concatenate then clean." }
    ],
    outputPorts: [
      { name: "text", description: "Final cleaned string." }
    ],
    capabilities: ["ingestion", "query"],
    ui: {
      icon: "file-text",
      formHints: {
        stripHtml: { widget: "checkbox" },
        collapseWhitespace: { widget: "checkbox" }
      }
    }
  },
  async execute({ inputs, config }) {
    const stripHtml = config.stripHtml === true;
    const collapseWhitespace = config.collapseWhitespace !== false;

    const collect = (value: unknown): string => {
      if (typeof value === "string") return value;
      if (Array.isArray(value)) {
        return value
          .map((entry) => {
            if (typeof entry === "string") return entry;
            if (entry && typeof entry === "object") {
              const record = entry as Record<string, unknown>;
              return String(record.text ?? record.content ?? "");
            }
            return "";
          })
          .join("\n\n");
      }
      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return String(record.text ?? record.content ?? "");
      }
      return value === undefined || value === null ? "" : String(value);
    };

    let text =
      inputs.text !== undefined
        ? collect(inputs.text)
        : inputs.documents !== undefined
          ? collect(inputs.documents)
          : inputs.chunks !== undefined
            ? collect(inputs.chunks)
            : collect(inputs.input);

    if (stripHtml) {
      text = text.replace(/<[^>]*>/g, " ");
    }
    if (collapseWhitespace) {
      text = text.replace(/\s+/g, " ").trim();
    }

    return { outputs: { text } };
  }
};

export const qdrantVectorStorePlugin: InProcessPlugin = {
  manifest: {
    id: "qdrant_vector_store",
    name: "Qdrant Vector Store",
    version: "1.0.0",
    category: "vector_store",
    contract: 2,
    datasetModalities: ["vector"],
    description:
      "Ensures a collection exists and upserts embedded chunks/vectors into the vector store (Qdrant or in-memory).",
    configSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Qdrant URL. Falls back to the in-memory store when unset."
        },
        collection: {
          type: "string",
          default: "default",
          description: "Target collection name."
        },
        distance: {
          type: "string",
          enum: ["cosine", "dot", "euclidean"],
          default: "cosine",
          description: "Distance metric used when the collection is created."
        },
        dimensions: {
          type: "integer",
          description: "Vector dimensionality. Inferred from the first vector when unset."
        }
      },
      additionalProperties: false
    },
    secretsSchema: {
      type: "object",
      properties: {
        apiKey: {
          type: "string",
          format: "secret-ref",
          description: "Reference to the Qdrant API key secret (passed to the vector store client)."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "chunks", required: true, description: "Chunks whose text + metadata is stored alongside each vector." },
      { name: "vectors", required: true, description: "Embedding vectors aligned with `chunks`." }
    ],
    outputPorts: [
      { name: "upserted", description: "Count of points written to the collection." },
      { name: "collection", description: "Name of the collection the points were written to." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "database",
      color: "#16a34a",
      formHints: {
        distance: { widget: "select" },
        dimensions: { widget: "number", min: 1, step: 1 },
        apiKey: { widget: "secret" }
      }
    }
  },
  async execute(input) {
    const { inputs, config, secrets, context } = input;
    const store = createVectorStore({
      url: config.url ? String(config.url) : undefined,
      apiKey: secrets.apiKey ? String(secrets.apiKey) : undefined
    });
    const collection = String(
      pickBackendName(input, "vector") ??
        context.resolvedConfig.values["vector.collection"]?.value ??
        "default"
    );
    const distance = String(
      config.distance ?? context.resolvedConfig.values["vector.distance"]?.value ?? "cosine"
    ) as DistanceMetric;

    const chunks =
      (inputs.chunks as Array<{ text?: string; index?: number } & Record<string, unknown>> | undefined) ?? [];
    const vectors = (inputs.vectors as number[][] | undefined) ?? [];
    if (vectors.length === 0) {
      return { outputs: { upserted: 0, collection } };
    }
    const dimensions = Number(config.dimensions ?? vectors[0]?.length ?? 0);
    await store.ensureCollection(collection, { dimensions, distance });

    const points: VectorPoint[] = vectors.map((vector, index) => {
      const chunk = chunks[index] ?? {};
      const { text, index: chunkIndex, ...rest } = chunk;
      // Qdrant accepts UUIDs or unsigned ints only. Use the chunk's own id
      // when present, otherwise hash the natural key so re-running on the
      // same source replaces rather than duplicates.
      const docId = String(
        (chunk as Record<string, unknown>).docId ?? (chunk as Record<string, unknown>).path ?? ""
      );
      const idx = typeof chunkIndex === "number" ? chunkIndex : index;
      const pointId =
        typeof chunk.id === "string" && chunk.id.length > 0
          ? chunk.id
          : deterministicUuid(`${context.tenantId}::${collection}::${docId}::${idx}`);
      return {
        id: pointId,
        vector,
        tenantId: context.tenantId,
        payload: { text: text ?? "", chunkIndex: chunkIndex ?? index, ...rest }
      };
    });
    await store.upsert(collection, points);
    return { outputs: { upserted: points.length, collection } };
  }
};

export const scoreRerankerPlugin: InProcessPlugin = {
  manifest: {
    id: "score_reranker",
    name: "Score Reranker",
    version: "1.0.0",
    category: "reranker",
    description:
      "Reorders documents by a provided numeric score (desc), falling back to lexical overlap with the question, truncated to topK.",
    configSchema: {
      type: "object",
      properties: {
        topK: {
          type: "integer",
          default: 5,
          description: "Maximum number of documents to keep after reranking."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "documents", required: true, description: "Documents to rerank, each with optional `score` and `text`." },
      { name: "question", description: "Used to compute lexical overlap when documents lack numeric scores." }
    ],
    outputPorts: [
      { name: "documents", description: "Reranked, truncated documents array." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "arrow-up-down",
      formHints: { topK: { widget: "number", min: 1, step: 1 } }
    }
  },
  async execute({ inputs, config }) {
    const topK = Number(config.topK ?? 5);
    const documents =
      (inputs.documents as Array<{ text?: string; score?: number } & Record<string, unknown>> | undefined) ?? [];
    const question = String(inputs.question ?? (inputs.input as any)?.question ?? "");

    const tokenize = (value: string): string[] =>
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 0);
    const questionTokens = new Set(tokenize(question));

    const overlap = (text: string): number => {
      if (questionTokens.size === 0) return 0;
      let hits = 0;
      for (const token of new Set(tokenize(text))) {
        if (questionTokens.has(token)) hits += 1;
      }
      return hits;
    };

    const ranked = documents
      .map((doc, index) => {
        const numericScore = typeof doc.score === "number" ? doc.score : undefined;
        return {
          doc,
          index,
          rank: numericScore !== undefined ? numericScore : overlap(String(doc.text ?? ""))
        };
      })
      .sort((left, right) => {
        if (right.rank !== left.rank) return right.rank - left.rank;
        return left.index - right.index;
      })
      .slice(0, Math.max(0, topK))
      .map((entry) => entry.doc);

    return { outputs: { documents: ranked } };
  }
};

export const staticValueToolPlugin: InProcessPlugin = {
  manifest: {
    id: "static_value_tool",
    name: "Static Value Tool",
    version: "1.0.0",
    category: "tool",
    description:
      "Returns a configured constant value. Performs no network or filesystem access (avoids SSRF).",
    configSchema: {
      type: "object",
      properties: {
        value: {
          type: "object",
          default: {},
          additionalProperties: true,
          description: "The constant value to return. May be an object or a string."
        }
      },
      additionalProperties: false
    },
    outputPorts: [
      { name: "result", description: "The configured constant value." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "box",
      formHints: { value: { widget: "json" } }
    }
  },
  async execute({ config }) {
    const value = config.value ?? {};
    return { outputs: { result: value } };
  }
};

export const fieldRouterPlugin: InProcessPlugin = {
  manifest: {
    id: "field_router",
    name: "Field Router",
    version: "1.0.0",
    category: "router",
    description:
      "Reads an input field and maps its value to a route label via a configured routes map, passing inputs through.",
    configSchema: {
      type: "object",
      properties: {
        field: {
          type: "string",
          default: "intent",
          description: "Name of the input field whose value selects the route."
        },
        routes: {
          type: "object",
          default: {},
          additionalProperties: true,
          description: "Map of input value -> route label."
        },
        defaultRoute: {
          type: "string",
          default: "default",
          description: "Route label used when the input value does not match any route."
        }
      },
      additionalProperties: false
    },
    outputPorts: [
      { name: "route", description: "Selected route label (the mapped value or `defaultRoute`)." },
      { name: "value", description: "Original input field value the route was selected from." },
      { name: "passthrough", description: "Original inputs object, forwarded unchanged for downstream nodes." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "git-branch",
      formHints: {
        field: { widget: "text" },
        routes: { widget: "json" },
        defaultRoute: { widget: "text" }
      }
    }
  },
  async execute({ inputs, config }) {
    const field = String(config.field ?? "intent");
    const routes = (config.routes as Record<string, unknown> | undefined) ?? {};
    const defaultRoute = String(config.defaultRoute ?? "default");
    const value = inputs[field];
    const key = value === undefined || value === null ? "" : String(value);
    const route = key in routes ? String(routes[key]) : defaultRoute;
    return { outputs: { route, value, passthrough: inputs } };
  }
};

export const bufferMemoryPlugin: InProcessPlugin = {
  manifest: {
    id: "buffer_memory",
    name: "Buffer Memory",
    version: "1.0.0",
    category: "memory",
    description:
      "Appends the current turn to a conversation history array, trimming to the last N messages.",
    configSchema: {
      type: "object",
      properties: {
        maxMessages: {
          type: "integer",
          default: 20,
          description: "Maximum number of history entries to retain (most recent kept)."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "history", description: "Existing conversation history array. New entries are appended." },
      { name: "message", description: "Single new turn to append. Defaults to the inputs object minus `history`." }
    ],
    outputPorts: [
      { name: "history", description: "Updated history array, trimmed to the configured maxMessages." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "history",
      formHints: { maxMessages: { widget: "number", min: 1, step: 1 } }
    }
  },
  async execute({ inputs, config }) {
    const maxMessages = Math.max(1, Number(config.maxMessages ?? 20));
    const history = Array.isArray(inputs.history) ? [...(inputs.history as unknown[])] : [];
    const turn =
      inputs.message !== undefined
        ? inputs.message
        : Object.fromEntries(Object.entries(inputs).filter(([key]) => key !== "history"));
    history.push(turn);
    const trimmed = history.slice(Math.max(0, history.length - maxMessages));
    return { outputs: { history: trimmed } };
  }
};

// ---------------------------------------------------------------------------
// OpenSearch plugins
//
// Five in-process plugins built on the dependency-free @ragdoll/opensearch
// client: a document source, a document/vector sink, and three retrievers
// (BM25 lexical, kNN vector, and a hybrid that fuses the two). All retrievers
// isolate by tenant the same way the Qdrant retriever does.
// ---------------------------------------------------------------------------

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
    const filter = tenantField ? [{ term: { [tenantField]: context.tenantId } }] : [];

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

    if (config.createKnnIndex === true && vectorField && config.dimensions) {
      const space = { cosine: "cosinesimil", dot: "innerproduct", euclidean: "l2" }[
        String(config.distance ?? "cosine") as DistanceMetric
      ];
      await client.ensureIndex(index, {
        settings: { index: { knn: true } },
        mappings: {
          properties: {
            [vectorField]: {
              type: "knn_vector",
              dimension: Number(config.dimensions),
              method: { name: "hnsw", engine: "lucene", space_type: space }
            },
            tenantId: { type: "keyword" }
          }
        }
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
    if (tenantField) filter.push({ term: { [tenantField]: context.tenantId } });
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
        fields: { widget: "json" }
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
    const tenantFilter = tenantField ? [{ term: { [tenantField]: context.tenantId } }] : [];

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
            filter: tenantFilter
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
              filter: { bool: { must: tenantFilter } }
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

/**
 * Webhook trigger source: emits the run's input payload as its output, so a
 * pipeline started by `POST /api/triggers/webhook/<token>` flows the request
 * body straight into the DAG. The trigger token is minted out-of-band
 * (`POST /api/pipelines/:id/triggers`); this plugin only declares the intent
 * on the canvas so authors can see / wire which node a webhook drives.
 */
export const webhookTriggerPlugin: InProcessPlugin = {
  manifest: {
    id: "webhook_trigger",
    name: "Webhook Trigger",
    version: "1.0.0",
    category: "datasource",
    description:
      "Starts the pipeline when an external system POSTs to its webhook URL. " +
      "Mint a URL with POST /api/pipelines/:id/triggers; the POST body becomes the input.",
    configSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Free-text notes about what this webhook accepts."
        }
      },
      additionalProperties: false
    },
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    outputPorts: [
      { name: "body", description: "Parsed POST body delivered to the trigger URL." },
      { name: "headers", description: "Request headers, when forwarded by the trigger endpoint." },
      { name: "query", description: "Query string parameters, when present on the trigger URL." }
    ],
    capabilities: ["query", "ingestion"],
    ui: {
      icon: "webhook",
      formHints: { description: { widget: "textarea" } }
    }
  },
  async execute({ inputs }) {
    // Emit on named output ports while keeping a flat spread of the original
    // payload so legacy unported edges (which use the flatten-at-root
    // fallback) keep seeing the same shape they always did.
    const body = (inputs as Record<string, unknown>).body;
    const headers = (inputs as Record<string, unknown>).headers;
    const query = (inputs as Record<string, unknown>).query;
    return { outputs: { ...inputs, body, headers, query } };
  }
};

/**
 * Webhook output sink: POSTs the node's inputs (typically the pipeline's
 * final answer) to a configured URL when the DAG reaches it. The optional
 * authorization header is templated from a secret reference so credentials
 * never live in the pipeline spec; non-2xx responses fail the node so the
 * execution is marked failed and retried per the pipeline's policy.
 */
export const webhookOutputPlugin: InProcessPlugin = {
  manifest: {
    id: "webhook_output",
    name: "Webhook Output",
    version: "1.0.0",
    category: "sink",
    description:
      "POSTs the pipeline result to a configured URL when this node runs.",
    configSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description: "Absolute URL to POST the JSON result to."
        },
        method: {
          type: "string",
          enum: ["POST", "PUT", "PATCH"],
          default: "POST"
        },
        headers: {
          type: "object",
          description:
            "Extra static headers (e.g. `{ \"x-source\": \"ragdoll\" }`).",
          additionalProperties: { type: "string" }
        },
        timeoutMs: {
          type: "integer",
          default: 10000,
          description: "Request timeout in milliseconds."
        }
      },
      additionalProperties: false
    },
    secretsSchema: {
      type: "object",
      properties: {
        authorization: {
          type: "string",
          description:
            "Optional `Authorization` header value (e.g. `Bearer <secret>`)."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "payload", description: "Object that becomes the JSON body of the outbound request. Defaults to the entire inputs bag." }
    ],
    outputPorts: [
      { name: "delivered", description: "Delivery receipt: { url, status, response }." }
    ],
    capabilities: ["query", "ingestion"],
    ui: {
      icon: "send",
      formHints: {
        url: { widget: "text" },
        method: { widget: "select" },
        headers: { widget: "json" }
      }
    }
  },
  async execute({ inputs, config, secrets }) {
    const url = String(config.url ?? "");
    if (!url) throw new Error("webhook_output: `url` is required");
    const method = String(config.method ?? "POST").toUpperCase();
    const timeoutMs = Number(config.timeoutMs ?? 10000);
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    const extra = (config.headers ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === "string") headers[k] = v;
    }
    if (secrets.authorization) headers.authorization = secrets.authorization;

    // Prefer the named `payload` port when wired explicitly; otherwise fall
    // back to the full inputs bag (legacy behaviour).
    const body = inputs.payload !== undefined ? inputs.payload : inputs;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `webhook_output: ${method} ${url} -> ${response.status} ${text.slice(0, 200)}`
      );
    }
    let responseBody: unknown = undefined;
    const ct = response.headers.get("content-type") ?? "";
    const text = await response.text();
    if (text && ct.includes("application/json")) {
      try {
        responseBody = JSON.parse(text);
      } catch {
        responseBody = text;
      }
    } else if (text) {
      responseBody = text;
    }
    return {
      outputs: {
        delivered: { url, status: response.status, response: responseBody },
        ...inputs
      }
    };
  }
};

// ---------------------------------------------------------------------------
// Control-flow plugins (declared input/output ports + subgraph execution).
//
// These plugins rely on the runtime's port-aware wiring (see packages/runtime).
// `if_then` uses skip-cascading on its unselected branch; `for`/`foreach`/
// `while` call `input.runSubgraph()` to evaluate a body PipelineSpec stored in
// their config. Body specs are wrapped to the standard envelope before being
// handed to the runtime.
// ---------------------------------------------------------------------------

/**
 * Coerces a user-supplied body spec into the PipelineSpec envelope the runtime
 * expects. The builder stores bodies in node.config.body as plain `{ nodes,
 * edges, parameters? }` so they round-trip nicely; this normaliser fills in
 * the api/kind/metadata fields so validation passes inside the subgraph run.
 */
function normaliseBodySpec(raw: unknown, label: string): PipelineSpec {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const inner = (body.spec && typeof body.spec === "object" ? body.spec : body) as Record<string, unknown>;
  const nodes = Array.isArray(inner.nodes) ? inner.nodes : [];
  const edges = Array.isArray(inner.edges) ? inner.edges : [];
  const parameters = Array.isArray(inner.parameters) ? inner.parameters : undefined;
  return {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: label, description: `Iteration body for ${label}` },
    spec: {
      nodes: nodes as PipelineSpec["spec"]["nodes"],
      edges: edges as PipelineSpec["spec"]["edges"],
      ...(parameters ? { parameters: parameters as PipelineSpec["spec"]["parameters"] } : {})
    }
  };
}

/**
 * Evaluate an if_then predicate over `inputs.value`. `mode = "truthy"` (the
 * default) treats any non-empty / non-zero / non-false value as the `then`
 * branch. `mode = "equals"` compares `inputs.value` to `config.equals` via
 * `===` (with simple JSON-equality for arrays/objects). `mode = "defined"`
 * fires `then` when `inputs.value !== undefined`.
 */
function evaluateIfPredicate(inputs: Record<string, unknown>, config: Record<string, unknown>): boolean {
  const mode = String(config.mode ?? "truthy");
  const value = inputs.value;
  if (mode === "defined") return value !== undefined && value !== null;
  if (mode === "equals") {
    const target = (config as { equals?: unknown }).equals;
    if (value === target) return true;
    try {
      return JSON.stringify(value) === JSON.stringify(target);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

export const ifThenPlugin: InProcessPlugin = {
  manifest: {
    id: "if_then",
    name: "If / Then",
    version: "1.0.0",
    category: "control",
    description:
      "Routes the input payload to either the `then` or `else` output port based on a predicate. Downstream nodes wired to the unselected port are skipped by the runtime.",
    configSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["truthy", "equals", "defined"],
          default: "truthy",
          description:
            "Predicate mode. `truthy` (default) tests Boolean(inputs.value); `equals` compares against config.equals; `defined` checks for non-null/undefined."
        },
        equals: {
          description: "When mode = equals, the value to compare inputs.value against."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "value", required: true, description: "Value the predicate is evaluated against." },
      { name: "payload", description: "Optional payload to forward on the selected branch. Defaults to inputs.value." }
    ],
    outputPorts: [
      { name: "then", description: "Live when the predicate is true; carries the payload." },
      { name: "else", description: "Live when the predicate is false; carries the payload." }
    ],
    capabilities: ["query", "ingestion"],
    ui: {
      icon: "git-branch",
      formHints: {
        mode: { widget: "select" },
        equals: { widget: "json" }
      }
    }
  },
  async execute({ inputs, config }) {
    const branch = evaluateIfPredicate(inputs, config);
    const payload = inputs.payload !== undefined ? inputs.payload : inputs.value;
    return {
      outputs: branch ? { then: payload } : { else: payload },
      metadata: { branch: branch ? "then" : "else", mode: String(config.mode ?? "truthy") }
    };
  }
};

export const forLoopPlugin: InProcessPlugin = {
  manifest: {
    id: "for_loop",
    name: "For Loop",
    version: "1.0.0",
    category: "control",
    description:
      "Runs the configured body subgraph N times. Each iteration receives `{ index, total }` plus the upstream inputs, and the body's terminal output is collected into the `results` port.",
    configSchema: {
      type: "object",
      required: ["body"],
      properties: {
        count: {
          type: "integer",
          default: 1,
          description: "Number of iterations. Falls back to `inputs.count` when unset."
        },
        body: {
          type: "object",
          description: "Pipeline body executed each iteration. Stored as { nodes, edges }."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "count", description: "Override iteration count from upstream." }
    ],
    outputPorts: [
      { name: "results", description: "Array of body outputs, one per iteration." },
      { name: "final", description: "Final iteration's output (same as results[results.length - 1])." }
    ],
    capabilities: ["query", "ingestion"],
    ui: { icon: "repeat", formHints: { body: { widget: "json" } } }
  },
  async execute({ inputs, config, runSubgraph }) {
    if (!runSubgraph) throw new Error("for_loop: runtime did not provide runSubgraph (external plugin transport not supported)");
    const total = Number(inputs.count ?? config.count ?? 1) | 0;
    if (total < 0) throw new Error(`for_loop: count must be >= 0, got ${total}`);
    const body = normaliseBodySpec(config.body, "for_loop body");
    const results: unknown[] = [];
    for (let index = 0; index < total; index += 1) {
      const result = await runSubgraph(body, { ...inputs, index, total });
      results.push(result);
    }
    return { outputs: { results, final: results.at(-1) } };
  }
};

export const forEachPlugin: InProcessPlugin = {
  manifest: {
    id: "foreach",
    name: "ForEach",
    version: "1.0.0",
    category: "control",
    description:
      "Runs the configured body subgraph once per item in `inputs.items`. Each iteration receives `{ item, index, total }` plus upstream inputs; outputs are gathered into `results`.",
    configSchema: {
      type: "object",
      required: ["body"],
      properties: {
        body: {
          type: "object",
          description: "Pipeline body executed for each item. Stored as { nodes, edges }."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "items", required: true, description: "Array to iterate. Each element becomes the body's `item` input." }
    ],
    outputPorts: [
      { name: "results", description: "Array of body outputs in input order." }
    ],
    capabilities: ["query", "ingestion"],
    ui: { icon: "list", formHints: { body: { widget: "json" } } }
  },
  async execute({ inputs, config, runSubgraph }) {
    if (!runSubgraph) throw new Error("foreach: runtime did not provide runSubgraph");
    const items = (inputs.items as unknown[] | undefined) ?? [];
    if (!Array.isArray(items)) throw new Error(`foreach: inputs.items must be an array, got ${typeof items}`);
    const body = normaliseBodySpec(config.body, "foreach body");
    const results: unknown[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const result = await runSubgraph(body, { ...inputs, item: items[index], index, total: items.length });
      results.push(result);
    }
    return { outputs: { results } };
  }
};

export const whileLoopPlugin: InProcessPlugin = {
  manifest: {
    id: "while_loop",
    name: "While Loop",
    version: "1.0.0",
    category: "control",
    description:
      "Runs the configured body subgraph until the predicate is false. The body's output is fed back as the next iteration's state under `state`. Bounded by `maxIterations` to prevent runaway loops.",
    configSchema: {
      type: "object",
      required: ["body"],
      properties: {
        mode: {
          type: "string",
          enum: ["truthy", "defined"],
          default: "truthy",
          description: "Predicate mode applied to the body's `continue` output (or `state` when absent)."
        },
        maxIterations: {
          type: "integer",
          default: 100,
          description: "Hard ceiling on iterations regardless of predicate."
        },
        body: {
          type: "object",
          description: "Pipeline body executed each iteration. Should emit `state` and optionally `continue`."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "state", description: "Initial state passed to the first iteration as `state`." }
    ],
    outputPorts: [
      { name: "final", description: "Final body output when the predicate ends the loop." },
      { name: "iterations", description: "Number of body iterations executed." }
    ],
    capabilities: ["query", "ingestion"],
    ui: { icon: "rotate-cw", formHints: { body: { widget: "json" } } }
  },
  async execute({ inputs, config, runSubgraph }) {
    if (!runSubgraph) throw new Error("while_loop: runtime did not provide runSubgraph");
    const maxIterations = Number(config.maxIterations ?? 100) | 0;
    if (maxIterations <= 0) throw new Error("while_loop: maxIterations must be > 0");
    const mode = String(config.mode ?? "truthy");
    const body = normaliseBodySpec(config.body, "while_loop body");
    let state: unknown = inputs.state;
    let last: Record<string, unknown> = {};
    let iterations = 0;
    while (iterations < maxIterations) {
      last = await runSubgraph(body, { ...inputs, state, iteration: iterations });
      iterations += 1;
      const cont = last.continue !== undefined ? last.continue : last.state;
      const keepGoing = mode === "defined" ? cont !== undefined && cont !== null : Boolean(cont);
      state = last.state !== undefined ? last.state : last;
      if (!keepGoing) break;
    }
    return { outputs: { final: last, iterations } };
  }
};
