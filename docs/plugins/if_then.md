# If / Then

Branches the DAG along one of two output ports based on a predicate. Unlike
`field_router` (which only labels), `if_then` makes the unselected branch
**dead**: the runtime sees no value on its port and skips every downstream
node wired to it (and their descendants, transitively).

This is the building block for "do A or B, not both". Wire upstream nodes
into the `then` and `else` output ports; whichever side fires, the other
side is silently skipped.

## Inputs

- `value` (required) — the value the predicate is evaluated against.
- `payload` (optional) — what to forward on the selected branch. Defaults
  to `value` when omitted.

## Outputs

Exactly one of these emits per execution:

- `then` — live when the predicate evaluates true; carries `payload`.
- `else` — live when the predicate evaluates false; carries `payload`.

## Config

- `mode`:
  - `"truthy"` (default) — `Boolean(value)`; empty arrays/objects are false.
  - `"equals"` — `value === config.equals` (with JSON-equality fallback for
    arrays/objects).
  - `"defined"` — `value !== undefined && value !== null`.
- `equals` — value to compare against when `mode = "equals"`.

## Skip semantics

The runtime marks an output port "dead" when its emitted value is
`undefined`. Every edge originating on a dead port becomes a non-live edge,
and any downstream node whose live incoming-edge count drops to zero is
recorded with status `skipped` (visible in the executions screen).

## Typical position

Classifier / boolean node → (If/Then) → diverging subgraphs that don't
both run.
