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
- `degraded.vector` (optional) — when present, the kNN arm returned a
  400 indicating the vector field is missing from the index, so the
  retriever fell back to BM25-only. The string is the OpenSearch error
  reason. Execution metadata mirrors this as `vectorArmSkipped: true`
  + `vectorArmReason`.

## Gotchas

- The index must contain both the configured text fields AND a `vector`
  knn_vector field. Build it with OpenSearch Output's
  `createKnnIndex: true`.
- **BM25-only fallback.** When the kNN arm returns a 400 whose body
  matches the "missing vector field / not knn_vector" shapes (e.g. the
  vector ingest never ran on this index), the retriever logs the
  reason, returns BM25 results alone, and surfaces a `degraded.vector`
  marker so downstream prompts can warn the user. Unrelated 400s
  (genuine query bugs) still throw — the degradation path is shape-
  matched, not blanket-applied.
- `mode: "rrf"` (default) is the Reciprocal Rank Fusion variant — robust
  because it ignores raw score scales. `mode: "weighted"` does a
  min-max blend; tune `alpha` between 0 (all lexical) and 1 (all
  vector).
- `candidateK` controls how many candidates each arm pulls *before*
  fusion. Defaults to `max(topK*4, 20)`. Bump it when the two arms
  rarely overlap on the final top-K.

## Typical position

Source → (OpenSearch Hybrid Retriever) → Reranker / Prompt template
