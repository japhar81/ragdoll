# Basic Text Chunker

Splits a single string into overlapping fixed-size chunks. Cheap and
deterministic — no model calls, no tokenizer dependency. Good first pass for
ingestion when you want predictable shard boundaries.

## Inputs

- `text` (string) or `input` (string) — the document to chunk. The plugin
  reads whichever is present, with `text` winning.

## Outputs

- `chunks` — `Array<{ text: string; index: number }>`, in order. `index` is
  the chunk's zero-based position in the original document.

## Gotchas

- Boundaries are character-based, not token- or sentence-based. For very
  small overlap values you can land mid-sentence; tune `chunkSize` and
  `overlap` together until your retriever returns coherent matches.
- `chunkSize - overlap` must be positive; the implementation clamps the
  step to ≥ 1 to avoid an infinite loop, but a near-zero step is still
  pointless and will produce O(N) chunks.

## Typical position

Loader → (Basic Text Chunker) → Embedder → Vector Store / OpenSearch Output
