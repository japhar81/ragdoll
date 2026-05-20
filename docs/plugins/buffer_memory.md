# Buffer Memory

A simple rolling-window memory: appends the current turn to a history
array, then trims so only the most recent `maxMessages` entries remain.
Per-execution, in-process — there is no shared store behind this node.

## Inputs

- `history` (`unknown[]`, optional) — the existing conversation buffer.
- `message` (optional) — the turn to append. When absent, every input
  field except `history` is bundled into an object and appended.

## Outputs

- `history` — the trimmed, appended array.

## Gotchas

- This is not durable memory. The next execution starts with whatever
  `history` you feed into it; persistence is your problem (read it from
  a real store before this node, write it back after).
- `maxMessages` clamps to a minimum of 1; setting it to 0 falls back to 1.

## Typical position

Source → (Buffer Memory) → Prompt template (which reads `history`)
