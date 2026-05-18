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
`BullMqQueue` plus `startBullMqConsumer` (`apps/worker/src/bullmq.ts`) that lazy-
import `bullmq`/`ioredis` only when `REDIS_URL` is set. `apps/worker/src/main.ts`
selects the adapter at startup; job handlers (`createWorker`) are transport-
agnostic and receive an `AbortSignal`.

## Consequences

- Unit and functional tests run offline with no Redis and no install.
- BullMQ provides production retries (exponential backoff), dead-letter, and
  cancellation without coupling handlers to the broker.
- A future NATS JetStream or Temporal adapter only needs to satisfy `QueuePort`.
- Without `REDIS_URL` the worker process has no external transport to consume;
  the in-memory queue is for in-process embedding and tests, not durability.
