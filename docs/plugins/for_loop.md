# For Loop

Runs a configured body subgraph `N` times. Each iteration receives the
upstream inputs **plus** `{ index, total }` so the body can act on its
position in the loop. The body's terminal output is collected into the
`results` port.

## Inputs

- `count` (optional) — overrides `config.count` when supplied upstream.

## Outputs

- `results` — array of body outputs, in iteration order.
- `final` — the last body output (same as `results[results.length - 1]`).

## Config

- `count` (integer, default `1`) — number of iterations.
- `body` (object, required) — pipeline body executed each iteration. Stored
  as a `PipelineSpec.spec` shape (`{ nodes, edges, parameters? }`); the
  plugin wraps it into a full PipelineSpec at execution time.

## Body inputs

The body's root node receives, at minimum:

```
{
  index: <0-based iteration number>,
  total: <count>,
  ...<the outer node's inputs forwarded verbatim>
}
```

## Typical position

Anywhere you need a deterministic, fixed-count repeat — e.g. retry a
generation `K` times, fan out across a known number of personas, generate a
fixed number of sample questions, etc.

## Notes

- For-loops always run sequentially within a single execution. If your
  iterations are independent, prefer wiring them as parallel branches
  (multiple downstream nodes off one source) rather than a loop.
- The body's outputs are the terminal-node outputs (same rules as the outer
  pipeline). If your body has multiple terminal nodes, return a single
  collected payload from the last one.
