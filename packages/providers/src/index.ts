import type { SecretRef } from "../../core/src/index.ts";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * Custom undici dispatcher for local LLM providers (Ollama-style). The
 * default Node fetch has a 60s `headersTimeout`; CPU embed/chat models
 * routinely take several minutes to respond to a large batch, so the
 * default trips with `UND_ERR_HEADERS_TIMEOUT` and surfaces as a
 * cryptic `fetch failed` long before the AbortController-driven
 * timeout kicks in. A purpose-built Agent with five-minute waits on
 * both headers and body keeps the connection alive for the duration
 * of a real workload.
 */
const localLlmDispatcher = new Agent({
  headersTimeout: 300_000,
  bodyTimeout: 300_000,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 600_000
});

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
  /** Per-request HTTP timeout (ms). Defaults vary by provider. */
  timeoutMs?: number;
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
    const baseUrl =
      request.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
    const response = await postJson(
      `${baseUrl}/api/chat`,
      undefined,
      {
        model: request.model,
        messages: request.messages,
        stream: false,
        options: {
          temperature: request.temperature,
          top_p: request.topP,
          num_predict: request.maxTokens
        }
      },
      request.timeoutMs ?? 300_000,
      {},
      { useLocalLlmDispatcher: true }
    );
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
    const baseUrl =
      request.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
    // Two practical constraints when talking to a CPU-only local
    // Ollama for embeddings:
    //
    // (1) Per-input length. nomic-embed-text has a 2048-token context;
    //     a single code chunk that exceeds it fails the WHOLE batch
    //     with "input length exceeds context length". We truncate at
    //     4000 chars (~1000 tokens for normal text, still safe for
    //     dense code where one char ≈ one token). The fallback below
    //     handles the rare case where 4000 chars STILL exceeds the
    //     model's context.
    //
    // (2) Per-batch latency. A single /api/embed with hundreds of
    //     inputs on CPU can run for minutes and trip both undici's
    //     headersTimeout and the per-attempt timeout below. We split
    //     the input into batches of 64 so each call stays under a
    //     minute on a typical CPU and the overall job streams through
    //     instead of stalling on one huge request.
    const MAX_TEXT_CHARS = 4000;
    const BATCH_SIZE = 64;
    const truncated = request.input.map((text) =>
      text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text
    );
    const vectors: number[][] = [];
    let totalTokens = 0;
    let lastModel: string | undefined;
    const embedBatch = async (slice: string[]): Promise<{ embeddings?: number[][]; prompt_eval_count?: number; model?: string }> =>
      postJson(
        `${baseUrl}/api/embed`,
        undefined,
        { model: request.model, input: slice },
        request.timeoutMs ?? 300_000,
        {},
        { useLocalLlmDispatcher: true }
      );
    /** If a batch fails with the context-length error (a single bad
     *  input poisons the whole call), fall back to one-text-at-a-time
     *  and emit a zero vector for any single text that still won't
     *  embed. Zero vectors are correctly-shaped and let the run finish;
     *  the alternative — dropping rows — would silently desync chunk
     *  arrays from vector arrays downstream. */
    const isContextLengthError = (e: unknown): boolean =>
      e instanceof Error && /input length exceeds the context length/i.test(e.message);
    for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
      const slice = truncated.slice(i, i + BATCH_SIZE);
      let batch: Awaited<ReturnType<typeof embedBatch>>;
      try {
        batch = await embedBatch(slice);
      } catch (err) {
        if (!isContextLengthError(err)) throw err;
        const singles: number[][] = [];
        let dim = 0;
        for (const text of slice) {
          try {
            const r = await embedBatch([text]);
            const v = r.embeddings?.[0];
            if (v) {
              singles.push(v);
              dim = v.length;
            } else {
              singles.push(new Array(dim).fill(0));
            }
            totalTokens += r.prompt_eval_count ?? 0;
            lastModel = r.model ?? lastModel;
          } catch (innerErr) {
            if (!isContextLengthError(innerErr)) throw innerErr;
            // Even after 4000-char truncation this single chunk is
            // still too long. Keep going; sink zeros so the indices
            // line up with the upstream chunk array.
            singles.push(new Array(dim).fill(0));
          }
        }
        batch = { embeddings: singles };
      }
      const batchVectors = batch.embeddings ?? [];
      vectors.push(...batchVectors);
      totalTokens += batch.prompt_eval_count ?? 0;
      lastModel = batch.model ?? lastModel;
    }
    return {
      vectors,
      model: lastModel ?? request.model,
      provider: this.id,
      dimensions: vectors[0]?.length,
      usage: { embeddingTokens: totalTokens || undefined }
    };
  }

  async models(): Promise<ModelCatalogEntry[]> {
    return [
      { id: "llama3.1", supportsStreaming: true },
      { id: "nomic-embed-text", supportsEmbeddings: true }
    ];
  }

  async healthCheck(config?: Record<string, unknown>): Promise<{ ok: boolean; message?: string }> {
    const baseUrl = String(
      config?.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434"
    );
    try {
      const response = await fetch(`${baseUrl}/api/tags`);
      return { ok: response.ok, message: response.ok ? undefined : `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
}

/**
 * Errors that look like a dropped TCP connection or a server that
 * isn't quite ready to serve. We retry these because Ollama's behaviour
 * during a cold model load is exactly this: it accepts the TCP
 * connection, holds it while the weights load from disk, and sometimes
 * resets the socket if the load is slow. Code-level errors (HTTP 4xx)
 * are NOT in this list — we never retry a "bad request".
 */
function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("socket hang up") ||
    message.includes("network") ||
    error.name === "AbortError"
  );
}

async function postJson(
  url: string,
  apiKey: string | undefined,
  body: unknown,
  timeoutMs = 60000,
  headers: Record<string, string> = {},
  options: { useLocalLlmDispatcher?: boolean } = {}
): Promise<any> {
  // Up to 4 attempts with exponential backoff (250ms, 500ms, 1s).
  // Covers cold-model-load on local Ollama where the first /api/embed
  // or /api/chat after a stack restart races the model load and gets
  // a fetch-failed before the model is in RAM.
  const maxAttempts = 4;
  const fetchImpl = options.useLocalLlmDispatcher
    ? (input: string, init?: RequestInit) =>
        undiciFetch(input, { ...init, dispatcher: localLlmDispatcher } as never)
    : fetch;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
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
      if (!response.ok) {
        throw new Error(
          `Provider request failed with HTTP ${response.status}: ${JSON.stringify(payload)}`
        );
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts - 1) break;
      if (!isTransientFetchError(error)) break;
      await new Promise((resolve) =>
        setTimeout(resolve, 250 * Math.pow(2, attempt))
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}
