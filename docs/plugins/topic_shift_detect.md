# Topic Shift Detect

Asks an LLM whether the latest turn changes topic vs. the conversation
so far. Output drives a downstream router — e.g. invalidate the
retrieved-context cache on shift, or route a topic-shifted turn through
a different sub-pipeline.

## Inputs

- `question` (string, required) — the latest turn.
- `history` (`Array<{role, content}>`) — recent prior turns.

## Outputs

- `shifted` (boolean) — true when the latest turn changes topic.
- `confidence` (number 0..1) — model-reported confidence.

## Gotchas

- The prompt asks for compact JSON; malformed responses fall back to a
  prose check (`/yes|true|shift|changed/i`) at confidence 0.5. Real
  production runs should pin a small reliable model.
- `shifted: false` with `confidence: 1` is the safe default when no
  history is supplied — nothing to shift away from.
- This is a router-style node: wire `shifted` into an `if_then` or a
  custom router to fork the downstream graph.

## Typical position

```
input → topic_shift_detect ─┬─ if_then(shifted) ─┬→ (fresh retrieval pipeline)
                            │                    └→ (cached-context fast path)
                            └→ … (other downstream branches)
```
