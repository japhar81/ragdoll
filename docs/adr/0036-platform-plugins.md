# ADR 0036 — Platform plugins (global lifecycle hooks)

## Status

Accepted (Phase 1 in progress)

## Context

Node plugins are dragged into a pipeline DAG. We also need **global, engine-
style plugins** that run arbitrary code on platform lifecycle events —
pipeline start/finish/success/failure, secret added/removed, and anything else
currently written to **audit** (72 mutation actions across 15 domains) or
**usage**. Ideally with **pre** (interceptable) and **post** (observational)
phases. Goal: the most flexible/powerful ABI we can offer — not everything will
be used, and that's fine.

Two findings shaped the design:
- `audit()` (`apps/api/src/app.ts`) is already a single chokepoint for all 72
  mutations and already publishes a normalized event. The execution decorator
  and `recordUsage()` are the other two funnels. So emission is "tap 3 funnels,"
  not "instrument 100 call sites."
- We already have the pieces: the `ChangeEvent` envelope, NATS JetStream
  (durable fan-out), the identity/authz module-import-at-boot loader pattern,
  and connect-rpc — all reused here.

## Decision

A new package `@ragdoll/platform-plugins` and one event vocabulary
(`PlatformEvent`, a superset of `ChangeEvent`) with **two hook classes**:

- **Observers** (`on`, POST) — async, durable, at-least-once, isolated; never
  block the app. Cover all 72 mutations + the execution lifecycle + usage.
- **Interceptors** (`before`, PRE) — synchronous; return an
  `InterceptorDecision`: `continue | mutate(patch) | deny(reason,status?) |
  fail(reason)`. Run in priority order under a per-hook timeout, with a per-hook
  `failurePolicy` (open/closed). Cover every funnel (rich ABI over gaps).

Event families (one base envelope, discriminated by `category`):
- `mutation` — the 72 audited actions (before/after). pre = veto/mutate.
- `execution` — the run lifecycle: `accept` (API 4xx gate) → `start`
  (worker+sync; pre may mutate input/config/context or veto) → `finish` (pre
  may rewrite output or force-fail) → `success/failure/denied/cancelled`.
  Instrumented once in `DagExecutor.execute()` so async + sync runs are both
  covered.
- `usage` — `usage.recorded` (post).

`correlationId` brackets the pre/post of one operation. The catalog lists the
72 known mutations for docs but emission is forward-compatible (a new audited
action is trappable immediately).

### Where hooks run (tiered)

1. **In-process** (operator-installed) — `RAGDOLL_PLATFORM_PLUGINS` module
   list, imported at boot into a `PlatformPluginRegistry` (mirrors the
   identity/authz loaders). The **worker** runs the post-consumer, so hook
   code executes off the API request path.
2. **Webhooks** (per-tenant, no-code) — an `event_subscriptions` table,
   delivered from the durable stream, HMAC-signed + retried (Phase 1c). A
   synchronous `gate` variant, scoped to the tenant's own events, is a later
   option.
3. **Sidecar** (connect-rpc) — Phase 3.

### Delivery / failure semantics

- POST: `ragdoll.events` JetStream stream (limits retention), a shared durable
  consumer → each event runs observers once across replicas; a broken observer
  is logged, never rethrown. At-least-once; hooks must be idempotent.
- PRE: per-hook timeout; `mutate` composes (filtered to the fields the catalog
  marks mutable) and the next hook sees the change; `deny`/`fail` short-circuit;
  an error/timeout resolves by `failurePolicy`.
- A bad plugin MODULE fails the worker's platform load open (logged; jobs still
  run) — one broken hook must not halt the fleet.

## Consequences

- Any audited action + the pipeline run lifecycle + usage is trappable, pre
  and/or post, with veto/mutate/force-fail — a very expressive ABI.
- Emission touches 3 functions, not 100 call sites; the engine is pure +
  unit-tested; the API request path stays clean (hooks run in the worker).
- Security/trust: in-process hooks are vetted, boot-imported code (operator
  trust), not runtime-fetched; webhooks are the per-tenant-safe tier.

### Phasing

1. **(done)** core ABI (`@ragdoll/platform-plugins`) + durable transport +
   emit from all three funnels (post observers).
2. pre-lane interception wired at `audit()` (4xx), `enqueuePipelineRun()`
   (accept gate), and `DagExecutor` (start.pre / finish.pre).
3. webhook `observe` sink + `gate` webhooks + DLQ/replay + author SDK/docs.

## References

- `packages/platform-plugins/src/` — events, catalog, plugin/registry,
  dispatcher, loader.
- `apps/worker/src/platform-events.ts` — NATS transport + consumer.
- `apps/worker/src/handlers/execution-store-decorators.ts`,
  `apps/api/src/app.ts` (`audit()`) — the emission funnels.
- ADR 0004 (queue/NATS), ADR 0035 (module-import provider pattern).
