# Streaming pipeline results as they run (ADR-0037)

A pipeline can stream results to a client **while it runs** — a retriever finds
the primary doc at step 3 and streams it immediately, ancillary docs stream at
step 6, and the rest arrives at the end — instead of the client waiting for the
whole DAG. Streaming is **opt-in per node** and delivered over a per-execution
Server-Sent Events (SSE) endpoint.

> **Ordering:** the DAG runs independent branches in parallel, so frames arrive
> in **completion order**, not authoring order. Label your streamed steps by
> `channel`, not by position. Each frame also carries a monotonic `seq` for
> deterministic replay ordering.

## Opting a node into streaming

### Declarative — stream a node's whole output

Set `stream: true` on the node; its (redacted) output is streamed the moment the
node completes. Add `streamAs` to label the channel a client sees.

```yaml
nodes:
  - id: find-primary
    plugin: { category: retriever, id: opensearch_retriever, version: 1.0.0 }
    stream: true
    streamAs: primary        # optional; defaults to the node id
  - id: find-ancillary
    plugin: { category: retriever, id: dataset_search, version: 1.0.0 }
    stream: true
    streamAs: ancillary
```

Nodes without `stream` are never streamed — large or sensitive steps stay out of
the stream unless you opt in.

### Imperative — a plugin emits mid-run

For a step that discovers several results over its lifetime, a plugin can push
frames **before it returns** via `ctx.emit(channel, data)` (fire-and-forget;
guard it because it's `undefined` when the run isn't being streamed):

```ts
async execute(input) {
  const primary = await findPrimary(input);
  input.emit?.("primary", primary);         // streamed at step 3
  const ancillary = await findAncillary(primary);
  input.emit?.("ancillary", { docs: ancillary }); // streamed later
  return { outputs: { primary, ancillary } };
}
```

The runtime redacts and size-caps every emitted body — never emit secrets, but
know that the usual secret-redaction still runs.

## Consuming the stream

### `GET /api/executions/:id/stream` (the canonical path)

Start a run (`POST /api/pipelines/:id/run` → `202 { executionId }`), then open
the SSE stream for that execution. It **replays** frames already recorded (so a
late joiner catches up), then **tails live** until the run reaches a terminal
status. Reconnecting is safe — frames dedupe by `frameId`.

Frames (`event:` / `data:`):

| event | data |
| --- | --- |
| `hello` | `{ executionId, status }` |
| `step` | a `StepWireFrame` (`+ replayed: true` during replay) |
| `execution.node.started` / `execution.node.completed` | `{ nodeId, status, … }` |
| `execution.completed` / `execution.failed` / `execution.denied` | `{ status, … }` |
| `done` | `{ executionId }` — the stream is closing |

From the web app:

```ts
import { streamExecution, fetchStepBody, type StepFrame } from "../lib/streamRun.ts";

await streamExecution({
  executionId,
  onEvent: async (frame) => {
    if (frame.event !== "step") return;
    const step = frame.data as StepFrame;
    if (step.truncated) {
      const full = await fetchStepBody(executionId, step.frameId); // large body
      render(step.channel, full);
    } else {
      render(step.channel, step.data);
    }
  }
});
```

The synchronous `POST /api/pipelines/:id/stream` route also surfaces `step`
frames (alongside `token` and `output`), for runs executed in-process.

## Large payloads

A step body over **16 KiB** (`STEP_INLINE_MAX_BYTES`) does not ride the wire in
full — the `step` frame arrives with `truncated: true`, a `preview`, `bytes`,
and the `frameId`. Fetch the complete (redacted) body on demand:

```
GET /api/executions/:id/steps/:frameId  →  { step: { …, data } }
```

Bodies are persisted with the same 8 MiB trace-cell cap as node outputs, so a
runaway step can't blow the row limit; beyond that a shape-preserving sentinel
is stored.

## Auth & tenancy

The stream and fetch-by-ref endpoints require `execution:view_logs` and enforce
the same tenant guard as `/trace` — a non-platform-admin principal can only see
executions in its own tenant. Live frames on the change bus are additionally
tenant-filtered before fan-out.

## Persistence & replay

Every streamed frame is written to `execution_events`
(`event_type = 'execution.step'`), which is why a client that connects after
step 3 still sees it. The live change bus is ephemeral; the persisted frames are
the replay source of truth.

See [ADR-0037](../adr/0037-execution-result-streaming.md) for the design.
