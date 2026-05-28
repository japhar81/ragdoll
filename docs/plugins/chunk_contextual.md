# chunk_contextual

Anthropic's Contextual Retrieval pattern: for each chunk, generate a
1–2 sentence situating blurb via the configured provider and prepend
it before embedding. Dramatically improves retrieval recall for chunks
that elide ambient document context ("as mentioned above…", "the same
applies to V2…"). Generic over document type.

## Inputs

- **`document`** *(required)* — the full document text, used as ambient
  context in every per-chunk prompt.
- **`chunks`** *(required)* — array of pre-chunked items. Each must
  carry a `text` field; any other fields pass through unchanged.

## Outputs

- **`chunks`** — same chunks augmented with two new fields:
  - `context`: the generated situating blurb.
  - `contextualText`: `<context><joiner><chunk text>` — the
    embedding-ready string.
- **`skipped`** — count of chunks for which contextualising returned
  empty or failed; those chunks are preserved with `context: ""` so
  downstream array shapes stay aligned.

## Gotchas

- **One LLM call per chunk.** Cost scales with chunk count; the
  `maxConcurrency` cap keeps a long document from melting the provider.
- **Template uses plain string substitution**, not a templating
  engine. An adversarial document containing literal `{{document}}`
  won't be re-substituted on a second pass.
- **Defaults to Ollama + `llama3.1`** for offline-friendly demos. For
  production ingest, override to a Haiku-class model (`provider:
  "anthropic"`, `model: "claude-3-5-haiku-latest"`) for noticeably
  sharper blurbs.

## Typical position

Between an upstream chunker (`basic_text_chunker` / `code_chunker`)
and an embedder, in an ingest pipeline.

```
loader → parser → basic_text_chunker → chunk_contextual → provider_embeddings → dataset_upsert
```
