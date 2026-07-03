# Platform plugins (global lifecycle hooks)

Platform plugins are **global, engine-style** plugins (not draggable pipeline
nodes) that run arbitrary code on platform lifecycle events — the 72 audited
mutations + the pipeline run lifecycle + usage — in two phases:

- **`on(event)`** — POST: observe (durable, at-least-once, isolated).
- **`before(event)`** — PRE: intercept — `continue | mutate | deny | fail`.

See [ADR 0036](../adr/0036-platform-plugins.md). Two ways to hook in:

## 1. Webhooks (no code, per-tenant)

`POST /api/event-subscriptions` (needs `config:edit_tenant`):

```json
{ "events": ["secret.*", "execution.failure"], "url": "https://me/hook", "secret": "shhh" }
```

Every matching `post` event is POSTed to `url`, signed
`X-Ragdoll-Signature: sha256=<HMAC-SHA256(secret, body)>`. Scoped to your
tenant. `events` are globs: `"*"`, `"secret.*"`, `"execution.finish"`.

## 2. In-process plugin (operator, can veto/mutate)

Ship a module and point `RAGDOLL_PLATFORM_PLUGINS` at it (comma-list of
package names or paths — imported once at boot, like the identity/authz
providers).

```ts
import type { PlatformPlugin } from "@ragdoll/platform-plugins";

const plugin: PlatformPlugin = {
  name: "block-friday-deploys",
  subscriptions: [{ events: ["pipeline.deploy", "execution.*"], phases: ["pre", "post"] }],
  meta: { failurePolicy: "closed", timeoutMs: 500 },

  // POST — observe (runs in the worker; durable; failures isolated)
  async on(event) {
    if (event.event === "execution.failure") await alertSlack(event);
  },

  // PRE — intercept (veto / mutate / force-fail)
  async before(event) {
    if (event.event === "pipeline.deploy" && isFriday())
      return { action: "deny", reason: "no Friday deploys", status: 423 };
    if (event.event === "execution.start")
      return { action: "mutate", patch: { input: redact(event.input) } };
    if (event.event === "execution.finish" && hasPII(event.output))
      return { action: "fail", reason: "PII in output" };
    return { action: "continue" };
  }
};
export default plugin; // or PlatformPlugin[], or (registry) => void
```

### The event catalog

- **Mutations** (72): `secret.*`, `pipeline.deploy`, `user.grant`, … — pre
  (veto) + post. Emitted by `audit()`.
- **Execution lifecycle**: `execution.accept` (API 4xx gate) → `execution.start`
  (pre: veto / mutate input) → `execution.finish` (pre: mutate output /
  force-fail) → `execution.success` / `execution.failure` / `denied` /
  `cancelled` (post).
- **Usage**: `usage.recorded` (post).

`event.correlationId` is stable across the pre/post of one operation.

### Semantics

- **Post** runs in the worker off the API request path; durable
  (at-least-once via the `ragdoll.events` JetStream stream); a broken hook is
  logged, never rethrown. Make handlers idempotent.
- **Pre** runs synchronously and inline; priority-ordered (`meta.priority`);
  per-hook `meta.timeoutMs`; a hook error/timeout follows `meta.failurePolicy`
  (`open` → continue, `closed` → deny). A `deny`/`fail` short-circuits; a
  `mutate` composes into the next hook (only catalog-allowed fields apply).
- In-process modules are **operator-trust** (boot-imported, not runtime-
  fetched); webhooks are the per-tenant-safe tier.
