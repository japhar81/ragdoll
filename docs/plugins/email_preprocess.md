# email_preprocess

Pure-text cleaner for one message body. Strips quoted-reply chains
(after `On … wrote:` boundaries and `>`-prefixed lines), trailing
signatures, corporate legal disclaimers, and mobile-client boilerplate.
Classifies the message as a thread root vs reply and detects the body
language. No LLM, no I/O — safe in synchronous and batch pipelines.

## Inputs

- **`text`** *(required)* — the raw message body string. The
  `inputField` config lets you pull from a different key on the
  upstream payload.

## Outputs

- **`text`** — cleaned message body.
- **`originalText`** *(when `keepOriginal: true`, the default)* — the
  pre-clean body for traceability.
- **`isReply`** — `true` when a quote boundary or inline `>` lines
  were found.
- **`language`** — best-guess language code (`en` / `es` / `fr` / `de`
  / `pt`) or `undefined`.
- **`removedLines`** — number of source lines dropped.

## Gotchas

- **Heuristics are deliberately narrow.** False positives drop real
  content; we'd rather miss a disclaimer than truncate prose.
- **Inline `>` blocks** are stripped even when no "On X wrote:"
  header was present (Gmail mobile does this).
- **Language detection is a stopword count.** Good enough for
  routing; don't use it as a content-language certification.

## Typical position

Right after the email source node (filesystem / opensearch / IMAP) in
an ingest pipeline, before chunking + embedding.

```
imap_source → email_preprocess → chunk_contextual → provider_embeddings → dataset_upsert
```
