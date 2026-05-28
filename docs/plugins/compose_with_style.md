# compose_with_style

Composes a reply in the sender's tone. Three context sources:

- **Style guide** (in the system prompt) — the static voice
  description from `tone_profile_build`.
- **Exemplars** (as few-shot in the system prompt) — retrieved per
  draft from the exemplar dataset.
- **Thread + intent** (in the user prompt) — the conversation to
  reply to and the user's brief intent.

Defaults to Anthropic Claude Sonnet because this is the user-visible
output. Slowest sync plugin in the family — operators relying on
tight latency should test with their target provider before
flipping a pipeline to synchronous.

## Inputs

- **`styleGuide`** *(required)* — the static style-guide string.
- **`exemplars`** *(optional)* — array of `{ text }` few-shot
  examples (typically retrieved upstream from the exemplar dataset).
- **`thread`** *(required)* — the conversation to reply to.
- **`intent`** *(optional)* — brief user intent ("decline politely",
  "ask for ETA", …).

## Outputs

- **`draft`** — the composed reply body. Output ONLY the body — no
  greeting framing, no commentary (the plugin instructs the model
  accordingly).
- **`exemplarsUsed`** — echo of the exemplar refs included in the
  prompt, for traceability.
- **`uncertain`** — `true` when the exemplar set was too small
  (<5) and the draft was prefixed with `[low-confidence draft]`.

## Gotchas

- **`markUncertain` is on by default.** When the upstream exemplar
  retriever returns fewer than 5 exemplars, the draft is prefixed
  with `[low-confidence draft]` and `uncertain: true` is emitted.
  Operators can disable but should plumb the flag through to UI.
- **Exemplar cap of 8 in the prompt.** More than that doesn't
  improve voice match in practice and burns context — retrieval
  upstream should already top-K.
- **System prompt is built per-call**, not cached on the provider
  side. Cache hit on the API side is on the provider's roadmap; for
  high-traffic chat the operator can pre-warm Anthropic prompt cache
  via a sidecar.

## Typical position

End of a sync compose pipeline; preceded by the style-guide / exemplar
retrieval and any context-gathering nodes.

```
intent → ┐
         ├─ dataset_search(exemplars by intent embedding) ─┐
thread →─┤                                                  ├─ compose_with_style → draft
         └─ secret(style-guide) ────────────────────────────┘
```
