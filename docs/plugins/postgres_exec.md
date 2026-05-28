# postgres_exec

Runs raw SQL statements — typically DDL or one-shot migrations — against
an external Postgres database. Hard-gated by `config.allowDDL: true`
(literal), with `capabilities: ["dangerous", "setup"]` in the manifest
so it's visible in audits and the Builder palette warning.

This is a deliberately heavy-weight node. Use it for table provisioning
before an ingest run; do **not** use it in synchronous or MCP-exposed
pipelines.

See [ADR 0020](../adr/0020-external-database-plugins.md) for the
architectural rules.

## Inputs

None. Statements come from `config.statements`.

## Outputs

- **`executed`** — Count of statements that ran successfully. A failure
  partway through aborts the rest and the error is raised; statements
  before the failure are NOT rolled back unless the operator wrapped
  them in an explicit `BEGIN` / `COMMIT`.

## Gotchas

- **`allowDDL` must be the literal `true`.** Any other value —
  `undefined`, `"true"`, `1`, `false` — is refused with a clear error.
  This is intentional: it makes "this node will alter your schema"
  textually obvious in the pipeline spec, and it prevents a templating
  bug from accidentally enabling DDL.
- **Not recommended in synchronous pipelines.** DDL is slow and
  irreversible; running it on the hot path is asking for trouble. The
  contract doesn't *prevent* it, but the doc and the `capabilities:
  ["dangerous"]` flag steer operators away.
- **Not appropriate as an MCP tool.** Today, MCP exposure is a
  per-pipeline flag (`metadata.mcpExpose: true`). Operators should
  ensure pipelines containing `postgres_exec` keep the default
  `mcpExpose: false`. [ADR 0021](../adr/0021-external-connections-registry.md)
  proposes a registry-level mechanism that would make this enforceable
  at the contract layer.
- **No implicit transaction.** Each statement is its own round-trip.
  Wrap multi-statement migrations explicitly with `BEGIN; ... COMMIT;`
  if you need atomicity — but note that some DDL (e.g. `CREATE INDEX
  CONCURRENTLY`) refuses to run inside a transaction.

## Typical position

Run once during a tenant's first ingest setup, often via a one-off
pipeline that only this node lives in:

```
postgres_exec   # CREATE TABLE outages (...);
                # CREATE INDEX outages_project_ts ON outages (project, ts DESC);
```

Subsequent ingest pipelines reuse the same connection via
`postgres_upsert`.
