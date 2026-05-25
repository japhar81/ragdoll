# Dgraph Query

Runs a DQL query against a Dgraph instance and emits the response's
`data` block as `results`. Operator writes the query string in
config; the platform exposes the executing tenant id as a
`$tenant_id` variable so queries can filter without hardcoding
internal ids.

Pairs with `dgraph_upsert` for write-side ingest. Both plugins
declare `contract: 2` + `datasetModalities: ["graph"]`, so the
Builder picker only offers graph-enabled datasets.

## Inputs

- `vars` (optional) — map of GraphQL-style query variables to
  forward. `$tenant_id` is always overwritten by the platform; any
  other keys are passed through.

## Outputs

- `results` — the raw `data` block returned by Dgraph. Shape is
  whatever the query named: a query of the form
  `{ docs(...) { title } }` yields `{ docs: [{ title: "…" }, …] }`.

## Config

- `url` (optional) — Dgraph HTTP endpoint. Same fallback chain as
  `dgraph_upsert` (config → dataset backend → env → in-memory).
- `query` (required) — DQL query string. Use `$tenant_id` to scope.

## Tenant isolation

The platform sets `$tenant_id` to the executing tenant before
forwarding to Dgraph. Always filter on it (e.g.
`func: eq(tenant_id, $tenant_id)` at the root, or scope with
`@filter(eq(tenant_id, $tenant_id))` in nested blocks) — otherwise
your query will leak rows across tenants.

## Example

```dql
{
  q(func: type(Document)) @filter(eq(tenant_id, $tenant_id)) {
    uid
    path
    text
  }
}
```

A more typed example, looking up an `Org` and its members:

```dql
query Members($org_name: string) {
  orgs(func: eq(name, $org_name)) @filter(eq(tenant_id, $tenant_id)) {
    name
    members {
      name
      email
    }
  }
}
```

Pass `{ "$org_name": "Acme" }` on the `vars` input port to bind the
variable.

## When to use

- Multi-hop traversal queries that flatten poorly to vector search.
- Joining graph relations against vector hits — wire a
  `dataset_search` retriever upstream and feed the matched uids into
  a `dgraph_query` for context expansion.
- Reporting / catalog lookups where you want structured rows back.

## When NOT to use

- Plain semantic search — `dataset_search` (vector mode) is cheaper.
- Free-text full-document retrieval — Dgraph has `@index(fulltext)`
  but `text` modality + OpenSearch outperforms it for the common case.
