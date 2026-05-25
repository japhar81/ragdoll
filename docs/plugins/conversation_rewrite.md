# Conversation Rewrite

Resolves anaphora ("it", "they", "that one") and implicit references in
a follow-up turn against the conversation history, producing a
standalone question that downstream retrieval pipelines can act on
without context. Passes the question through unchanged when the
follow-up already stands on its own.

## Inputs

- `question` (string, required) — the latest user turn.
- `history` (`Array<{role, content}>`) — prior messages, oldest first.

## Outputs

- `question` (string) — the rewritten standalone question (or the
  original verbatim when no history is supplied / rewrite is needed).

## Gotchas

- LLM-driven, same cost / latency tradeoffs as `query_hyde` /
  `rerank_llm`. Local Ollama is free.
- `config.historyWindow` (default 6) caps how many prior turns enter
  the rewrite prompt. Long histories blow context windows; recent turns
  carry most of the anaphoric weight.
- When the LLM returns an empty string (unusual), the original question
  is returned — safer than passing "" to a retriever.

## Typical position

`input(question + history) → conversation_rewrite → query_hyde → dataset_search → …`
