# action_status_refresh

For each candidate action item, looks at the surrounding thread (the
pipeline author retrieves this upstream and wires it onto each record)
and asks the model whether a later message resolved, cancelled, or
blocked the item. Bounded concurrency so a flurry of items doesn't
melt the provider on the hot path.

## Inputs

- **`records`** *(required)* — candidate action-item records. Each
  must carry the configured `itemField` (default `item`) and
  `threadField` (default `thread`).

## Outputs

- **`records`** — same records with the configured `statusField`
  populated (`"open"` / `"resolved"` / `"cancelled"` / `"blocked"`)
  and `statusEvidence` carrying a short quote / paraphrase.
- **`updated`** — count of records whose status changed.

## Gotchas

- **Parse failures preserve the original record.** A model that
  refuses or returns garbage leaves the row unchanged so downstream
  can retry; the `updated` count won't include it.
- **`maxConcurrency` defaults to 4.** Higher trips rate limits on
  most providers; lower (1) is fine for tiny check-ins.
- **Thread retrieval happens upstream.** This plugin is intentionally
  not coupled to any specific data source — the operator wires a
  `postgres_query` (or a vector retriever) to populate
  `record.thread` before this node runs.

## Typical position

In a periodic "refresh open items" sync pipeline, or as the read-side
of a chat answer that wants to confirm the latest status before
answering "what's still open".

```
postgres_query(open_items) → (lookup_thread) → action_status_refresh → postgres_upsert(items_table)
```
