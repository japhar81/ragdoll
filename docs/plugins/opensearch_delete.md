# OpenSearch Delete

Bulk delete-by-id against an OpenSearch index, executed as a single
`_delete_by_query` with a `terms` filter on `_id`. Pairs with the
`deleted` output of [`delta_filter`](delta_filter.md).

## Inputs

- `deleted` (required) — array of `{ docId }` entries.

## Outputs

- `deletedCount` — number of ids submitted (not necessarily the number
  matched server-side; OpenSearch's response counts the actual deletes).

## Config

- `endpoint` — OpenSearch base URL. Falls back to `opensearch.url` config /
  `OPENSEARCH_URL` env.
- `index` (default `default`) — target index.
- `idPrefix` — optional prefix combined with each input `docId` to compute
  the document `_id`. Must match what the upsert side wrote.

## Secrets

- `username` / `password` — basic auth (omit for security-disabled
  clusters).
- `authorization` — raw `Authorization` header (e.g. an API key). Overrides
  basic auth when set.

## Typical position

```
delta_filter
  └── deleted → opensearch_delete
```

## Gotchas

- The plugin uses `_delete_by_query` with a `terms` filter on `_id`. For
  very large delete batches (10k+ ids per run), batch the deletes upstream
  or set OpenSearch's `cluster.routing.allocation.disk.watermark` headroom
  appropriately — `_delete_by_query` is more expensive than a literal bulk
  delete on extremely large id sets.
- Tenant isolation is enforced by the configured index (one index per
  tenant, or a tenant filter baked into the upstream upsert side). This
  plugin does **not** add a tenant clause — if your index is multi-tenant,
  pair this with a separate guardrail.
