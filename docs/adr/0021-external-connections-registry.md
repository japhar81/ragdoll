# ADR 0021: External Connections Registry

## Status

**Accepted. Superseded by ADR-0023 + ADR-0024.**

This ADR shipped the `external_connections` table and the
imperative `registerConnectionDriver(kind, factory)` API. Both have
since been replaced:

- **Registry side.** `external_connections` was folded into the
  unified `connections` table (ADR-0023 §1). Migration 019 copied
  every row verbatim; slugs preserved; `external_connection:*`
  permissions collapsed into `connection:*` (one-release alias kept
  through migration 019, dropped in a follow-up).
- **Driver side.** The imperative `registerConnectionDriver` call is
  replaced by `ConnectionDriverPlugin` manifests with
  `category: "connection_driver"` (ADR-0024). The platform's plugin-
  loader discovers them via its standard module scan; new connection
  kinds (Snowflake, Databricks, …) ship as sidecar plugins without a
  platform release.

The MongoDB / ClickHouse / Postgres plugin families this ADR
established are unchanged in their public contract; they consume the
unified registry through the same `acquireClient(input.connection)`
path.

Operator documentation: `docs/admin/connections.md` (the
`external-connections.md` file is deprecated and points readers there).

## Context

ADR 0020 introduced the first external-database plugin family
(`postgres_*`) and established four invariants: domain data lives
outside Ragdoll's DB, SQL-as-config / params-as-data, connections-as-
secrets, and a shared pool keyed by resolved DSN. Today the
plumbing is implemented in `plugins/builtin-rag/src/postgres-core.ts` —
a single internal module that the three Postgres plugins import.

This shape is fine for ONE backend type. The instant we add a second —
say a `mysql_query` family that also wants pooled, secret-resolved,
named connections — we'd either:

  - Duplicate `postgres-core` into `mysql-core` with `mysql2` instead
    of `pg`, or
  - Extract a generic-but-internal "connection cache" abstraction
    that each external-DB family imports.

Neither is wrong, but neither names the underlying concept that
*operators* care about: **"this is a connection to Acme's reporting
warehouse; it has a name, an owner, health, and an RBAC scope."**
Datasets already get this treatment (ADR 0016). External connections
should too.

## Proposal

Add a first-class **ExternalConnection** resource alongside Dataset:

```ts
interface ExternalConnection {
  id: UUID;
  scope: "global" | "tenant" | "environment";
  tenantId?: string;
  environmentId?: string;

  slug: string;                       // operator-facing name
  displayName: string;
  description?: string;

  kind: "postgres" | "mysql" | "clickhouse" | "http" | string;

  // Reference to the managed secret containing the DSN / API key.
  // Resolved through the existing scope inheritance walk.
  secretRef: SecretRef;

  // Per-kind structured config (max connections, default schema, …).
  options?: Record<string, unknown>;

  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}
```

### Pipeline spec shape

A node references a connection the way it already references a dataset:

```yaml
nodes:
  - id: outages
    plugin: { category: tool, id: postgres_query, version: 1.0.0 }
    connection: { slug: acme-reporting }       # NEW
    config:
      sql: "SELECT * FROM outages WHERE project = $1"
```

The runtime resolves `connection.slug` via the same env → tenant →
global walk used for datasets, hands the plugin a
`ResolvedExternalConnection` containing the secret-resolved DSN, and
the plugin uses the existing pool cache.

### What this buys

- **Naming.** Operators see `acme-reporting` in the UI and in pipeline
  exports — not a free-text label that means whatever the author typed.
- **Health.** A nightly job can probe every connection and surface red
  health badges in the Builder before a pipeline run fails on a dead
  DSN.
- **RBAC.** A new permission, `external_connection:use`, scoped per
  (tenant, environment, connection_id), gates which pipelines can
  reference which connections. Today there is no such gate —
  *anything* with a `secrets.dsn` reference can connect.
- **Audit.** Connection-level access logs (who ran what against which
  external DB, when) become easy because the connection has an id.
- **Pool isolation by intent, not by accident.** The pool cache keys
  off `connection.id` once the resource exists; today it keys off the
  resolved DSN. Both are correct, but the registry version is
  *explainable*.
- **Multi-backend uniformity.** The pattern works for `mysql`,
  `clickhouse`, an `http` JSON API, an S3 bucket, etc. without each
  plugin family reinventing connection management.

### Backwards compatibility

The current "secret-ref in the node" path keeps working — a node with
NO `connection:` field falls back to the existing `secrets.dsn` shape.
That keeps every Postgres pipeline written under ADR 0020 valid
unchanged. Migrating a pipeline to the registry-aware path is a one-
line spec edit.

### Migration of `postgres-core`

`plugins/builtin-rag/src/postgres-core.ts` becomes a thin consumer of
the registry rather than the owner of the pool cache. The cache moves
into a `packages/external-connections` package alongside the registry
client; per-driver factories (postgres, mysql, …) register themselves
the way provider adapters register today (ADR 0008 / providers
package).

## Decision

**Accepted** when MongoDB + ClickHouse families landed. The cost of
building the registry was paid for by two families (not just one)
sharing the resolver / pool cache / RBAC / probe infrastructure
out-of-the-gate, validating the abstraction was the right shape.

The `postgres-core` migration is a planned follow-up — preserving
back-compat for every pipeline written under ADR-0020 by keeping the
internal core as the fallback path until those pipelines opt in.

## Consequences (if accepted)

- New top-level resource, new API surface
  (`/api/external-connections`), new permission, new CLI commands
  (`ragdoll connections list / create / probe / archive`), new
  Builder picker.
- Existing Postgres plugins gain an optional `connection: { slug }`
  field that takes precedence over the legacy `secrets.dsn` path. No
  changes to plugins that don't opt in.
- One more thing for operators to learn — but it's symmetric with
  datasets, so the conceptual load is bounded.

## Amendment — identity-protected connections (token lifecycle)

The original abstraction resolves a connection's credential **once** at
`resolve()` time and caches the client **forever** keyed by `connection.id`.
That fits a database DSN (a static string) but not an identity-protected
service, whose usable credential is a short-lived token minted from a stored
secret (OAuth client_secret / refresh_token / basic creds) and refreshed
before it expires.

Rather than teach the manager about expiry, we keep it dumb and push the token
lifecycle **into the driver's client**, with two small additive seams:

1. **`ResolvedExternalConnection.resolveSecret?`** — an optional closure the
   resolver attaches for rows with a `secretRefKey`, which re-runs the **same**
   cascade on demand. A driver calls it inside its token refresh so a rotated
   stored secret is picked up without recreating the connection. Static/DB
   drivers ignore it and use the frozen `secret`. In-process only — a closure
   can't cross the Connect transport to an external driver.

2. **`TokenSource`** (`packages/external-connections/src/token-source.ts`) — the
   reusable token cache a driver composes: a `mint(audience)` callback plus
   `get(audience?)` / `invalidate(audience?)` / `clear()`. It owns single-flight
   minting (concurrent `get()`s share one exchange — no IdP stampede),
   proactive refresh with skew clamped to ≤ half the TTL, invalidate-on-401,
   and **per-`(connection, audience)`** isolation so one connection can hold
   distinct tokens for distinct downstream audiences. Single-audience drivers
   pass nothing and get the degenerate per-connection cache.

This was **extraction, not invention**: the `wazuh` driver already hand-rolled
token/expiry/401-retry inside its client handle, proving the abstraction
stretched. It is now the first `TokenSource` consumer (and the reference for
the next), which also closed the single-flight gap its hand-rolled version had.

Two adjacent fixes rode along: `acquireClient` now single-flights `create()`
(concurrent first-acquires shared one build), and `closeClient` disposes via
the driver that **built** the client (matched by the stored kind) instead of
walking every registered driver's `dispose` — harmless for stateless pools,
wrong for a client whose `dispose` tears down token state.

**Not covered:** this is *outbound* service auth (RAGdoll authenticating to a
downstream service). It is deliberately separate from the *inbound*
`IdentityProvider` / SSO plugin (ADR 0035) — same word "identity", opposite
direction — so the two config surfaces don't blur. External (sidecar)
identity drivers, which can't receive the `resolveSecret` closure over Connect,
are deferred: they resolve credentials on their own side.

## Alternatives considered

1. **Keep the per-family internal core forever.** Works fine while
   Postgres is the only external DB. Becomes a copy-paste hazard the
   moment a second family lands.

2. **Generalise the existing Dataset resource to cover external
   connections too.** Tempting because of the surface symmetry, but
   datasets carry an embedding profile, chunk schema, and modality
   slots that a raw DB connection just doesn't have. The naming would
   confuse more than it clarified.

3. **Use the existing Secret resource as the connection identifier.**
   The secret is half of what a connection is (the credential); the
   other half is the kind + per-kind options + health + RBAC scope.
   Conflating them robs us of the audit / RBAC / health surface.

## References

- ADR 0016 — Datasets (the resource shape this proposal mirrors).
- ADR 0019 — Plugin contract v2 (where `ResolvedDataset` is delivered
  to v2 plugins; `ResolvedExternalConnection` would follow the same
  shape).
- ADR 0020 — External-database plugins.
