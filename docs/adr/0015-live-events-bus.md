# ADR 0015 — Live events bus and WebSocket fan-out

Status: Accepted (2026-05-23)

## Context

RAGdoll is multi-tenant and driven by several actors: the web UI, the CLI,
the MCP server, scheduled triggers, and other API clients. Every mutation
ran through `audit()` (an append to `audit_logs`), but the web UI only saw
those changes on the next manual refresh or on its 1–1.5 s execution-trace
poll. A user editing in the Builder while a teammate added an environment
via the MCP would see stale data, and the Executions screen burned CPU on
both sides for a behaviour the worker already knows about.

The audit table is the system of record for *what happened*. We wanted a
second, latency-sensitive channel for *what just happened* that:

- the UI can subscribe to with zero polling,
- the worker can publish to (execution lifecycle),
- multi-replica deployments can rely on (cross-process fan-out),
- tests can use install-free.

## Decision

Add a tiny `ChangeBus` interface (`packages/events`) with two
implementations:

- **`InMemoryChangeBus`** — process-local pub/sub. Default for tests and
  single-replica local stacks where the worker, API, and any WS clients
  live in the same Node process.
- **`createRedisChangeBus(...)`** — Redis pub/sub on the channel
  `ragdoll:changes`. Two `ioredis` clients (one pub, one sub) — required
  because a subscribed connection can't issue arbitrary commands. `ioredis`
  is lazy-imported so the package stays install-free for in-memory use.

The API's `audit()` helper publishes a `ChangeEvent` next to the audit
write. The worker wraps its `ExecutionStore` with a
`PublishingExecutionStore` decorator that publishes `execution.started`,
`execution.node.started`, `execution.node.completed`, and the terminal
`execution.completed` / `.failed` events. Bus failures are logged but
never roll back a mutation — the audit row is the system of record.

A WebSocket endpoint at **`/api/events`** (mounted in
`apps/api/src/websocket.ts` via `@fastify/websocket`) fans events out to
authenticated clients:

- **Auth-after-open**: the first client frame is
  `{type:"auth", token|apiKey}`. The same `AuthResolver` the REST router
  uses verifies the credential; an `Authorizer` closure is attached so the
  WS handler can call `enforce(...)` like every other route. A 10 s grace
  window closes idle unauthenticated connections.
- **Tenant scope filter**: on auth, the connection's *reach*
  (`{seesGlobal, tenants}`) is resolved from grants. Each event is
  forwarded only if `seesGlobal` or `event.tenantId` is in the set.
  Platform-scope events (`tenantId: null`) reach only global-scope
  principals.
- **Builder rooms**: a `pipeline:update`-gated per-pipeline channel for
  collaborative editing. Joiners get a roster (presence list); members
  broadcast full spec snapshots to peers (server filters out self). v1 is
  last-writer-wins per broadcast — fine for two users editing different
  nodes, racy for two users editing the same node. A node-stamped merge
  is wired through the protocol (`BuilderEdit.nodeStamps`) for a future
  per-node CRDT.

Nginx is configured to forward the `Upgrade` / `Connection` headers on
the `/api/` location so the SPA's `/api/events` upgrade survives the
reverse proxy; the Vite dev proxy sets `ws: true` for the same reason.

## Consequences

- **Live UI** without polling: any audited mutation reflects in
  subscribed tabs within a frame; execution-trace polling drops to a
  fallback that only runs while disconnected.
- **MCP / CLI / other-tab visibility**: changes from out-of-process
  actors land on every signed-in tab that can see them.
- **Multi-replica safe**: a Redis bus means N API replicas all see every
  publish, and the worker can publish events the API rebroadcasts.
- **Audit stays authoritative**: a transient Redis outage drops live
  events but does not affect mutations or the audit log.
- **Cost**: one extra ioredis pair per API replica (negligible),
  one Node interval per WS server reaping idle Builder-room members
  (`.unref()`d, never blocks shutdown).

## Open work

- Per-node CRDT for the Builder room (the `nodeStamps` protocol field is
  reserved for it).
- Live-revocation on long-lived WS connections: scope reach is resolved
  once at auth time today; a follow-up should re-resolve on a grant
  change for that user.
