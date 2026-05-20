# Sample Uppercase Transformer

A tiny demo plugin from the `sample-text` package. It uppercases one field
of the input payload and passes the rest through. Useful as a copy-paste
template when you're writing your first custom in-process plugin.

## Inputs

The full payload. `config.field` (default `"text"`) names the key to
uppercase.

## Outputs

The same payload, with the configured field uppercased.

## Gotchas

- Strictly for examples — there is no good production reason to uppercase
  a field in a RAG pipeline.
- Useful as a smoke node: drop it after a source to confirm the run is
  threading data through node-by-node before you wire the rest.

## Typical position

Demo / smoke testing only.
