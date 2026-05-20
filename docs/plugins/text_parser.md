# Text Parser

The inverse of the loader: collapses whatever shape arrives —
`documents`, `chunks`, `text`, or `input` — into a single
`{ text: string }` for nodes that want one big string (a chunker that's
been bypassed, a custom evaluator, etc.).

## Inputs

The first non-empty of:
- `text`
- `documents` (array of strings or `{ text|content }` objects, joined by
  `\n\n`)
- `chunks` (same shape, joined by `\n\n`)
- `input`

## Outputs

- `text` (string) — the collected, optionally HTML-stripped, optionally
  whitespace-collapsed result.

## Gotchas

- `stripHtml` uses a naive `<[^>]*>` regex — it's good enough for marketing
  HTML but won't safely handle malformed/script-laden input. Don't use the
  output for security-sensitive sinks.
- `collapseWhitespace: true` (default) turns the entire string into a
  single line — fine for downstream embedding, not what you want if you
  need paragraph structure.

## Typical position

Loader (or directly from a source) → (Text Parser) → Chunker / Embedder
