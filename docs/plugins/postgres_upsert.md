# postgres_upsert

Bulk-inserts (and optionally updates on conflict) rows into an external
Postgres table. Identifiers (`table`, `columns`, `conflictTarget`,
`updateColumns`) come from `config` and are validated against the
Postgres identifier grammar before being double-quoted into the
generated SQL. Row values bind as parameters — never interpolated.

See [ADR 0020](../adr/0020-external-database-plugins.md) for the
architectural rules.

## Inputs

- **`rows`** *(required)* — Array of plain objects whose keys are the
  column names listed in `config.columns`. Missing keys bind `NULL`;
  extra keys are ignored.

## Outputs

- **`inserted`** — Count of newly-inserted rows (rows whose `xmax = 0`
  on RETURNING).
- **`updated`** — Count of rows that hit the `ON CONFLICT … DO UPDATE`
  branch.

## Gotchas

- **Identifiers must be valid Postgres unquoted identifiers** —
  `[A-Za-z_][A-Za-z0-9_$]{0,62}`, with an optional one-segment schema
  prefix. The validator REJECTS quoted identifiers (anything with `"`),
  which is the SQL-injection vector this plugin closes.
- **`updateColumns` requires a `conflictTarget`.** There is no UPDATE
  branch without one — the plugin will refuse to run.
- **`ON CONFLICT DO NOTHING` mode** — set `conflictTarget` and OMIT
  `updateColumns` for skip-on-conflict semantics. Skipped rows count
  toward neither `inserted` nor `updated`.
- **Batches commit together.** All rows are written inside a single
  transaction in batches of `batchSize` (default 500). A failure
  partway through rolls back the whole call.
- **Zero rows is a no-op.** No transaction is opened, no driver call is
  made.

## Typical position

Late in an ingest pipeline, after `chunk_*` or extraction nodes have
shaped per-record rows for the target table.

```
documents → email_preprocess → extract_entities → postgres_upsert
```

## Why this is a `sink` (not a `tool`)

`sink` is the existing category for "write-the-side-effect" nodes
(`opensearch_output`, `qdrant_vector_store`, `dataset_upsert`). The
Builder palette groups it accordingly and the validator's
"every-terminal-node-is-a-sink" lint passes.
