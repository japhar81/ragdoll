# ADR 0028: Kubernetes connection driver + completeness-aware list-pull

## Status

**Accepted + implemented** (Phase 3b). Adds the second telemetry-shaped
record-source (after Wazuh, ADR-0027), and the first one where the
*completeness signal* is the load-bearing output — not the items
themselves.

Companions:
- [ADR 0024 — Connection Drivers as Plugins](./0024-connection-drivers-as-plugins.md)
- [ADR 0027 — Wazuh driver + host/agent pull blocks](./0027-wazuh-driver.md)
  (sibling pattern; Wazuh has empty-inventory tolerance, k8s has
  completeness signalling — both are forms of "the API can return a
  weak result; the plugin labels it so downstream knows.")

## Context

Bulwark's append-only spine uses **delete-by-absence**: a pod absent
from a scan closes its `RUNS_ON` edge. That rule is only correct if
the scan is *whole*. A partial list — pagination expiry, a `410 Gone`
on a continue token, a timeout returning 80% of pods — looks identical
to mass deletion. If a partial reaches the close-by-absence logic
unflagged, placement history gets shredded.

So the list-pull block must tell bulwark, per scan:

- `complete: true` → "this is a consistent complete snapshot; absences
  are real."
- `complete: false` → "this is partial; trust nothing about absence
  on this batch."

That flag — not the items, not the resourceVersion — is the most
important thing this prompt ships.

## Decisions

### 1. `k8s` connection driver

`category: connection_driver`, `kind: k8s`. Shipped as a
`ConnectionDriverPlugin` (same loader path as every other driver).
Lives in `plugins/builtin-rag/src/k8s.ts`.

- **`configSchema`** — `apiServerUrl` (required, must include
  scheme), `insecureSkipTlsVerify` (default false; per-request, NOT
  process-wide), `caCert` (optional PEM for a pinned private CA),
  `requestTimeoutMs` (default 30s, applied per page).
- **`secretSchema`** — JSON `{"token":"..."}` (canonical) or raw
  string. **Token auth only** this phase; client-cert and OIDC are
  deferred to a follow-up.
- **`probe(client)`** — `GET /version` with the bearer. Cheapest
  call that exercises TLS + bearer + reachability. A 401 on a
  ServiceAccount-bound token usually means the SA was minted for a
  different cluster — exactly the operator hint we want to surface.
- **`acquire(resolved)`** — returns the cached handle; `requestTimeoutMs`
  and TLS posture travel ON the handle (the lister reads them per
  page). Cached per `connection.id`.
- **`dispose(client)`** — blanks the local token. No server-side
  logout for a SA bearer.

**TLS posture.** `insecureSkipTlsVerify: true` threads
`rejectUnauthorized: false` to undici's `Agent` PER REQUEST. The
operator who flips this for a kind / dev cluster doesn't poison
unrelated drivers in the same worker process — same per-request
isolation pattern used by the wazuh driver. A pinned `caCert` flows
through the same Agent's `connect.ca` so a private CA never has to be
installed system-wide.

**Token hygiene.** The bearer never appears in error messages or
logs; the driver-tests assert it.

### 2. `k8s_list_pull` — the completeness-aware lister

`category: datasource`, `contract: 2`,
`requires: [{ binding: "k8s", kind: "k8s" }]`. Walks the API server's
`?limit=N&continue=<token>` pagination contract for each configured
resource kind.

Config knobs (`config`):
- `resources` — built-in kinds (pods / nodes / namespaces /
  deployments / replicasets / statefulsets / daemonsets).
- `customResources` — CRDs via `{group, version, plural, kindLabel?}`.
- `namespace` — optional scope; rewrites the path to
  `/api/v1/namespaces/<ns>/<resource>` or the apis/ equivalent.
- `limit` — page size (default 500; kubectl's default).
- `maxPages` — runaway-guard cap; default 1000 (≈500k items at
  limit=500).

Per kind, emits a `K8sScan` envelope:

```ts
interface K8sScan {
  kind: string;                          // "Pod" / "Node" / "Deployment" / CRD label
  items: Array<Record<string, unknown>>; // server response items
  resourceVersion: string | null;        // page 1's RV (head of snapshot)
  complete: boolean;                     // THE flag
  reason?: string;                       // machine-readable when complete:false
  detail?: string;                       // short human-readable (never the token)
  pagesFetched: number;
  remainingItemCountAtPartial?: number;  // server hint, diagnostic only
}
```

**Completeness rule (the rule everything else exists for).** A scan
is `complete: true` IF AND ONLY IF every page of the paginated
sequence succeeded and the snapshot held to the end. The plugin
flips to `complete: false` (with a short machine-readable `reason`)
when:

| Reason | Trigger |
|---|---|
| `continue_410_gone` | A page returned `410 Gone` — the API server GC'd the snapshot mid-pagination. **The most important branch in this module.** |
| `page_status_<N>` | Any other non-2xx mid-pagination. |
| `non_json_body` | Server returned 200 but the body didn't parse (e.g. an nginx 502 page from a misbehaving proxy). |
| `timeout` | The per-page wall-clock cap fired. |
| `page_fetch_error` | The fetch threw for any other reason. |
| `max_pages` | The runaway-guard cap fired before draining the continue chain. |

**Critically: items collected before the failure are still emitted.**
Bulwark needs them — the `complete: false` flag is the gate on
absence-based mutation, NOT on the items themselves. A partial scan
labelled honestly is more useful than no scan at all.

**Never silently restart on 410.** A naive lister might re-list from
scratch when its continue token GC's. We do NOT — that would produce
a "frankenscan" stitching items from two different snapshots, which
bulwark's diff cannot tell apart from a real change. The right
posture is: emit what we have, flag `complete: false`, let bulwark's
pipeline decide whether to schedule a fresh full pull at the next
tick.

### 3. No watch / streaming

Watch + bookmark + reconnect adds substantial complexity (RV drift,
expired RVs, bookmark intervals, channel cleanup) that bulwark has
said it does not want this phase. Frequent list-poll with the
completeness signal is the correct shape for placement capture:

- Placement (Pod-on-Node) changes on Pod create / delete / move —
  events the next list-poll catches naturally.
- The 410-as-completeness-failure pattern is exactly the right
  signal to bubble to bulwark's diff. With watch, the equivalent
  scenario (`watch closed: 410 gone`, RV resync needed) becomes an
  internal reconnect dance bulwark would have to mirror.

If a future phase needs lower latency, watch can be added BESIDE
list-pull; nothing in the current contract precludes it.

### 4. Reuse, don't rebuild

The `transform` plugin (operator authors the k8s → observation
mapping as JSONata / JMESPath config) and `neo4j_write` (the
idempotent batched MERGE block from ADR-0025) are NOT rebuilt by
this pass. Bulwark composes them around `k8s_list_pull`. RAGdoll's
contribution stops at the labelled scan.

### 5. Scope boundary

Driver + lister ONLY. No diff, no resolution, no retention, no
windowing, no pipeline definitions, no mapping logic, no schedules.
**No standing up of any store.** The k8s → observation translation
is bulwark's pipeline-config concern; the append-only diff is
bulwark's resolution-adjacent logic.

## Verification

- **Driver unit tests** (`plugins/builtin-rag/test/k8s.test.ts`):
  parseK8sSecret across formats, buildK8sApiServerUrl rejects bad
  inputs, every authenticated GET carries the bearer, probe →
  `/version` and surfaces non-2xx, insecureSkipTlsVerify threads
  per-request, caCert plumbed through, no-token-in-error-messages
  guard, acquireClient caches per `connection.id`.
- **Lister unit tests** (same file): clean pagination →
  `complete:true` + RV from page 1, **410 mid-pagination →
  `complete:false` + reason continue_410_gone + items so far
  preserved** (the critical test), non-2xx → page_status_<N>,
  non-JSON body, maxPages cap, namespace-scope path rewrites for both
  `/api/v1/` and `/apis/<group>/<version>/`, customResources →
  `/apis/<group>/<version>/<plural>`, unknown built-in name → loud
  error, empty config → loud error.
- **Stub-run integration tests**
  (`plugins/builtin-rag/test/k8s-stub-pipeline.test.ts`):
  - Clean pull → shape → write end-to-end. `scan.complete=true`
    rides every row. resourceVersion preserved per kind.
  - Forced 410 mid-pagination on pods, clean nodes pull. Both
    scans flow to write. Pod rows carry `scanComplete=false`;
    Node rows carry `scanComplete=true`. The independence of per-
    kind scans is part of the contract — a flaky CRD doesn't
    pollute the Pod scan.

## Consequences

- RAGdoll grows its first **completeness-flag-emitting** plugin.
  The pattern (driver owns auth + TLS posture, lister owns
  pagination + completeness + per-page error labelling) is reusable
  for any future record-source with a snapshot contract that can
  expire mid-pull (Elastic scroll, S3 list-objects-v2 + continuation
  token, …).
- Bulwark gets the signal it needs to keep delete-by-absence safe.
  When `complete:true`, absences may close edges; when
  `complete:false`, the batch is ingested for presence but absence
  doesn't fire.
- Future telemetry sources should ship the same shape: emit items
  *and* a completeness label. Naming a partial result as if it
  were whole is the failure mode this whole module exists to
  prevent.

## References

- Kubernetes API server pagination + consistency rules —
  https://kubernetes.io/docs/reference/using-api/api-concepts/#retrieving-large-results-sets-in-chunks
- ADR-0024 connection drivers as plugins
- ADR-0027 Wazuh driver (sibling telemetry-source pattern)
