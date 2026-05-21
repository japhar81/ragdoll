# ForEach

Runs a configured body subgraph once per item in `inputs.items`. Each
iteration receives `{ item, index, total }` plus the upstream inputs;
outputs are gathered into `results`.

## Inputs

- `items` (required) — array to iterate over. Must be an array; throws on
  non-array input.

## Outputs

- `results` — array of body outputs, in input order.

## Config

- `body` (object, required) — pipeline body executed for each item, stored
  as a `PipelineSpec.spec` shape.

## Body inputs

```
{
  item: <current array element>,
  index: <0-based position>,
  total: <items.length>,
  ...<outer inputs forwarded verbatim>
}
```

## Typical position

- Process each document returned by a retriever through a per-doc summary.
- Generate one answer per question in a batch.
- Score each candidate response, then aggregate downstream.

## Notes

- Iterations run sequentially. For embarrassingly-parallel cases, prefer
  running parallel branches.
- Empty `items` yields `results: []` with no body invocations.
