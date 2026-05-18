import type { InProcessPlugin } from "../../../packages/plugin-sdk/src/index.ts";
import { OpenAIProvider, AnthropicProvider, OllamaCompatibleProvider, ProviderRegistry } from "../../../packages/providers/src/index.ts";
import { createVectorStore } from "../../../packages/vector/src/index.ts";
import type { DistanceMetric, VectorPoint } from "../../../packages/vector/src/index.ts";

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
    capabilities: ["query", "ingestion"],
    ui: { icon: "keyboard", paletteGroup: "Sources" }
  },
  async execute({ inputs }) {
    return { outputs: inputs };
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
    capabilities: ["ingestion"],
    ui: {
      icon: "scissors",
      paletteGroup: "Ingestion",
      formHints: {
        chunkSize: { widget: "number", min: 1, step: 50 },
        overlap: { widget: "number", min: 0, step: 10 }
      }
    }
  },
  async execute({ inputs, config }) {
    const text = String(inputs.text ?? inputs.input ?? "");
    const chunkSize = Number(config.chunkSize ?? 1000);
    const overlap = Number(config.overlap ?? 100);
    const chunks: Array<{ text: string; index: number }> = [];
    for (let start = 0; start < text.length; start += Math.max(1, chunkSize - overlap)) {
      chunks.push({ text: text.slice(start, start + chunkSize), index: chunks.length });
    }
    return { outputs: { chunks } };
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
    capabilities: ["query"],
    ui: {
      icon: "file-text",
      paletteGroup: "Prompting",
      formHints: { template: { widget: "textarea", rows: 6 } }
    }
  },
  async execute({ inputs, config }) {
    const question = String((inputs.input as any)?.question ?? inputs.question ?? "");
    const context = JSON.stringify((inputs.retrieve as any)?.documents ?? inputs.documents ?? []);
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
    capabilities: ["query", "streaming"],
    ui: {
      icon: "message-square",
      color: "#7c3aed",
      paletteGroup: "Models",
      formHints: {
        provider: { widget: "select" },
        temperature: { widget: "range", min: 0, max: 2, step: 0.1 },
        maxTokens: { widget: "number", min: 1, step: 64 },
        apiKey: { widget: "secret" }
      }
    }
  },
  async execute({ inputs, config, secrets, context }) {
    const providers = new ProviderRegistry();
    providers.register(new OpenAIProvider());
    providers.register(new AnthropicProvider());
    providers.register(new OllamaCompatibleProvider());
    const providerId = String(config.provider ?? context.resolvedConfig.values["llm.provider"]?.value ?? "ollama");
    const provider = providers.require(providerId);
    const response = await provider.chat({
      tenantId: context.tenantId,
      model: String(config.model ?? context.resolvedConfig.values["llm.model"]?.value ?? "llama3.1"),
      messages: ((inputs.prompt as any)?.messages ?? inputs.messages ?? []) as any,
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
    capabilities: ["query"],
    ui: { icon: "braces", paletteGroup: "Parsing" }
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
    capabilities: ["query"],
    ui: {
      icon: "shield",
      paletteGroup: "Guardrails",
      formHints: { blockedKeywords: { widget: "tags" } }
    }
  },
  async execute({ inputs, config }) {
    const text = JSON.stringify(inputs);
    const blocked = (config.blockedKeywords as string[] | undefined ?? []).find((keyword) => text.toLowerCase().includes(keyword.toLowerCase()));
    if (blocked) throw new Error(`Guardrail blocked keyword: ${blocked}`);
    return { outputs: inputs };
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
    capabilities: ["evaluation"],
    ui: { icon: "check-circle", paletteGroup: "Evaluation" }
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
    capabilities: ["ingestion", "query"],
    ui: {
      icon: "vector",
      color: "#0ea5e9",
      paletteGroup: "Embeddings",
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
    capabilities: ["query"],
    ui: {
      icon: "search",
      color: "#16a34a",
      paletteGroup: "Retrieval",
      formHints: {
        provider: { widget: "select" },
        topK: { widget: "number", min: 1, step: 1 },
        filter: { widget: "json" }
      }
    }
  },
  async execute({ inputs, config, secrets, context }) {
    const store = createVectorStore({
      url: config.url ? String(config.url) : undefined,
      apiKey: config.apiKey ? String(config.apiKey) : undefined
    });
    const collection = String(
      config.collection ?? context.resolvedConfig.values["vector.collection"]?.value ?? "default"
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
    capabilities: ["ingestion"],
    ui: {
      icon: "database",
      color: "#16a34a",
      paletteGroup: "Storage",
      formHints: {
        distance: { widget: "select" },
        dimensions: { widget: "number", min: 1, step: 1 }
      }
    }
  },
  async execute({ inputs, config, context }) {
    const store = createVectorStore({
      url: config.url ? String(config.url) : undefined,
      apiKey: config.apiKey ? String(config.apiKey) : undefined
    });
    const collection = String(
      config.collection ?? context.resolvedConfig.values["vector.collection"]?.value ?? "default"
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
    capabilities: ["ingestion"],
    ui: {
      icon: "file-input",
      paletteGroup: "Ingestion",
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
    capabilities: ["ingestion", "query"],
    ui: {
      icon: "file-text",
      paletteGroup: "Ingestion",
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
    capabilities: ["ingestion"],
    ui: {
      icon: "database",
      color: "#16a34a",
      paletteGroup: "Storage",
      formHints: {
        distance: { widget: "select" },
        dimensions: { widget: "number", min: 1, step: 1 },
        apiKey: { widget: "secret" }
      }
    }
  },
  async execute({ inputs, config, secrets, context }) {
    const store = createVectorStore({
      url: config.url ? String(config.url) : undefined,
      apiKey: secrets.apiKey ? String(secrets.apiKey) : undefined
    });
    const collection = String(
      config.collection ?? context.resolvedConfig.values["vector.collection"]?.value ?? "default"
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

    const idPrefix = String(context.executionId ?? "doc");
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
    capabilities: ["query"],
    ui: {
      icon: "arrow-up-down",
      paletteGroup: "Retrieval",
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
    capabilities: ["query"],
    ui: {
      icon: "box",
      paletteGroup: "Tools",
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
    capabilities: ["query"],
    ui: {
      icon: "git-branch",
      paletteGroup: "Routing",
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
    capabilities: ["query"],
    ui: {
      icon: "history",
      paletteGroup: "Memory",
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
