# Provider Embeddings

Embeds one or more texts using OpenAI, Anthropic, or an Ollama-compatible
embeddings endpoint. Outputs a parallel array of vectors so they can be
zipped with chunks for upsert, or used as a query vector by a retriever.

## Inputs

The plugin tries three input shapes, in order:

1. `texts: string[]` — direct list of strings to embed.
2. `chunks: Array<{ text }>` — each chunk's `.text` field is embedded.
3. `text: string` — single string, wrapped to a one-element list.

## Outputs

- `vectors` (`number[][]`) — one vector per input text, in input order.
- `dimensions` (number) — the vector length.

## Gotchas

- Hosted providers (OpenAI) require an `apiKey` secret; Ollama does not.
- If the input list is empty the node still succeeds, returning `{ vectors:
  [], dimensions: 0 }`. Downstream nodes that always expect a non-empty
  vectors array should defend against this.
- `provider` / `model` fall back to the resolved-config keys
  `embedding.provider` / `embedding.model` when the node's own fields are
  empty, so tenant-wide defaults work out of the box.

## Typical position

Chunker → (Provider Embeddings) → Vector Upsert / Vector Store
