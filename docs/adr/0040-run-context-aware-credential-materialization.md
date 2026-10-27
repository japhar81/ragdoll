# ADR-0040 — Run-context-aware credential materialisation for sidecar plugins

## Status

Accepted — implemented. Extends [ADR-0039](0039-connection-credentials-for-external-plugins.md).

## Context

ADR-0039 gave a connection driver an opt-in hook to materialise a serialisable
credential for a sidecar plugin:

```ts
materializeExternalCredential?(connection): Promise<ExternalCredential>
```

The hook receives **only the connection**. So the driver can key its credential
lookup on nothing but the connection's own `config` / `options`. For an
identity-service driver that must select a credential by a per-run tenant /
environment / credential identifier, those identifiers have to be baked into the
connection — which forces **one connection per (tenant, environment, credential)
combination**. An operator running the same crawler across many customers ends
up registering a connection per customer, defeating the point of a reusable
driver.

What the driver actually wants is to read those identifiers from the **run**:
the node's resolved `config`, or a value wired into an **input port** from an
upstream node. Those values are already present in core at the moment the
credential is materialised (`DagExecutor.executeNode` has the node and its
inputs in scope) — the hook just wasn't given them.

### The complication: the refresh callback has no run context

ADR-0039's whole point was mid-run refresh. On refresh, the **API** endpoint
re-materialises the credential from the grant token alone
(`redeemConnectionCredentialGrant`). The API has **no node config and no input
ports** at redeem time — they existed only during the run. If materialisation
now depends on run context, a naive refresh re-materialises with the wrong (or
missing) identifiers.

### Options considered

- **Driver-nominated `refreshContext` persisted on the grant** (chosen). On the
  first materialisation the driver returns, alongside the credential, a small
  identifiers-only blob. Core persists it on the grant row and replays it into
  the hook on refresh. Supports selectors from both config and input ports;
  minimal; the driver decides exactly what is stored.
- **Reload the pipeline config at redeem.** The API reloads the pipeline version
  and re-resolves node config only. No new column, but it **cannot** support
  input-port-derived selectors across a refresh, and couples the callback
  endpoint to pipeline loading. Rejected.
- **Re-mint the grant on every refresh from live context.** There is no live
  context on the callback path — the sidecar, not core, drives refresh.
  Rejected.

## Decision

This is a **core-only** change. The driver runs in-process, so the node config
and input ports are handed to it by reference — **nothing new is serialised at
materialise time**, and the sidecar wire contract (the `connection` Struct,
field 12) is **unchanged**. No `proto` change, no sidecar change.

### The driver contract (`@ragdoll/connection-sdk`)

The hook gains an optional second argument and a richer return:

```ts
materializeExternalCredential?(
  connection: ResolvedExternalConnection,
  context?: CredentialMaterializationContext
): Promise<MaterializedExternalCredential>
```

- `CredentialMaterializationContext = { tenantId, environment, executionId,
  nodeId, requestId?, config, inputs, refreshContext? }`. A driver reads its
  per-run selectors from `context.config` or `context.inputs`. On the refresh
  callback, `config` / `inputs` are empty and `refreshContext` carries the
  persisted selectors instead.
- `MaterializedExternalCredential extends ExternalCredential` with an optional
  `refreshContext` — identifiers **only**, never secrets. Core persists it on
  the grant and **strips it from the wire envelope**, so it never reaches the
  sidecar.

Both additions are optional and backward-compatible: a driver written against
ADR-0039 (plain `ExternalCredential`, no second arg) keeps compiling and
behaving exactly as before.

### The runtime (`packages/runtime/src/index.ts`)

`buildExternalConnectionEnvelope` now receives the node's resolved `config` and
`inputs`, builds the materialisation context, splits the returned
`refreshContext` off the wire credential, and passes it to the grant issuer.

### The grant store (`connection_credential_grants`, migration 031)

A nullable `materialization_context jsonb` column holds the driver's persisted
selectors. `null` for connection-only (ADR-0039) drivers — purely additive, so
existing grants are untouched. The column holds identifiers only; the credential
itself is still re-fetched on every redeem and never stored.

### The refresh callback (`@ragdoll/external-connections`)

`redeemConnectionCredentialGrant` rebuilds the context from the grant
(`config` / `inputs` empty, `refreshContext` = the persisted blob) and replays
it into the hook, then strips `refreshContext` from the credential handed back
to the sidecar.

## Consequences

- One connection serves many tenants / environments / credentials: the per-run
  selectors come from the node, not from a connection registered per
  combination.
- The stored selectors are **identifiers, not secrets**. They are tenant-scoped,
  expire and are revoked with the run (ADR-0039), and the credential is always
  re-materialised — never persisted.
- Entirely core-side: no proto regen, no Python sidecar change, no new wire
  field. The sidecar keeps receiving the same `{ credential, refresh }` envelope.
- Scoped to the **sidecar materialise hook**. The in-process `create(connection)`
  path is unchanged (its client is cached per `connection.id`, so per-run context
  would conflict with pooling); in-process parity is a possible follow-up, not
  part of this ADR.

## Verification

- `@ragdoll/connection-sdk`: the hook receives the run context and resolves from
  `config` or an input port; `refreshContext` is returned on the credential.
- `@ragdoll/external-connections`: the issuer persists `refreshContext` on the
  grant (and `null` for connection-only drivers); redeem replays the persisted
  context into the hook, confirms `config` / `inputs` are empty on that path, and
  strips `refreshContext` from the wire credential.
- `@ragdoll/db`: `materialization_context` round-trips and is deep-copied.
- `@ragdoll/runtime`: end-to-end — the driver receives the node's resolved config
  via the executor, the issuer receives the driver's `refreshContext`, and the
  envelope shipped to the sidecar carries the resolved credential **without**
  `refreshContext`.
