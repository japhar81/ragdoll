# Basic RAG Prompt

Builds the chat-style prompt that gets handed to the LLM, substituting the
question and retrieved context into a template. Outputs a `messages` array
in the standard `{ role, content }` chat-completion shape — what every
modern provider expects.

## Inputs

- `question` (string) — top-level on the runtime input, or nested under
  `input.question` (the legacy compatibility path the manual input node
  takes).
- `documents` (array) — the retriever's results. Read from either
  `inputs.retrieve.documents` (the upstream retriever node's outputs nested
  by node id) or top-level `inputs.documents`.

## Outputs

- `messages` — `[{ role: "system" | "user", content: string }]`. The system
  message is a fixed "careful RAG assistant" preamble; the user message is
  the configured `template` with `{{context}}` and `{{question}}` replaced.

## Gotchas

- `{{context}}` is filled with `JSON.stringify(documents)`, so the
  retriever's full payload (score, metadata, text) ends up in the prompt
  verbatim. If you want a cleaner context section, project documents
  through a custom transformer first.
- Only two placeholders are recognized; anything else in the template is
  left literal.

## Typical position

Retriever → (Basic RAG Prompt) → Provider Chat → Output Parser
