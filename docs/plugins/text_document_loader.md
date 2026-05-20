# Text Document Loader

Normalizes whichever input shape your source produced into a uniform
`{ documents: [{ text, metadata }, ...] }` array so everything downstream
can assume one consistent layout.

## Inputs

The node accepts (in priority order):

1. `documents: Array<string | { text|content, metadata? }>` — keeps the
   array, normalizing each entry to `{ text, metadata }`.
2. `text: string` (or legacy `input`) — wraps to a one-element documents
   array. With `splitOnBlankLines: true`, splits on blank lines into
   multiple documents.
3. `uri: string` only — emits a single empty-text document with
   `metadata.uri` set, useful as a placeholder for an external loader.

## Outputs

- `documents` — `Array<{ text: string; metadata: Record<string, unknown> }>`.

## Gotchas

- This node does not fetch URIs — it only carries them through as
  metadata. Real fetching belongs in a custom loader plugin.
- `trim: true` (default) trims each emitted `text` field; turn it off if
  leading/trailing whitespace is semantically meaningful.

## Typical position

Source / Manual Input → (Text Document Loader) → Chunker
