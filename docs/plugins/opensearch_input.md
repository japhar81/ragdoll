# OpenSearch Input

Reads documents out of an OpenSearch index — optionally filtered by a
Lucene `query_string` and/or the execution's tenant id — and emits them in
the standard `{ documents }` shape so the rest of the pipeline doesn't
care where they came from.

## Inputs

Ignored — this is a source.

## Outputs

- `documents` — `Array<{ id, text, metadata }>` where `text` comes from
  the configured `textField` and `metadata` is the rest of the source
  document.
- `pageCount` (number) — number of documents in this batch.
- `total` (number) — total hits reported by OpenSearch (may exceed
  `pageCount` when `size` clips the read).

## Gotchas

- When `query` is empty, the read uses `match_all`. That can be a lot of
  data; tune `size`.
- Tenant isolation is opt-in here: only set when `tenantField` is
  configured. Leave it empty for shared/system indices.
- Endpoint resolution: explicit `endpoint` config → resolved-config
  `opensearch.url` → `OPENSEARCH_URL` env. First non-empty wins.

## Typical position

(OpenSearch Input) → Chunker → Embedder → Vector store / OpenSearch
Output
