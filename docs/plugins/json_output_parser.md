# JSON Output Parser

Attempts to parse the upstream LLM's text output as JSON. Useful when you've
prompted the model to "respond with JSON" and want the downstream nodes to
work with a real object instead of a string.

## Inputs

- `llm.text` (the chat node's output nested by node id) or top-level
  `inputs.text`.

## Outputs

- `json` — the parsed value, or `null` if parsing failed.
- `raw` (string) — the original text, unmodified, so callers can inspect or
  retry.
- `parseError` (boolean) — present and `true` only on parse failure.

## Gotchas

- A parse failure is **not** an error condition on this node — the
  execution continues. Read `parseError` downstream if you want to branch
  on it.
- LLMs love to wrap JSON in markdown code fences. This parser is strict
  `JSON.parse`; it will fail on ```` ```json ... ``` ```` blocks. Strip
  fences in the prompt or in a transformer node first.

## Typical position

Provider Chat → (JSON Output Parser) → router / typed downstream consumer
