# Simple Evaluator Stub

Placeholder evaluator. Always returns `{ score: 1, passed: true, notes:
"stub evaluator" }`. Use it as the wiring point for a real evaluation node
later — drop it in, prove the DAG flows through it, then replace with a
custom plugin when you build one.

## Inputs

Ignored.

## Outputs

- `score` (number) — always `1`.
- `passed` (boolean) — always `true`.
- `notes` (string) — `"stub evaluator"`.

## Gotchas

- This is a stub, not a no-op transformer; it does not pass inputs through.
  If a downstream node needs the prompt/answer, fan in from earlier in the
  DAG rather than relying on this node's outputs.

## Typical position

End of a query pipeline, in parallel with the final answer node, so the
trace records a scored evaluation entry per execution.
