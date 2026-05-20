# Webhook Output

Sends the pipeline's terminal payload to a configured URL via
`fetch`. Used for fire-and-forget integration with downstream
systems (ticketing, chat, analytics) once a query or ingestion is done.

## Inputs

The full upstream payload. The whole object is JSON-encoded and used as
the request body.

## Outputs

- `delivered.url` (string)
- `delivered.status` (number) — HTTP status code.
- `delivered.response` — parsed JSON body when the response is JSON,
  otherwise the raw text.
- The original `inputs` are also merged into the output so downstream
  nodes (rare, but possible) can still see what was sent.

## Gotchas

- `url` is required and must be absolute. The execution fails fast if
  it's empty.
- Non-2xx responses fail the node — the run is retried per the
  pipeline's policy. If you actually want fire-and-forget semantics,
  catch upstream and discard.
- The optional `authorization` secret is sent as the `Authorization`
  header. Prefer this over hard-coding tokens in `headers`.
- `timeoutMs` defaults to 10 s.

## Typical position

… → LLM / Output Parser → (Webhook Output)
