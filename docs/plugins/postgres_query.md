# postgres_query

Runs a parameterised SELECT against an external Postgres database that the
operator has registered as a secret. The SQL is fixed in `config.sql`;
runtime values from upstream nodes flow only through `inputs.params` as
bound parameters, so the statement is injection-proof by construction.

The node opens a `BEGIN READ ONLY` transaction before executing — any
write keyword that slipped past the pre-flight check is rejected by
Postgres itself.

See [ADR 0020](../adr/0020-external-database-plugins.md) for the
architectural rules this plugin family enforces (SQL-as-config,
params-as-data, connections-as-secrets, shared pooled connections).

## Inputs

- **`params`** *(optional)* — Array of bind values matching the
  `$1, $2, …` placeholders in `config.sql`. Omit to run a no-parameter
  statement.

## Outputs

- **`rows`** — Array of result rows as plain objects.
- **`rowCount`** — Number of rows returned, after `maxRows` truncation.
- **`truncated`** — `true` when more rows were available than `maxRows`
  allowed.

## Gotchas

- **Read-only.** This plugin will reject `INSERT`, `UPDATE`, `DELETE`,
  DDL, and transaction-control statements pre-flight, and the READ ONLY
  transaction would reject them anyway. Use `postgres_upsert` to write
  rows or `postgres_exec` for one-shot DDL.
- **`maxRows` is a hard cap, not a query LIMIT.** It truncates the
  fetched result set in the plugin. Pages bigger than `maxRows` are
  silently dropped; the `truncated` output is your signal to raise the
  cap or add a `LIMIT` clause.
- **Pool sharing.** Two nodes that resolve to the same DSN share a
  single `pg.Pool` for the lifetime of the host process. Pool identity
  is keyed by the resolved DSN, not the `connection` label, so
  identical labels pointing at different DSNs across environments stay
  isolated.
- **`readOnly: false` is reserved.** The field is in the schema for
  forward-compatibility but currently throws — use `postgres_exec` for
  writes.

## Typical position

Mid-pipeline retrieval: an upstream node (often `query_classify` or a
hand-built prompt parser) produces a `params` array, this plugin pulls
the matching rows, and a downstream prompt template renders them into
the context the LLM sees.

```
question → query_classify → postgres_query → prompt → provider_chat
```

Pair with `merge_rrf` if you also want vector-retrieved documents in the
context.
