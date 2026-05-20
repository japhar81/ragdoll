# Field Router

Reads one field from `inputs`, looks the value up in a routes map, and
emits a `route` label. Useful as a "switch" upstream of branched logic —
combine with a downstream node that reads `inputs.route` and behaves
accordingly.

## Inputs

The full payload. The configured `field` (default `"intent"`) selects the
routing key.

## Outputs

- `route` (string) — the mapped label, or `defaultRoute` when no match.
- `value` — the original field value the route decision was based on (may
  be `undefined`).
- `passthrough` — the full inputs object, so downstream nodes don't lose
  context.

## Gotchas

- This node does not actually fork the DAG — it labels. Use a router and
  follow it with one or more nodes that filter on `inputs.route`, or
  use multiple downstream edges and a custom conditional plugin.
- Keys in `routes` are matched by exact string equality (cast). Numbers,
  booleans, etc. are stringified first.

## Typical position

Source / classifier → (Field Router) → branch-specific subgraphs
