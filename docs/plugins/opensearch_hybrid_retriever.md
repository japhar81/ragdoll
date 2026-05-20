# OpenSearch Hybrid Retriever

Runs BM25 lexical and kNN vector search in parallel against the same
index, then fuses the two ranked lists. Often the best single retrieval
node for natural-language queries — keyword precision plus semantic
recall.

## Inputs

- `queryVector: number[]` (preferred) — used for the vector arm.
- otherwise the question (top-level or `input.question` / `text`) is
  embedded for the vector arm.

## Outputs

- `documents` — `Array<{ id, score, ...source }>` ordered by fused score
  descending. The raw `vector` field is stripped from each document so
  it doesn't bloat downstream payloads.

## Gotchas

- The index must contain both the configured text fields AND a `vector`
  knn_vector field. Build it with OpenSearch Output's
  `createKnnIndex: true`.
- `mode: "rrf"` (default) is the Reciprocal Rank Fusion variant — robust
  because it ignores raw score scales. `mode: "weighted"` does a
  min-max blend; tune `alpha` between 0 (all lexical) and 1 (all
  vector).
- `candidateK` controls how many candidates each arm pulls *before*
  fusion. Defaults to `max(topK*4, 20)`. Bump it when the two arms
  rarely overlap on the final top-K.

## Typical position

Source → (OpenSearch Hybrid Retriever) → Reranker / Prompt template
