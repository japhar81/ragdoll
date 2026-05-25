# Merge (RRF)

Pure Reciprocal Rank Fusion of N ranked lists. For each document its
score is `Σ 1 / (k + rank_in_list_i)` summed across the lists it
appears in. No I/O, no LLM, deterministic.

## Inputs

- `lists` (`Array<Array<{ id, score?, ...}>>`) — N ranked-doc arrays.
  Order within each list is the rank.

## Outputs

- `documents` — top-`config.topK` documents by fused score, each
  carrying its original payload plus the new `score` (the fused score,
  not any of the input scores).

## Gotchas

- `k` defaults to 60 (the classic RRF constant). Smaller k weights the
  top ranks more aggressively.
- Documents are de-duplicated by `id`. If a doc appears in multiple
  lists, its fused score is the sum.
- The plugin does NOT preserve the original per-list score columns —
  if you need them, splice them onto the doc payload upstream.

## Typical position

`(BM25 retriever) → ┐
                   ├── merge_rrf → rerank_llm → …
(vector retriever) ┘`
