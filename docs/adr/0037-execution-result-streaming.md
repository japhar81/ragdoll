# ADR 0037 — Execution result streaming (per-step SSE)

## Status

Accepted

## Context

Today a pipeline run delivers its result all-at-once: `POST /invoke` returns a
single JSON body, and the async path (`POST /run` → NATS → worker) returns only
an `executionId` the client polls via `GET /api/executions/:id/trace`. The
live change bus (`ragdoll:changes` → WebSocket) already broadcasts per-node
lifecycle events, but they carry only `{nodeId, status, timestamps}` — the node
**output is dropped**, so the UI uses them purely as React-Query invalidation
triggers and re-reads `/trace`.

Users want to stream *results* as a long, multi-step RAG pipeline runs — e.g. a
retriever finds the primary doc at step 3 and streams it immediately, ancillary
docs stream at step 6, and the rest at the end — instead of waiting for the
whole DAG. The pieces to build this already exist and are reused here:

- a per-node completion hook in the executor that already holds the redacted
  output (`store.completeNode`);
- the `onToken` sink pattern for incremental LLM output;
- the change bus (Redis fan-out, tenant-scoped via `canSee`) and its worker
  publisher (`PublishingExecutionStore`);
- a chunked-SSE response writer in the Fastify adapter and an SSE client parser
  (`streamRun.ts`);
- the `execution_events` table (never previously written to).

## Decision

Add **opt-in, per-step result streaming** delivered over a dedicated
**per-execution SSE endpoint**.

### Opt-in (declarative + imperative)

- **Declarative:** a node sets `stream: true` (+ optional `streamAs: "<label>"`).
  On completion the executor emits the node's redacted output as a step frame.
- **Imperative:** a plugin calls `ctx.emit(channel, data)` (mirrors `onToken`)
  to push an intermediate result mid-run, before it returns. For a step that
  discovers several things over its lifetime.

Streaming is **off by default** — large or sensitive steps stay out of the
stream unless the author opts in.

### Frame model

The executor assigns each frame a `frameId` (uuid) and a **monotonic
per-execution `seq`**, redacts the body, then:

1. persists the full frame to `execution_events` (`event_type='execution.step'`)
   via `ExecutionStore.recordStep` — the replay source of truth; and
2. hands it to the `onStep` sink.

On the worker path, `PublishingExecutionStore.recordStep` fans a **size-capped**
copy onto the change bus as an `execution.step` `ChangeEvent`. The full body
**never rides the bus**: a body over `STEP_INLINE_MAX_BYTES` (16 KiB) travels as
a `preview` + `bytes` + `truncated:true`, and the client fetches the whole
(redacted) payload from `GET /api/executions/:id/steps/:frameId`. Persistence
reuses `stringifyForTrace` (same 8 MiB cell cap + shape sentinel as node
`output_redacted`) so a runaway step can't blow the jsonb row limit.

### Delivery: `GET /api/executions/:id/stream` (SSE)

Authorizes via `execution:view_logs` + the tenant guard (same as `/trace`),
then:

1. subscribes to the change bus (buffering, deduped by `frameId`) **before**
   the replay read, so nothing emitted in between is lost;
2. **replays** the persisted step frames (marked `replayed:true`) so a
   late-joining client catches up;
3. if the run is already terminal (or there's no bus), drains and closes;
4. otherwise **tails live** until a terminal lifecycle event, with a 15 s
   heartbeat comment to hold idle connections open.

Frames: `hello`, `step` (a `StepWireFrame`), `execution.node.started/completed`,
the terminal `execution.completed/failed/denied`, and `done`. This is the
canonical new API and works for the **queued/worker path** — the real home of
long multi-step pipelines. The existing synchronous `POST /stream` also surfaces
`step` frames (parity), via the same `onStep` sink.

### Ordering

The DAG runs branches in **parallel**, so frames arrive in **completion order**,
not authoring order. Clients label by `channel`/`nodeId`, not by sequence; `seq`
gives a deterministic total order for replay. "The rest at the end" is the
terminal `execution.completed` + the final `output` frame (existing).

## Consequences

- **New store surface:** `ExecutionStore.recordStep?` (optional — best-effort;
  stores without it simply don't stream) and read-side `listStepEvents` /
  `getStepEvent` on `ReadableExecutionStore`. Implemented for Postgres + the
  in-memory stores; the two worker decorators forward/augment it.
- **Late-join replay** works because frames are persisted, not just broadcast
  (the bus is ephemeral). Reconnect is safe — dedup is by `frameId`.
- **Large payloads** are supported by reference: capped on the wire, full body
  fetched on demand, bounded by the existing trace-cell policy.
- **Back-compat:** absent `stream`/`streamAs`, `recordStep`, `onStep`, and
  `emit` all no-op — every existing run behaves exactly as before.
- **Not done here:** rendering streamed frames in the Executions detail screen
  (the Builder run console renders them; a consumer lib — `streamExecution` /
  `fetchStepBody` — ships for the rest).
