/**
 * Provider-adapter helpers shared across multiple plugin modules. Pulled
 * out of index.ts so the OpenSearch / Qdrant / retrieval-v2 modules can
 * import them without duplicating the registry-building boilerplate.
 */

import {
  OpenAIProvider,
  AnthropicProvider,
  OllamaCompatibleProvider,
  ProviderRegistry,
  type ChatMessage
} from "../../../packages/providers/src/index.ts";

export function buildProviderRegistry(): ProviderRegistry {
  const providers = new ProviderRegistry();
  providers.register(new OpenAIProvider());
  providers.register(new AnthropicProvider());
  providers.register(new OllamaCompatibleProvider());
  return providers;
}

/**
 * Resolve `(provider, model)` from the same `config + resolvedValues`
 * shape every chat-calling plugin uses. Defaults match the platform's
 * cheap-by-default posture: Ollama as provider, llama3.1 as model.
 * Plugins that want a stronger default (e.g. compose_with_style)
 * override via their own runtime defaults.
 */
export function resolveChatModel(args: {
  config: Record<string, unknown>;
  resolvedValues: Record<string, { value: unknown } | undefined>;
  defaultProvider?: string;
  defaultModel?: string;
}): { providerId: string; model: string; baseUrl?: string } {
  const providerId = String(
    args.config.provider ??
      args.resolvedValues["chat.provider"]?.value ??
      args.defaultProvider ??
      "ollama"
  );
  const model = String(
    args.config.model ??
      args.resolvedValues["chat.model"]?.value ??
      args.defaultModel ??
      "llama3.1"
  );
  const baseUrl = args.config.baseUrl ? String(args.config.baseUrl) : undefined;
  return { providerId, model, baseUrl };
}

/**
 * Call a chat provider with a system+user prompt and parse the response
 * as JSON conforming to `schema`. Extraction is permissive:
 *  1. Try to JSON.parse the raw text.
 *  2. If that fails, look for a fenced code block (```json … ```).
 *  3. If that fails, find the first balanced `{…}` or `[…]`.
 *
 * `retry` defaults to 1 — one re-ask with a "Your previous output was
 * not valid JSON …" reminder. Two retries pushes latency over the
 * synchronous-pipeline budget; one is the sweet spot.
 *
 * The shape of `parsed` is not type-checked against the schema here —
 * the caller knows what they asked for. JSON-validation against the
 * supplied schema is a separate concern handled by `schema-validate.ts`
 * if the plugin wants it.
 */
export async function chatStructured(args: {
  providers: ProviderRegistry;
  tenantId: string;
  providerId: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  systemPrompt: string;
  userPrompt: string;
  schema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  retry?: number;
}): Promise<{ parsed: unknown; raw: string; provider: string; model: string }> {
  const provider = args.providers.require(args.providerId);
  // Including the schema in the system prompt — even when the provider
  // doesn't natively support a JSON-schema mode — measurably improves
  // structural conformance on small open models. Models that DO support
  // strict JSON modes (OpenAI tools/json_schema) get richer guidance
  // upstream; this is the baseline that works across every provider.
  const schemaHint = args.schema
    ? `\n\nRespond with a single JSON value matching this schema:\n${JSON.stringify(args.schema, null, 2)}\n\nReturn ONLY the JSON — no prose, no markdown fences.`
    : "\n\nRespond with a single JSON value. Return ONLY the JSON — no prose, no markdown fences.";
  const baseMessages: ChatMessage[] = [
    { role: "system", content: args.systemPrompt + schemaHint },
    { role: "user", content: args.userPrompt }
  ];
  const maxAttempts = Math.max(1, (args.retry ?? 1) + 1);
  let lastRaw = "";
  let lastErr: unknown;
  let messages = baseMessages;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await provider.chat({
      tenantId: args.tenantId,
      model: args.model,
      messages,
      temperature: args.temperature ?? 0.1,
      maxTokens: args.maxTokens ?? 1024,
      apiKey: args.apiKey,
      baseUrl: args.baseUrl
    });
    lastRaw = response.text ?? "";
    try {
      const parsed = parseJsonFromModelOutput(lastRaw);
      return { parsed, raw: lastRaw, provider: response.provider, model: response.model };
    } catch (err) {
      lastErr = err;
      // Re-ask with the model's previous output included so it can self-correct.
      messages = [
        ...baseMessages,
        { role: "assistant", content: lastRaw },
        {
          role: "user",
          content:
            "Your previous output was not valid JSON. Reply with ONLY the JSON value — no prose, no markdown fences."
        }
      ];
    }
  }
  throw new Error(
    `chatStructured failed to obtain valid JSON after ${maxAttempts} attempt(s): ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }. Raw: ${lastRaw.slice(0, 200)}`
  );
}

/** Best-effort JSON extraction from a model's text response. */
export function parseJsonFromModelOutput(raw: string): unknown {
  const trimmed = raw.trim();
  // 1. Direct parse.
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  // 2. Fenced code block.
  const fence = /```(?:json)?\s*([\s\S]+?)```/i.exec(trimmed);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      /* fall through */
    }
  }
  // 3. First balanced object/array.
  const startObj = trimmed.indexOf("{");
  const startArr = trimmed.indexOf("[");
  const candidates: number[] = [];
  if (startObj >= 0) candidates.push(startObj);
  if (startArr >= 0) candidates.push(startArr);
  const start = candidates.length ? Math.min(...candidates) : -1;
  if (start >= 0) {
    const open = trimmed[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (inString) {
        if (escape) escape = false;
        else if (c === "\\") escape = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === open) depth += 1;
      else if (c === close) {
        depth -= 1;
        if (depth === 0) {
          const slice = trimmed.slice(start, i + 1);
          return JSON.parse(slice);
        }
      }
    }
  }
  throw new Error("could not extract JSON from model output");
}

export async function embedTexts(args: {
  texts: string[];
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  tenantId: string;
  resolvedValues: Record<string, { value: unknown } | undefined>;
}): Promise<{
  vectors: number[][];
  dimensions: number;
  provider: string;
  model: string;
  embeddingTokens?: number;
}> {
  const providers = buildProviderRegistry();
  const providerId = String(
    args.config.provider ??
      args.resolvedValues["embeddings.provider"]?.value ??
      "ollama"
  );
  const provider = providers.require(providerId);
  if (!provider.embeddings) {
    throw new Error(`Provider ${providerId} does not support embeddings`);
  }
  const response = await provider.embeddings({
    tenantId: args.tenantId,
    model: String(
      args.config.model ??
        args.resolvedValues["embeddings.model"]?.value ??
        "nomic-embed-text"
    ),
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
