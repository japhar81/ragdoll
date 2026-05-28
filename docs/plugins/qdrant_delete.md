# Qdrant Delete

Deletes points by id from a Qdrant collection. Pairs with the `deleted`
output of [`delta_filter`](delta_filter.md) to keep the vector store in
sync as source files come and go.

## Inputs

- `deleted` (required) — array of `{ docId }` entries. Documents missing a
  `docId` are silently dropped.

## Outputs

- `deletedCount` — number of point ids submitted to the store.

## Config

- `url` — Qdrant URL. Falls back to the in-memory store (useful for tests
  and small dev runs).
- `collection` (default `default`) — target collection. Resolves from
  `vector.collection` config when unset.
- `idPrefix` — optional prefix combined with each input `docId` to compute
  the actual point id. **Must match the upsert side** — if `vector_upsert`
  was configured with `idPrefix: "code:"`, mirror that here.

## Secrets

- `apiKey` — Qdrant API key (passed to the client).

## Typical position

```
delta_filter
  └── deleted → qdrant_delete
```

## Gotchas

- Empty input is a no-op (`deletedCount: 0`); the plugin won't fail even
  when the upstream port is unwired.
- Deletion is by id only — there's no "delete by docId via metadata" path.
  If your upsert plugin hashed the docId into a different point id, mirror
  that here via `idPrefix` or by configuring the same hash on both sides.
- **Error detail.** The Qdrant JS client throws bare `Error: Bad
  Request` (or similar status text) without including the response body
  or the operation context. This plugin enriches the error with
  `qdrant delete on "<collection>" (HTTP <status>): <baseMsg> ids[N]=…
  — server: <body preview>` before it reaches the execution trace so
  the operator can actually diagnose the failure. The original error is
  preserved as `cause`.
