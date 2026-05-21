# While Loop

Iterates a body subgraph until a predicate goes false. Each iteration's
output is threaded into the next iteration as `state`. A `maxIterations`
ceiling bounds the loop to prevent runaways.

## Inputs

- `state` (optional) — initial state value passed to the first body
  iteration as its `state` input.

## Outputs

- `final` — the last body output (full output object).
- `iterations` — number of body iterations executed.

## Config

- `mode`:
  - `"truthy"` (default) — body output's `continue` field (or `state` if
    `continue` is absent) is coerced to boolean.
  - `"defined"` — loop continues while the value is non-null/undefined.
- `maxIterations` (integer, default `100`) — hard ceiling regardless of
  predicate. The loop terminates whichever comes first.
- `body` (object, required) — body spec, executed each iteration.

## Body contract

Each iteration receives:

```
{
  state: <previous body's state output, or inputs.state on iteration 0>,
  iteration: <0-based count>,
  ...<outer inputs>
}
```

Each iteration should emit:

```
{
  state: <new state>,        // threaded into next iteration
  continue: <bool | nullish> // optional; when absent, predicate falls back to state
}
```

## Typical position

Self-converging chains: refine an answer until a critique is satisfied,
search/expand a graph until a target is reached, hill-climb a numeric
score, etc.

## Notes

- `maxIterations` defends against runaway loops. Pick a value that gives
  comfortable headroom (e.g. 2-3x the expected case) but caps cost.
- Always set both `state` and `continue` in your body when the predicate
  decision is non-trivial — relying on `state` alone is concise but
  conflates "still going" with "non-empty value", which can mislead.
