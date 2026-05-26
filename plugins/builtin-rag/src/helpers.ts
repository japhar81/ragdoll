/**
 * Provider-adapter helpers shared across multiple plugin modules. Pulled
 * out of index.ts so the OpenSearch / Qdrant / retrieval-v2 modules can
 * import them without duplicating the registry-building boilerplate.
 */

import {
  OpenAIProvider,
  AnthropicProvider,
  OllamaCompatibleProvider,
  ProviderRegistry
} from "../../../packages/providers/src/index.ts";

export function buildProviderRegistry(): ProviderRegistry {
  const providers = new ProviderRegistry();
  providers.register(new OpenAIProvider());
  providers.register(new AnthropicProvider());
  providers.register(new OllamaCompatibleProvider());
  return providers;
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
