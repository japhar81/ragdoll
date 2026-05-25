# HyDE Query Expansion

Generates a hypothetical answer to the user's question via an LLM. The
hypothetical text is then embedded by a downstream retriever, which
often surfaces semantically closer chunks than embedding the bare
question would — questions and answers have different vector
neighborhoods.

## Inputs

- `question` (string, required).

## Outputs

- `hypothetical` (string) — the generated answer.
- `question` (string) — original, passed through for downstream nodes
  that want both.

## Gotchas

- The LLM call costs tokens. Local Ollama (`config.provider: "ollama"`)
  keeps it free; OpenAI / Anthropic add latency + spend per request.
- Override the prompt via `config.promptTemplate`. `{{question}}` is
  interpolated. Keep responses short — a paragraph is plenty.
- HyDE pairs with `dataset_search`: feed `hypothetical` into the
  retriever's `question` port. Some pipelines do both arms (HyDE +
  raw question) and merge with `merge_rrf`.

## Typical position

`question → query_hyde → dataset_search → …`
