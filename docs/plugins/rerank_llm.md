# LLM Reranker

Asks an LLM to score each candidate document's relevance to the
question on a 0-10 scale, then sorts by score and keeps the top-K.
Slower than a cross-encoder but lets you tune via prompt and works
against any chat model.

## Inputs

- `question` (string, required).
- `documents` (`Array<{ id, text?, ...}>`, required) — candidates.

## Outputs

- `documents` — top-`config.topK` candidates reordered by `rerankScore`
  (the LLM's integer score) descending.

## Gotchas

- One prompt, one model call — all candidates are scored in a single
  request to keep latency reasonable. The prompt asks for a JSON
  array of integers in the SAME order as the input.
- On a malformed LLM response (non-JSON), every doc gets a neutral 5
  score and the input order is preserved.
- `config.textField` controls which doc field the LLM reads (defaults
  to `text`). Useful when your retrieval payload nests the content
  under another field.
- Document text is truncated to 800 chars before scoring — long docs
  blow the context window. Chunk before retrieval if you need finer
  granularity.

## Typical position

`dataset_search → rerank_llm → basic_rag_prompt → provider_chat`

For cross-encoder rerankers (more accurate, requires a HF model), use
`rerank_bge` instead.
