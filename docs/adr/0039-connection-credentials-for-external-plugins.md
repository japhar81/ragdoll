# ADR-0039 — Connection credentials for external (sidecar) plugins

## Status

Accepted — implemented.

## Context

A **connection driver** (ADR-0021/0024) teaches the platform how to open a
client for an external system. Drivers are TypeScript objects that live in the
core process: a node references a connection by slug, the runtime resolves it
(`externalConnectionResolver`) and hands an in-process plugin a
`ResolvedExternalConnection` on `input.connection`, from which the plugin builds
a live client via `acquireClient()`.

That live client — a pooled DB handle, an open socket, a token source — **cannot
cross a transport**. So an **external plugin** running in a sidecar (e.g. a
Python crawler) could not use a connection driver at all:

- `buildExecuteRequest` (`packages/plugin-sdk/src/transport.ts`) serialised
  `config / inputs / dataset / secrets / deadline` into the proto request and
  **silently dropped `input.connection`**. For an external plugin the resolved
  connection went nowhere.
- The one credential that *did* reach a sidecar was a **dataset-bound**
  connection's stored secret, spliced into `secrets` under
  `__connection_<binding>__` (ADR-0023). That only covers a connection bound to
  a dataset, and only a **static stored secret**.

The motivating driver has **no stored secret**: it *mints* a credential at
runtime (an identity service hands back a short-lived token). The usable
credential only exists after running driver logic — which lives in TS, in core.
Shipping `connection.secret` would ship `undefined`.

Two sub-gaps, then:

1. the top-level `node.connection` is never serialised to a sidecar at all; and
2. a **driver-materialised** credential never crosses on *any* path — only
   stored secrets do.

Gap (2) is the real blocker, and a long crawl can also outlive a freshly-minted
token, so a one-shot credential is not enough.

### Options considered

- **Serialise the resolved connection's static fields** (`secret`, `options`).
  Closes gap (1) only; useless for a minted credential. Rejected as the answer.
- **Opt-in driver hook + inline credential + a refresh callback** (chosen).
  A driver opts into producing a serialisable credential; core materialises it,
  ships it inline, and the sidecar refreshes it mid-run via a revocable grant.
- **Sidecar-pull-only (no inline credential)** — every external call makes the
  sidecar round-trip to core first. Rejected: an extra network hop on the common
  path for no benefit; the callback already covers refresh.

## Decision

### The driver contract (`@ragdoll/connection-sdk`)

Add an **opt-in** hook:

```ts
materializeExternalCredential?(connection): Promise<ExternalCredential>
```

`ExternalCredential = { value?, headers?, query?, expiresAt?, options? }` — a
bearer token, a header set, a DSN; all JSON. A driver whose credential is a live
pooled client simply omits the hook and stays in-process only — which is exactly
why a credential never leaks to a sidecar unless a driver author deliberately
exposes one. Identity drivers mint a fresh token in the hook (reusing their
in-process `TokenSource`), so core materialises a current credential per call.
`materializeExternalCredential(connection)` (registry helper) runs the hook, or
returns `undefined` for an in-process-only driver.

### The wire (`proto/plugin.proto`)

Add `google.protobuf.Struct connection = 12` to `ExecuteRequest`, carrying a
serialisable envelope `{ slug, kind, options?, credential?, refresh? }`. The
live driver client and the `resolveSecret` closure never appear — only the
materialised credential plus a callback descriptor.

### The runtime (`packages/runtime/src/index.ts`)

For a node that references a connection **and** targets an external plugin, the
executor materialises a credential (falling back to the connection's static
`secret` when the driver has no hook), mints a **refresh grant** for a
driver-materialised credential, and ships the envelope as
`input.externalConnection`. The initial credential travels **inline** — the
common path makes zero extra round-trips. `connection:use` is already enforced
before this point, so the external path inherits it. On run completion the
executor revokes the run's grants (best-effort).

### The refresh callback (stored, revocable grant)

The grant is a durable row (`connection_credential_grants`) the **worker** mints
and the **API** redeems — scoped to one `(execution, node, connection)`, expiring
with the run, revocable, and redemption-counted for an issuance audit trail. The
sidecar POSTs `{ token }` to `POST /api/internal/connection-credentials/refresh`
(public — the grant token IS the auth, like webhook triggers) and gets a freshly
re-materialised credential. The grant is minted only after `connection:use`
passed at dispatch, so the token alone is sufficient authorisation; the endpoint
re-resolves within the grant's own tenant/env scope.

A stored grant was chosen over a stateless signed token for explicit
per-credential revocation and a durable issuance audit trail, accepting a
hot-path write per external-node dispatch and a new table (cleaned up via the
`executions` FK cascade + expiry).

### The sidecar (`services/python-plugins`, `@ragdoll/plugin-py`)

The bridge maps the proto `connection` Struct onto `req.connection`; a plugin
reads `req.connection.credential` and, when it nears `expiresAt`, refreshes via
the grant with a small HTTP helper.

## Consequences

- A sidecar plugin uses a connection driver's credential without the driver's
  identity logic being re-implemented in Python; a long crawl refreshes the
  credential mid-run instead of dying on an expired token.
- No new trust boundary: credentials already crossed to the sidecar via
  `secrets`; this adds a new *source*, gated by an opt-in driver hook.
- Deployment knobs: `RAGDOLL_CONNECTION_CALLBACK_URL` (the API base URL as
  reachable by the sidecar/worker) turns the refresh path on; absent it, sidecar
  nodes still get the inline credential with no refresh. See the operations
  runbook.
- In-process plugins are unaffected — they keep reading the live
  `input.connection`.

## Verification

- `@ragdoll/connection-sdk`: hook runs / returns undefined / throws on unknown kind.
- `@ragdoll/plugin-sdk`: the transport serialises `externalConnection` into the
  proto `connection` field (real connect-rpc server stub), and sends nothing when
  the node has no connection.
- `@ragdoll/external-connections`: grant minting (expiry bounded by the run
  deadline), revocation, and redemption (unknown / revoked / expired /
  no-connection / not-materializable / ok).
- `@ragdoll/runtime`: end-to-end — an external node resolves → materialises →
  mints a grant → ships the envelope to a sidecar stub → revokes on finish; an
  external node without a connection triggers none of it.
- `@ragdoll/db`: `connection_credential_grants` repository (create / getByToken /
  recordRedemption / revokeForExecution / deleteExpired).
- Python sidecar: the bridge maps `connection`; the refresh helper redeems a grant.
