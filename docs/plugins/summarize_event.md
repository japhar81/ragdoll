# summarize_event

Given structured rows + their source documents, produces a formatted
structured summary (e.g. cause / timeline / resolution) via one
provider call. Generic over the summary schema — the operator supplies
the shape they want via `config.summarySchema`.

## Inputs

- **`rows`** *(required)* — structured fact rows (typically from a
  `postgres_query`).
- **`documents`** *(optional)* — supporting documents included in the
  prompt as ambient context.

## Outputs

- **`summaries`** — when `groupByField` is unset, an array with ONE
  summary covering all rows. When `groupByField` is set, one summary
  per group, each tagged with `groupKey`.

## Gotchas

- **`maxConcurrency` defaults to 2.** Summary generations are slow
  and heavy; running too many in parallel just thrashes the provider.
- **Prompt template uses plain substitution.** Two placeholders:
  `{{rows}}` and `{{documents}}`. Both are stringified as JSON before
  insertion.
- **Use for read-side summarisation, not as part of ingest.** Writing
  a generated summary into a system of record blurs the line between
  derived data and source — keep summaries in retrieval pipelines and
  reference the underlying rows from them.

## Typical position

After a `postgres_query` retrieves the facts, before the prompt /
provider_chat that renders them for the user.

```
question → query_classify → postgres_query → summarize_event → basic_rag_prompt → provider_chat
```
