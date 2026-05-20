# Provider Chat

Calls a chat completion provider — OpenAI, Anthropic, or any
Ollama-compatible endpoint — and returns the generated text plus usage
metadata so the platform can track tokens and cost.

## Inputs

- `prompt.messages` or top-level `messages` — `[{ role, content }, ...]` as
  produced by a prompt template.

## Outputs

- `text` (string) — the assistant's reply.
- `provider` (string) — the resolved provider id.
- `model` (string) — the model that actually answered (after the resolved-
  config lookup).

Also emits standard usage telemetry — `provider`, `model`, `inputTokens`,
`outputTokens`, `estimatedCostUsd` — onto the execution's metadata.

## Gotchas

- Hosted providers (OpenAI, Anthropic) require the `apiKey` secret. Ollama
  works without one for local models.
- Config falls back to resolved config values (`llm.provider`, `llm.model`,
  `llm.temperature`, `llm.max_tokens`) so a tenant-wide policy can set
  defaults — leave the node fields empty to inherit.
- `baseUrl` overrides the provider's default endpoint. Use it for
  self-hosted Ollama or an OpenAI-compatible proxy.

## Typical position

Prompt template → (Provider Chat) → JSON Output Parser / final answer node
