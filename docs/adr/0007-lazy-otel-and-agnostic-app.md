# ADR 0007: Lazy/Optional OpenTelemetry and Framework-Agnostic App

## Status

Accepted

## Context

OpenTelemetry is the observability standard, and Fastify is the API framework,
but the project invariant is that `npm test` runs offline with zero installs.
Statically importing `@opentelemetry/*` or `fastify` from the test path would
break that invariant.

## Decision

`@ragdoll/observability` declares the structural shape of the OTel API it uses
and `createTracer()` lazy-imports `@opentelemetry/api`; if the package is
absent or `enabled` is `false`, it returns a `NoopTracer`. It never throws and
never statically imports the optional dependency. The default logger is a
`ConsoleJsonLogger`.

The control plane is split: `apps/api/src/app.ts` exposes a framework-agnostic
`createApp(deps)` with a pure `handle(request)` router and imports no HTTP
framework; `apps/api/src/server.ts` is the only file that imports Fastify and
adapts it onto `app.handle`. The runtime `DagExecutor` accepts an injected
`Tracer` (defaulting to `NoopTracer`) and emits per-execution and per-node
spans with tenant/pipeline/execution attributes.

## Consequences

- `npm test` (68 unit tests) and `npm run test:functional` exercise the real
  app and runtime offline with no `fastify`, no `@opentelemetry/*`, no install.
- OpenTelemetry export is fully real when the packages are installed and
  `OTEL_ENABLED` is not `false`.
- The same routing logic is tested directly and served over HTTP, so
  functional tests cover production behavior.
- A non-Fastify transport can be added without touching route logic.
