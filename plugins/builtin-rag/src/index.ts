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
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    capabilities: ["query", "ingestion"]
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
    configSchema: { type: "object" },
    capabilities: ["ingestion"]
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
    capabilities: ["query"]
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
    capabilities: ["query", "streaming"]
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
    capabilities: ["query"]
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
    capabilities: ["query"]
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
    capabilities: ["evaluation"]
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
    capabilities: ["ingestion", "query"]
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
    capabilities: ["query"]
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
    capabilities: ["ingestion"]
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
