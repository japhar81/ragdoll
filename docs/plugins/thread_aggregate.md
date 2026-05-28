# thread_aggregate

Groups a flat list of message records by a configurable thread key,
orders them by a configurable timestamp, and emits **per-thread**
documents alongside the re-tagged per-message records. Use when you
want a retriever to return whole conversations rather than single
noisy replies.

## Inputs

- **`rows`** *(required)* — flat array of message records. Falls back
  to `inputs.messages` / `inputs.documents` for upstream compatibility.

## Outputs

- **`threads`** — per-thread documents:
  `{ threadKey, messageCount, firstAt, lastAt, participants, text, messages }`.
  Deterministically sorted by `threadKey` so downstream embedders /
  upserters produce stable diffs.
- **`messages`** — the input messages re-tagged with `threadKey` and
  `orderInThread`. Useful when a pipeline also wants per-message
  retrieval alongside per-thread.

## Gotchas

- **`threadKeyField` and `orderByField` are required.** No default —
  message schemas vary too much across providers to hardcode.
- **Mixed timestamp formats** — ISO strings, numbers (epoch seconds
  or ms), and Date instances all work; falls back to string compare
  when neither is numeric.
- **Disable a port you don't need.** `emitThreads: false` or
  `emitMessages: false` marks the corresponding port dead and skips
  any downstream node wired only to it.

## Typical position

After `email_preprocess` (or any per-message extraction step), feeding
two parallel branches — one for thread-level embedding, one for
per-message ops.

```
email_preprocess → thread_aggregate ─┬─ provider_embeddings(threads) → dataset_upsert(thread-vectors)
                                     └─ extract_entities(messages) → postgres_upsert
```
