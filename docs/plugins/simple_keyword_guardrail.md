# Simple Keyword Guardrail

A blunt deny-list filter that fails the node — and thus the execution —
when the serialized inputs contain any of the configured keywords (case-
insensitive substring match).

## Inputs

The full incoming payload. Matching is done against
`JSON.stringify(inputs)`, so every nested string field is considered.

## Outputs

The inputs are passed through unchanged on success. On a match the node
throws `Guardrail blocked keyword: <word>`; the execution fails and the
error surfaces on the run trace.

## Gotchas

- Substring match. `bombast` triggers a `bomb` rule. Choose keywords
  with care or pair this with a more sophisticated upstream filter.
- The check is performed once per node invocation — drop one in early
  (right after a source) for cheapest possible filtering, or just before
  the LLM if you want to catch retriever leakage too.

## Typical position

Source → (Simple Keyword Guardrail) → rest of pipeline
