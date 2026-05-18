# Provider Development

Providers implement `ProviderAdapter` from `packages/providers/src/index.ts`.
OpenAI, Anthropic, and an Ollama-compatible adapter ship built in;
`packages/plugin-loader` registers all three in a `ProviderRegistry` keyed by
adapter `id`.

## ProviderAdapter shape

- `id` — stable identifier (`"openai" | "anthropic" | "ollama" | string`).
- `displayName` — human label surfaced by `GET /api/providers`.
- `chat(request)` — LLM chat completion.
- `embeddings(request)` — optional; implement when embeddings are supported.
- `models()` — model catalog metadata (context window, streaming, tools,
  embeddings support).
- `healthCheck(config?)` — readiness and operator diagnostics.

Register an adapter with `registry.register(adapter)`; `registry.require(id)`
resolves it (used by the `/api/providers/:id/models` route and the
`provider_chat` / `provider_embeddings` plugins).

## Tenant credentials

Adapters receive tenant credentials from the runtime after secret resolution.
They must not read global process environment credentials directly unless a
provider policy explicitly allows fallback keys for the environment.

## Adding an OpenAI-compatible provider

Use the Ollama-compatible adapter only for APIs that implement Ollama
semantics. For OpenAI-compatible SaaS/local APIs, add a separate adapter with
configurable `baseUrl`, model catalog, auth header strategy, streaming
semantics, and usage parsing.

## Accounting

Return provider/model and token counts whenever the provider exposes them. The
runtime turns a plugin's `usage` into a `UsageRecord`; cost calculation lives
outside the adapter using `provider_models` price metadata.
