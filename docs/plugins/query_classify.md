# query_classify

Maps a free-form user question to structured arguments matching a
config-supplied schema (typically the bind-param shape for a
`postgres_query`). Emits a model-reported confidence score and a
`lowConfidence` flag the pipeline can branch on to fall back to a
vector-search path.

Designed for synchronous pipelines: one short bounded LLM call,
default model is the cheapest available.

## Inputs

- **`question`** *(required)* — free-text user question.

## Outputs

- **`args`** — structured args matching `config.targetSchema`.
- **`confidence`** — model-reported confidence in `[0, 1]`.
- **`lowConfidence`** — `true` when `confidence < confidenceThreshold`.
- **`raw`** — raw model response text, useful for prompt debugging.

## Gotchas

- **The schema is wrapped.** The model sees a `{ args, confidence }`
  envelope around your `targetSchema`. Your schema is the inner
  `args` shape only — don't pre-wrap it.
- **`temperature` is fixed at 0.1.** Classification benefits from
  determinism; expose this in config only if you have a strong reason.
- **Branch on `lowConfidence` via `if_then`.** Wire the `true` branch
  to your fallback retrieval; the `false` branch carries the args to
  `postgres_query` (or wherever).

## Typical position

The first LLM node in a sync retrieval pipeline.

```
question → query_classify ─if_then(lowConfidence)→
   true →  dataset_search → rerank → prompt → provider_chat
   false → postgres_query(args) → summarize_event → provider_chat
```
