# Manual Text Input

A pass-through input node. Whatever the run starts with (`question`, `text`,
or any other key on the runtime input object) is emitted as the node's
output unchanged.

Use this at the front of a query pipeline so a question typed in the
Builder's *Test Input* panel — or sent via `POST /api/pipelines/:id/run` —
flows into the rest of the DAG without transformation.

## Inputs

The full runtime input payload (`Record<string, unknown>`). Downstream nodes
typically read `question` (for query pipelines) or `text` / `documents` /
`uri` (for ingestion).

## Outputs

The same object, key-for-key.

## Gotchas

- No configuration — if you want to rename or massage the payload, drop a
  Text Parser or Field Router after it.
- Pairs naturally with the `input` system node already on the canvas; the
  difference is that this manifest-backed node makes the intent visible in
  the palette/catalog.

## Typical position

Source → (Manual Text Input) → retriever / chunker / prompt → …
