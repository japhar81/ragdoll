# Score Reranker

Reorders the retriever's documents by an existing numeric `score`
(descending), falling back to lexical-overlap with the question for
documents that lack a score. Truncates to `topK`. No model calls — pure
re-sort.

## Inputs

- `documents` (`Array<{ text?, score?, ... }>`) — retriever output.
- `question` (top-level or `input.question`) — only used when documents
  have no `score`, to compute overlap.

## Outputs

- `documents` — the reordered, truncated array. Original fields are
  preserved per document.

## Gotchas

- "Lexical overlap" is a unique-token-intersection count. It's cheap, not
  smart — for serious re-ranking, drop in a cross-encoder plugin instead.
- Tie-breaks fall back to original order, so reranking is stable.
- `topK` of 0 produces an empty array; values larger than the input simply
  return everything.

## Typical position

Retriever → (Score Reranker) → Prompt template
