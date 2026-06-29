# ADR 0004: Queue Abstraction with BullMQ Default and In-Memory Adapter

## Status

Accepted

## Context

Ingestion, re-indexing, evaluation, batch runs, tenant vector deletion, model
catalog refresh, plugin health checks, and queued pipeline runs are
asynchronous. The platform must run them durably in production while remaining
testable offline with no broker installed.

## Decision

Define a dependency-free `QueuePort` (`enqueue`, `cancel`, `status`, `retry`,
`deadLetter`) in `apps/worker/src/index.ts`. Ship two adapters: an
`InMemoryQueue` (default; cooperative `drain`, per-job `AbortController`) and a
production adapter that lazy-imports its broker client only when its URL is
set. `apps/worker/src/main.ts` selects the adapter at startup; job handlers
(`createWorker`) are transport-agnostic and receive an `AbortSignal`.

> The production adapter was originally BullMQ-on-Redis; it is now NATS
> JetStream (`apps/worker/src/nats.ts`, gated on `NATS_URL`). See the
> amendment below.

## Consequences

- Unit and functional tests run offline with no Redis and no install.
- BullMQ provides production retries (exponential backoff), dead-letter, and
  cancellation without coupling handlers to the broker.
- A future NATS JetStream or Temporal adapter only needs to satisfy `QueuePort`.
- Without `REDIS_URL` the worker process has no external transport to consume;
  the in-memory queue is for in-process embedding and tests, not durability.

## Amendment — NATS JetStream replaces BullMQ (the production queue)

The `QueuePort` abstraction held: swapping the broker touched only the
adapter + the two selection sites, not a single handler or producer. BullMQ
(and its Redis dependency *for the queue*) is removed.

**What changed**

- New `apps/worker/src/nats.ts`: `NatsJetStreamQueue` (`QueuePort`) +
  `startNatsConsumer`, lazy-importing `@nats-io/transport-node` +
  `@nats-io/jetstream` only when `NATS_URL` is set. `bullmq.ts` is deleted;
  the `bullmq` dependency is dropped (`ioredis` stays — see below).
- Selection moved from `REDIS_URL` to `NATS_URL`: the JOB QUEUE is the only
  thing that moved. `apps/api/src/server.ts` + `apps/worker/src/main.ts`
  pick `NatsJetStreamQueue` when `NATS_URL` is set, else `InMemoryQueue`.
- Topology: one JetStream **work-queue** stream (`ragdoll-jobs`) captures a
  subject per job type (`ragdoll-jobs.<type>`). A single durable PULL
  consumer is shared by every worker replica — JetStream load-balances
  deliveries (the BullMQ "many workers, one queue" model). Work-queue
  retention deletes a message on ack.

**BullMQ-parity behaviours preserved**

- *Dedup*: published with `Nats-Msg-Id = job.id` + a stream duplicate
  window (collapses a producer re-publish of the same id).
- *Per-job attempts + exponential backoff*: the producer stamps `attempts`
  + `backoffMs` headers; the consumer `term()`s once the delivery count
  reaches `attempts` (BullMQ's "move to failed" / dead-letter), else
  `nak()`s with exponential backoff. `run_pipeline` enqueues attempts:1 so
  a state-mutating run is never silently re-executed. The decision is a
  pure, unit-tested function (`decideRedelivery`).
- *Long jobs*: a `working()` heartbeat every ackWait/2 keeps a slow run
  (CPU Ollama) from having its ack deadline expire mid-flight.
- *Cancellation*: a fresh `AbortController` per message, like the old
  consumer (handlers honour the signal; nothing calls `queue.cancel`).

**Redis is NOT gone.** It still backs three NON-queue roles, each on
`REDIS_URL`, independent of the queue transport: the change-event bus
(`/api/events` fan-out), the scheduler leader-election lease, and the SSO
state store. Production sets BOTH `NATS_URL` and `REDIS_URL`. The
`status`/`cancel`/`retry`/`deadLetter` port methods have no callers and are
documented no-ops on the NATS adapter (a work-queue keeps no random-access
job after ack).

**Infra**: `bundlednats` (single-replica Deployment + Service + PVC,
JetStream file storage, default ON) in the Helm chart; a `nats:2.10-alpine`
service (`-js -sd /data`) in docker-compose. Both wire `NATS_URL` into
api/worker.
