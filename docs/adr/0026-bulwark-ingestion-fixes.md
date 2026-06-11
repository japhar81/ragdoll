# ADR 0026: Bulwark ingestion blockers — secret resolution, cartography
sidecar move, secret_ref column rename, archive-aware slug uniqueness,
server-side binding-kind validation

## Status

**Accepted + implemented**. Five independent fixes shipped together
because they were all surfaced by bulwark's first real run against
RAGdoll's ingestion substrate (ADR-0005); each is also useful in
isolation.

Companions:
- [ADR 0023 — Unified Connections Registry](./0023-unified-connections-registry.md)
- [ADR 0024 — Connection Drivers as Plugins](./0024-connection-drivers-as-plugins.md)
- [ADR 0025 — Neo4j driver + property-graph plugins](./0025-neo4j-driver.md)

## Context

bulwark drives RAGdoll as its ingestion substrate. After provisioning a
tenant, nested folders, a pipeline, schedules, connections (+ secret),
datasets (+ versions + per-pipeline bindings), and a deployment, the
first end-to-end run reached the read node and failed five different
ways. None of the failures were bulwark-side workarounds.

## Decisions

### #1 — Resolve dataset-binding connection secrets at execution

**Problem.** `packages/runtime/src/dataset-resolver.ts` constructed each
binding's `connection` object with `secret: undefined` and a comment
"resolved at acquireClient time, not here". But `acquireClient`
(packages/external-connections/src/index.ts) never had a SecretProvider
to resolve. Credentialed drivers (neo4j, postgres, mongo, ClickHouse)
saw `secret: undefined` and failed auth at the driver — even though
`/api/connections/:id/probe` on the same connection returned `ok` (the
probe handler resolved the secret itself).

**Fix.** Add `secrets?: SecretProvider` to `DatasetResolverDeps`. The
resolver does the same `secretProvider.get({scope, tenantId, key})`
hop the probe sweep does, and attaches the resolved credential to the
binding's connection envelope. Both `buildDatasetResolver` callers
(`apps/api/src/app/pipeline-execution.ts` + `apps/worker/src/handlers.ts`)
pass `deps.secretProvider`. The pre-fix code path stays — if `deps.secrets`
isn't set, the binding still resolves but with `secret: undefined`, so
no-auth drivers keep working and credentialed drivers raise their own
"missing creds" error.

Cache invalidation note: `acquireClient`'s client cache still keys on
`connection.id`. Operators should call `closeClient(id)` after rotating
a secret OR after changing the connection row — same as before.

### #2 — `cartography_crawl` runs in the python-plugins sidecar

**Problem.** The Node `cartography_crawl` plugin shelled out to the
`cartography` binary. Worker images don't have it on PATH (and
bundling cartography + every future heavy tool into the worker is the
wrong direction). The Node-side error handler also swallowed
`spawn ENOENT` — the node reported succeeded with per-module
`status: "failed"`, so downstream nodes ran against an unpopulated
graph and the operator saw a confusing trace.

**Fix.** Move the handler into the python-plugins service
(`services/python-plugins/app/plugins/cartography_crawl_plugin.py`).
Cartography is a Python tool — it lives where the deps live,
the worker stays lean, and new heavy tools follow the same pattern
instead of growing the worker image.

- TS side keeps the manifest (`plugins/builtin-rag/src/cartography.ts`)
  so the catalog / UI / spec validator still pick it up.
- Plugin-loader registers it as `mode: "external"` pointing at
  `process.env.PYTHON_PLUGIN_URL`. Without that env var unset, the
  plugin isn't registered — same gate that controls `crawl4ai_crawler`
  and `scrapy_spider`.
- Handler raises `ValueError` on any failure (binary missing,
  non-zero exit, timeout) so the runtime surfaces the failure on the
  execution trace instead of reporting succeeded-with-failed-modules.
- `cartography` added to `services/python-plugins/pyproject.toml`;
  `poetry.lock` regenerated.

ADR-0022 (plugin-as-service) already pointed this direction; this is
the first heavy tool that follows it instead of bundling.

### #3 — `connections.secret_ref_id` (uuid) → `secret_ref_key` (text)

**Problem.** The column was declared `uuid`, but the runtime resolved
the value via `SecretRepository.find` matching `WHERE logical_key = $1`.
Forcing operators to put a UUID into `secret_refs.logical_key` (and the
same UUID into `connections.secret_ref_id`) was a contract lie — the
column name said "id" but the resolution semantics were "key".

**Fix.** Migration 022 renames the column to `secret_ref_key` and
changes its type to `text`. TS field `secretRefId` → `secretRefKey`
across types, repos, API routes, web client, web UI form, plugins,
OpenAPI spec, and seeds. Encrypted-secret internals
(`encrypted_secrets.secret_ref_id` → `secret_refs.id`) are unrelated and
stay `uuid`.

### #4 — Partial-unique slug indexes must exclude archived rows

**Problem.** The `connections_slug_global` / `connections_slug_tenant` /
`connections_slug_environment` partial unique indexes didn't include
`AND archived_at IS NULL`. After a soft-archive
(`DELETE /api/connections/:id` without `?force`), the slug stayed
reserved forever; re-creating with the same slug failed
`409 duplicate key`. Same shape on `datasets_slug_*`.

**Fix.** Migration 022 drops the indexes and recreates them with the
archive-aware predicate, for both `connections` and `datasets`. The
in-memory `InMemoryConnectionRepository.create` /
`InMemoryDatasetRepository.create` got the same fix to keep the
test-harness invariant in sync with the SQL.

### #5 — Server-side `/validate` catches dataset-binding kind mismatch

**Problem.** The Builder ran `validatePipelineSpec(spec, registry,
datasetIndex)` with a per-slug binding index — so it could flag "node
X requires binding Y backed by neo4j, but dataset Z has it wired to a
different kind." The API routes (`POST /api/pipelines/validate` and
`GET /api/pipelines/:id/validation`) called `validatePipelineSpec`
WITHOUT the index, so the rule silently skipped. A provisioning script
calling the API saw `valid: true`, the run started, the worker
re-validated against the real registry, and the failure surfaced as
"auth failed at the driver." Bulwark's first run hit this exactly.

**Fix.** Both routes now build the binding index from the caller's
visible datasets + connections (cascade-resolved via `tenantScope`)
and pass it to the validator. The same `dataset_binding_kind_mismatch`
error code the Builder lights canvas badges from is returned over the
wire.

While here: fixed a Builder bug that was the inverse of the server gap
— the Builder put the connection SLUG into `connectionKind`, so
human-named slugs like `bulwark-wg` (kind=neo4j) registered false-
positive mismatches against `kindOneOf=[neo4j]`. The Builder now loads
the connections catalog alongside the datasets and resolves slug → kind
properly.

## Migration

Migration 022 in `packages/db/migrations/` covers #3 and #4 in a single
transaction. The TS rename is in the same commit. No data backfill —
existing UUID values in `secret_ref_id` cast cleanly to text and
continue to resolve through `SecretProvider.get({key: <uuid-as-text>})`.

Operators upgrading from a pre-022 schema where archived connections
held a slug ghost will find the slug becomes reusable as soon as
migration 022 runs (the new partial index doesn't match the archived
rows).
