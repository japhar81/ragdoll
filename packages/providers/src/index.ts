import type { SecretRef } from "../../core/src/index.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ChatRequest {
  tenantId: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  timeoutMs?: number;
  apiKey?: string;
  baseUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatResponse {
  text: string;
  model: string;
  provider: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
  };
  raw?: unknown;
}

export interface EmbeddingRequest {
  tenantId: string;
  model: string;
  input: string[];
  apiKey?: string;
  baseUrl?: string;
}

export interface EmbeddingResponse {
  vectors: number[][];
  model: string;
  provider: string;
  usage?: {
    embeddingTokens?: number;
    estimatedCostUsd?: number;
  };
  dimensions?: number;
  raw?: unknown;
}

export interface ModelCatalogEntry {
  id: string;
  displayName?: string;
  contextWindow?: number;
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsEmbeddings?: boolean;
}

export interface ProviderAdapter {
  id: "openai" | "anthropic" | "ollama" | string;
  displayName: string;
  credentialRef?: SecretRef;
  chat(request: ChatRequest): Promise<ChatResponse>;
  embeddings?(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  streamChat?(request: ChatRequest): AsyncIterable<{ type: "token" | "done" | "error"; token?: string; error?: string }>;
  models(): Promise<ModelCatalogEntry[]>;
  healthCheck(config?: Record<string, unknown>): Promise<{ ok: boolean; message?: string }>;
}

export class ProviderRegistry {
  private providers = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    this.providers.set(adapter.id, adapter);
  }

  require(id: string): ProviderAdapter {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Provider ${id} is not registered`);
    return provider;
  }

  list(): ProviderAdapter[] {
    return [...this.providers.values()];
  }
}

export class OpenAIProvider implements ProviderAdapter {
  id = "openai";
  displayName = "OpenAI";

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await postJson(`${request.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, request.apiKey, {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      top_p: request.topP,
      max_tokens: request.maxTokens
    }, request.timeoutMs);
    return {
      text: response.choices?.[0]?.message?.content ?? "",
      model: response.model ?? request.model,
      provider: this.id,
      usage: {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens
      },
      raw: response
    };
  }

  async embeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const response = await postJson(`${request.baseUrl ?? "https://api.openai.com/v1"}/embeddings`, request.apiKey, {
      model: request.model,
      input: request.input
    });
    const vectors = response.data?.map((item: { embedding: number[] }) => item.embedding) ?? [];
    return {
      vectors,
      model: response.model ?? request.model,
      provider: this.id,
      dimensions: vectors[0]?.length,
      usage: { embeddingTokens: response.usage?.total_tokens },
      raw: response
    };
  }

  async models(): Promise<ModelCatalogEntry[]> {
    return [
      { id: "gpt-4o-mini", contextWindow: 128000, supportsStreaming: true, supportsTools: true },
      { id: "gpt-4o", contextWindow: 128000, supportsStreaming: true, supportsTools: true },
      { id: "text-embedding-3-small", supportsEmbeddings: true },
      { id: "text-embedding-3-large", supportsEmbeddings: true }
    ];
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true };
  }
}

export class AnthropicProvider implements ProviderAdapter {
  id = "anthropic";
  displayName = "Anthropic";

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const system = request.messages.find((message) => message.role === "system")?.content;
    const messages = request.messages.filter((message) => message.role !== "system").map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content
    }));
    const response = await postJson("https://api.anthropic.com/v1/messages", undefined, {
      model: request.model,
      system,
      messages,
      temperature: request.temperature,
      top_p: request.topP,
      max_tokens: request.maxTokens ?? 1024
    }, request.timeoutMs, {
      "anthropic-version": "2023-06-01",
      ...(request.apiKey ? { "x-api-key": request.apiKey } : {})
    });
    return {
      text: response.content?.map((part: { text?: string }) => part.text ?? "").join("") ?? "",
      model: response.model ?? request.model,
      provider: this.id,
      usage: {
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens
      },
      raw: response
    };
  }

  async models(): Promise<ModelCatalogEntry[]> {
    return [
      { id: "claude-3-5-sonnet-latest", contextWindow: 200000, supportsStreaming: true, supportsTools: true },
      { id: "claude-3-5-haiku-latest", contextWindow: 200000, supportsStreaming: true, supportsTools: true }
    ];
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true };
  }
}

export class OllamaCompatibleProvider implements ProviderAdapter {
  id = "ollama";
  displayName = "Ollama-compatible";

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const baseUrl = request.baseUrl ?? "http://localhost:11434";
    const response = await postJson(`${baseUrl}/api/chat`, undefined, {
      model: request.model,
      messages: request.messages,
      stream: false,
      options: {
        temperature: request.temperature,
        top_p: request.topP,
        num_predict: request.maxTokens
      }
    }, request.timeoutMs);
    return {
      text: response.message?.content ?? response.response ?? "",
      model: response.model ?? request.model,
      provider: this.id,
      usage: {
        inputTokens: response.prompt_eval_count,
        outputTokens: response.eval_count
      },
      raw: response
    };
  }

  async embeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const baseUrl = request.baseUrl ?? "http://localhost:11434";
    const response = await postJson(`${baseUrl}/api/embed`, undefined, {
      model: request.model,
      input: request.input
    });
    const vectors = response.embeddings ?? [];
    return {
      vectors,
      model: response.model ?? request.model,
      provider: this.id,
      dimensions: vectors[0]?.length,
      usage: { embeddingTokens: response.prompt_eval_count },
      raw: response
    };
  }

  async models(): Promise<ModelCatalogEntry[]> {
    return [
      { id: "llama3.1", supportsStreaming: true },
      { id: "nomic-embed-text", supportsEmbeddings: true }
    ];
  }

  async healthCheck(config?: Record<string, unknown>): Promise<{ ok: boolean; message?: string }> {
    const baseUrl = String(config?.baseUrl ?? "http://localhost:11434");
    try {
      const response = await fetch(`${baseUrl}/api/tags`);
      return { ok: response.ok, message: response.ok ? undefined : `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
}

async function postJson(
  url: string,
  apiKey: string | undefined,
  body: unknown,
  timeoutMs = 60000,
  headers: Record<string, string> = {}
): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...headers
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Provider request failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}
