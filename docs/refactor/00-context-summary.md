# 00 — Context Summary

State of `main` at `ca776cf` as the starting point for
`refactor/datasets-rbac-retrieval`. Captured by reading the docs and
code paths listed in the refactor plan's non-negotiable #4. Numbers
(line counts, call-site counts) reflect that revision.

## 1. Casbin policy schema (today)

**Where it lives:** `packages/authz/src/index.ts` (`Authorizer`,
`BuiltinPolicyEngine`) and `packages/authz/src/casbin.ts` (the
lazy-loaded production engine). Conformance pinned by
`packages/authz/test/casbin-conformance.test.ts`.

**Scope strings** (`scopeToString`, line 149):

- `*` — global / platform
- `t/<tenantId>` — tenant
- `t/<tenantId>/e/<environment>` — environment within a tenant
- `t/<tenantId>/p/<pipelineId>` — pipeline within a tenant

`scopeCovers(grant, request)` implements ancestor-covers-descendant
(`*` covers everything, `t/T` covers `t/T/e/...` and `t/T/p/...`,
exact match always). Environment and pipeline scopes are *siblings*
under a tenant — neither covers the other.

**Casbin model** (`authz/index.ts:282`):

```
r = sub, dom, obj                    // principal, scope, permission
p = sub, obj                         // role, permission
g = _, _, _                          // principal, role, scope
m = g(r.sub, p.sub, r.dom) && (p.obj == r.obj || p.obj == "*")
```

Permissions in the catalog (a representative slice from seed +
tests):

```
config:edit_global  config:edit_tenant  config:edit_pipeline
pipeline:create     pipeline:update     pipeline:delete
pipeline:run        pipeline:deploy
execution:view_logs audit:view          usage:view
user:manage         role:manage         idp:manage
auth:settings       secret:manage_tenant
```

DB tables (migration `005_rbac_identity` / `migrations/002_auth.sql`):
`rbac_grants(user_id, role, scope)`, `rbac_role_permissions(role,
permission)`, the role catalog, plus the identity tables. The grant
store is the source of truth; the policy engine reloads on
`Authorizer.invalidate()` calls (instant revoke).

**Hot path:** the API constructs a `principal.authorize` *synchronous*
decision closure per request (`app.ts:3542`). All ~92 enforce sites
call `enforce(principal, permission, scope)` and remain synchronous —
that's an explicit constraint from ADR 0011 and we keep it.

## 2. API key story (today — fuller than the plan implied)

API keys already exist as first-class credentials with a clean shape;
they're not "absent" so much as **under-scoped and under-documented**.

**Table** (`migrations/002_auth.sql`):

```
api_keys(
  id            uuid PK,
  tenant_id     uuid NULL,           -- nullable = platform-scope
  principal_id  uuid NOT NULL,       -- owner
  name          text NOT NULL,
  prefix        text NOT NULL UNIQUE,-- 12-hex lookup key
  hash          text NOT NULL,       -- sha256(plaintext) HMAC-checked
  roles         text[] NOT NULL,     -- carried verbatim onto principal
  created_at, last_used_at, revoked_at
)
```

**Format:** `rgd_<6-byte-hex-prefix>_<24-byte-hex-secret>`. The prefix
is the lookup index; the full key is HMAC-compared in constant time.

**Mint / verify** lives in `packages/auth/src/index.ts:228-283`. CRUD
routes are in `apps/api/src/app.ts` (mint, list, revoke under the
profile-API-keys endpoints — tested by `profile-apikeys.test.ts`).

**Gaps the refactor will close (Phase 3, deferred this session):**

- No environment scope. A key is tied to (at most) one tenant; it
  carries `roles[]` but the request scope is whatever the route
  passes to `enforce`. Effective env scoping today is "only via the
  role grants on the owner that the key copies."
- `roles` are a static snapshot at mint time, not the
  intersection-at-request-time semantics the plan calls for.
- No "scope down" UX — mint takes the owner's roles wholesale.
- No expiration column.
- Format reveals nothing about scope (this is fine — see decision
  recorded for Phase 3 below).

## 3. Plugin contract surface (today)

**Where it lives:** `packages/plugin-sdk/src/index.ts`.

```ts
type InProcessPlugin = {
  manifest: PluginManifest;
  execute(input: PluginExecutionInput): Promise<PluginExecutionOutput>;
  healthCheck?(): Promise<{ ok: boolean }>;
};

type PluginExecutionInput = {
  context: RuntimeContext;        // tenantId, pipelineId, executionId,
                                  // environment, resolvedConfig, deadline,
                                  // signal, actor
  node:    { plugin, id, config, secrets };
  inputs:  Record<string, unknown>;       // routed by port if declared
  config:  Record<string, unknown>;       // resolved values
  secrets: Record<string, unknown>;       // resolved values
  runSubgraph?: (spec, input) => …;       // for/foreach/while
  ingestStateStore?: …;                   // delta-filter etc.
};

type PluginExecutionOutput = {
  outputs: Record<string, unknown>;       // keys = output port names
  metadata?, usage?, artifacts?
};
```

External (HTTP / Python sidecar) plugins use the same contract over
the v1 wire body in `buildExternalRequestBody`.

**Discovery:** `packages/plugin-loader/src/index.ts` scans
`Object.values()` of the `plugins/builtin-rag` and `plugins/sample-text`
module namespaces and duck-types each export. Plugins are keyed
`category:id:version`.

**Crucial observation for Phase 4-7:** plugins reach storage by
calling `createVectorStore({ url?, apiKey? })` directly and pulling
`config.collection` (or `config.index`) from the node config. Nothing
in the plugin contract abstracts the underlying collection — every
plugin currently knows the collection name. This is the surface the
Dataset abstraction has to wrap.

## 4. Storage adapter interfaces (today)

**Vector layer** (`packages/vector/src/index.ts`):

```ts
interface VectorStore {
  ensureCollection(name, config): Promise<void>;
  upsert(collection, points: VectorPoint[]): Promise<void>;
  query(collection, vector, opts): Promise<QueryResult[]>;
  delete(collection, ids[]): Promise<void>;
}
createVectorStore({ url?, apiKey? }) => QdrantVectorStore | InMemoryVectorStore
```

QdrantVectorStore is the prod implementation; InMemoryVectorStore is
the test/offline fallback (auto-picked when `QDRANT_URL` is unset).

**Keyword / hybrid layer** (`packages/opensearch/`):

OpenSearchVectorStore implements the same `VectorStore` interface for
kNN queries. BM25 + hybrid retrievers live in `plugins/builtin-rag`
and call OpenSearchClient directly (no abstraction over the index
name).

**Collection-naming helper** (`packages/core/src/index.ts:310`):

```
rag_<env>_<tenant_slug>_<pipeline_slug>_<embedding_profile_hash>
```

NOT actually used by any plugin or the runtime today. Collection
names are whatever the spec author puts in `node.config.collection` or
`vector.collection` resolved config. The helper exists as a "this is
the convention" anchor for when a Dataset abstraction starts owning
this name composition.

**No schema enforcement anywhere.** `VectorPoint.payload` is
`Record<string, unknown>`. Bulk-indexers and retrievers assume
payload shape but fail silently when fields are absent.

## 5. Pipeline spec shape (today)

**Where it lives:** `packages/core/src/index.ts` (types) +
`packages/pipeline-spec/src/index.ts` (validation, layout, staging,
yaml).

```ts
interface PipelineSpec {
  apiVersion: "rag-platform/v1";
  kind: "Pipeline";
  metadata: {
    name; description?; labels?; annotations?;
    stages?: PipelineStage[];               // builder-only
  };
  spec: {
    parameters?: ConfigDefinition[];
    nodes: PipelineNode[];                  // { id, type|plugin, config, secrets, ui }
    edges: PipelineEdge[];                  // { from, to, fromPort?, toPort? }
  };
}
```

`validatePipelineSpec` (line 141) reports missing names, duplicates,
unknown plugin refs, missing edge endpoints, cycles, and unknown port
names (warnings). It does NOT validate dataset references — there are
none yet.

`autoLayoutSpec` + `autoStageSpec` are pure helpers we just landed
(commit `a199c23`). They no-op when `ui.position` / `metadata.stages`
are already populated.

## 6. ChangeBus / events

**Where it lives:** `packages/events/src/index.ts`. Used by
`apps/api/src/websocket.ts` to fan out to connected clients via
in-process pub/sub (Redis pub/sub mirrors it across replicas when
configured).

**Subscription filtering** (`websocket.ts:126`):

```ts
function canSee(conn, event) {
  if (conn.seesGlobal) return true;
  if (event.tenantId === null) return false;
  return conn.tenants.has(event.tenantId);
}
```

Filtering is **tenant-coarse**, not permission-fine. A `viewer` on
tenant A sees every `pipeline.update` / `secret.change` event for
that tenant. The payload is upstream-redacted (no raw secrets), but
the *metadata of who changed what* is visible. Phase 2 will tighten
this with a per-event permission check at fan-out time.

## 7. Enforcement coverage (today)

Counted at `app.ts@ca776cf`:

| Layer            | Mechanism                          | Status                                    |
| ---------------- | ---------------------------------- | ----------------------------------------- |
| REST API         | 92 explicit `enforce()` call sites | Comprehensive on paper; verify in Phase 1 |
| WebSocket open   | Auth-after-open `{type:"auth", …}` | Covered                                   |
| WebSocket events | `canSee` tenant filter             | **Coarse** — Phase 2 tightens             |
| MCP tools        | Re-enter `app.handle(...)`         | Covered transitively by REST `enforce`    |
| CLI              | Bearer / API key against REST      | Covered transitively                      |
| Webhook trigger  | Static signed token, no `enforce`  | By design (ADR 0012)                      |
| Worker handlers  | None                               | **Gap** — no re-check on dequeue          |
| Scheduler        | Authorized at create, runs trusted | **Gap** — no re-check at fire             |
| Runtime / DAG    | None                               | **Gap** — no per-plugin resource check    |

The three gaps at the bottom are the meat of Phase 2.

## 8. Open questions

Items I couldn't resolve from reading; each is "decide as we get
there" unless flagged for the user.

1. **Job-payload integrity.** Worker handlers trust the job payload
   verbatim. Should we sign job payloads at enqueue and verify at
   dequeue? The current threat model (worker shares the DB pool with
   the API) probably doesn't justify it, but it'd come up under a
   stricter least-privilege review. **Provisionally: defer** — call it
   out in `01-rbac-audit.md` and move on.
2. **Per-event WebSocket permission filtering.** Going from
   tenant-coarse to permission-fine requires either (a) carrying the
   required-permission on the event itself, or (b) re-resolving the
   subscriber's grants and the event's resource scope at fan-out
   time. (b) is correct; we'll do it in Phase 2.
3. **Scheduler identity.** When a cron fires, whose grants should the
   resulting run be checked against — the schedule creator's at
   create time, or "live" at fire time? Right now there's no check.
   Phase 2 picks "creator's grants at fire time" (so revoked users
   can't keep firing pipelines via schedules they made).
4. **Worker-time RBAC re-check failure mode.** If the enqueueing
   principal lost permission between enqueue and dequeue, do we (a)
   fail the job loudly (visible in execution history) or (b) silently
   drop it? Phase 2 picks (a) with `status: "denied"`.
5. **MCP tool granularity.** MCP tools dispatch to REST in-process,
   so REST `enforce` covers them. But there's no "MCP-specific"
   permission layer — a principal who can `pipeline:update` via REST
   can do the same via MCP. The plan calls for MCP tool-level
   enforcement; in practice this means auditing each tool and
   asserting it's a REST call whose `enforce` we trust. No new code,
   just a verification pass. Phase 2.
6. **Plan decisions banked for later phases:**
   - **API key format:** keep the existing `rgd_<prefix>_<secret>`
     opaque shape; do NOT bake tenant/env slugs into the key (avoids
     leaking org structure if a key ends up in a log). Phase 3 adds
     `environment_id` and `permissions` columns to the existing
     table.
   - **Dataset migration:** 1-to-1 auto-synthesize a Dataset per
     existing collection-owning pipeline; ship a "merge datasets"
     CLI/UI to consolidate post-migration (per the user-chosen
     option). Phase 4.

## 9. What this branch will and won't touch

In scope this session (Phase 0-2 only): branch + this summary; RBAC
audit doc + failing baseline tests; the unified enforcement helper +
the three worker/scheduler/runtime gaps + per-event WebSocket
filtering. Then stop for review.

NOT in scope this session: Datasets, plugin contract v2, storage
refactor, retrieval plugins, sample migrations, UI work, dev-auth
removal, docs/ADRs, infra. Phase 3+.
