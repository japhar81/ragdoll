# Query Fan-out

Asks an LLM to generate N alternative phrasings of the user's question.
The variants explore different angles of the same intent — useful for
multi-query retrieval where each variant fetches a candidate list and
the lists are fused with `merge_rrf`.

## Inputs

- `question` (string, required).

## Outputs

- `queries` (`string[]`) — the original question first, then N variants.
  Length is `1 + config.numVariants` in the happy path; on a malformed
  LLM response we fall back to one-per-line splitting and may emit
  fewer.

## Gotchas

- The LLM is asked for a JSON array. If it returns prose, the plugin
  parses one-per-line and strips bullets / numbers — defensive but not
  bulletproof. Use a stricter local model for production runs.
- `config.numVariants` defaults to 3. Larger fan-out costs more
  retrieval requests downstream; 3-5 is the usual sweet spot.

## Typical position

`question → query_fanout → (N retrievers fed by queries[]) → merge_rrf → …`
