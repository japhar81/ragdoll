# extract_entities

Runs one provider call per input record asking the model to emit
structured records matching a config-supplied JSON schema. The schema
is the contract; the plugin is fully domain-agnostic. For email work
the operator provides the email-specific schema (sender / project /
deadline / …) in the pipeline config; nothing about email is baked in
here.

## Inputs

- **`records`** *(required)* — array of records to extract from. Each
  must carry the configured `inputField` (default `text`).

## Outputs

- **`records`** — extracted structured records, optionally tagged with
  the configured `idField`'s value as `sourceId` for provenance.
- **`failures`** — records the model couldn't produce valid JSON for;
  safe to retry separately. Each carries `{ sourceId?, error }`.

## Gotchas

- **The schema appears in the prompt.** Models without a native
  JSON-mode improve markedly when the schema is the system prompt's
  closing instruction; this plugin always includes it. OpenAI's
  strict JSON mode is not used today — that's a follow-up.
- **`retry: 1` is the default re-ask budget.** Two retries pushes
  latency past the synchronous-pipeline budget; raise carefully for
  batch use.
- **`maxConcurrency` defaults to 4.** Set higher for ingest of large
  batches; lower (or 1) when the provider is rate-limited.

## Typical position

After `email_preprocess` (or any text-shaping node), feeding
`entity_resolve` to normalise mentions into canonical entities and
ultimately a `postgres_upsert` to persist the extracted rows.

```
email_preprocess → extract_entities → entity_resolve → postgres_upsert
```
