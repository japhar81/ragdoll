# Datasource connections + dataset bindings

This doc covers the operator-facing model for **how a pipeline knows where to read and write**. There are three layers — keep them straight and the rest follows.

## The three layers

```
                      ┌────────────────────────────┐
                      │ Plugin (qdrant_vector_store)│
                      │   requires: [{vector, qdrant}]│
                      └──────────────┬─────────────┘
                                     │ no host/url config — just declares what it needs
                                     ▼
                ┌────────────────────────────────────┐
                │ Dataset (slug: "docs")             │
                │   backends.vector = {              │
                │     provider: "qdrant",            │
                │     connectionName: "qdrant-main", │
                │     collection: "docs_v1"          │
                │   }                                │
                └──────────────┬─────────────────────┘
                               │ pinned per (tenant, env) by the runtime
                               ▼
        ┌───────────────────────────────────────────────┐
        │ Connection (name: "qdrant-main")              │
        │   tenant=NULL, env=NULL  → host: shared       │
        │   tenant=A,    env=NULL  → host: a.example    │
        │   tenant=B,    env=prod  → host: b-prod.example│
        └───────────────────────────────────────────────┘
```

**Plugin** — declares the shape of dataset it needs (modality + optional provider) via `requires` in its manifest. Knows NOTHING about hosts, ports, URLs. The runtime hard-fails before the plugin runs if no connection resolves.

**Dataset** — operator-defined logical corpus. Per-modality backend blocks carry the provider, the index/collection name, and a `connectionName` pointer. The dataset is referenced by `{slug, alias}` from pipeline specs; the runtime walks env→tenant→global to pick the actual row. Per-(pipeline, tenant, env) **binding overrides** can pin a specific physical row for one pipeline-on-this-scope.

**Connection** — per-(tenant, env) host + credentials. Globals (tenant=NULL) act as cluster-wide defaults that tenants inherit. Cascade:

```
(tenant=T, env=E)        env-specific match (tier 3)
   ↓ no match
(tenant=T, env=NULL)     tenant-wide override (tier 2)
   ↓ no match
(tenant=NULL, env=NULL)  global default (tier 1)
   ↓ no match
   missing connection — plugin throws preflight
```

## Plugin contract: `requires`

Every storage-touching plugin's manifest declares what it needs:

```typescript
{
  id: "qdrant_vector_store",
  contract: 2,
  requires: [
    { modality: "vector", provider: "qdrant" }
  ],
  configSchema: {
    // NO host/url/endpoint here. Per-call knobs only.
    properties: {
      collection: { type: "string" },
      distance: { type: "string", enum: ["cosine", "dot", "euclidean"] },
      dimensions: { type: "integer" }
    }
  }
}
```

Hybrid plugins list every slot they need:

```typescript
requires: [
  { modality: "vector", provider: "opensearch" },
  { modality: "text",   provider: "opensearch" }
]
```

Validation happens twice:

- **At edit time** (Builder): the spec validator checks the bound dataset's modalities and provider against the plugin's `requires`. Mismatches surface as `dataset_modality_mismatch` and `dataset_provider_mismatch` — Run / Deploy are blocked until fixed.
- **At execute time** (worker): if the resolved dataset's `backends[modality].connection` doesn't exist, the plugin throws a preflight error pointing at the offending dataset slug. The execution row is marked `failed` before any work runs.

## Connection cascade

Connections live in `datasource_connections`. The resolver walks three tiers, picking the most-specific match for `(tenant T, env E, name N)`:

| Tier | Row shape                                  | Use case                              |
| ---- | ------------------------------------------ | ------------------------------------- |
| 3    | `tenant_id=T, environment_id=E, name=N`    | Per-env override for tenant T         |
| 2    | `tenant_id=T, environment_id=NULL, name=N` | Tenant-wide override (all envs)       |
| 1    | `tenant_id=NULL, environment_id=NULL, name=N` | Cluster-wide default for every tenant |

Globals require `config:edit_global`; tenant rows require `dataset:admin` on the tenant.

### Example

Tenant A has one OpenSearch cluster shared across envs; Tenant B has three (one per env):

```
Connections:
  name=os, tenant=NULL, env=NULL    → host: dev-default.example   # safety net
  name=os, tenant=A, env=NULL        → host: os.tenantA.example   # tenant-wide
  name=os, tenant=B, env=dev         → host: os-dev.tenantB.example
  name=os, tenant=B, env=prod        → host: os-prod.tenantB.example
  name=os, tenant=B, env=qa          → host: os-qa.tenantB.example
```

The pipeline spec just says `dataset: {slug: "docs", alias: "stable"}` and the dataset's `backends.text.connectionName = "os"`. Each tenant resolves "os" to their own cluster — no spec change, no per-tenant dataset copies.

## Dataset binding overrides

Per-(pipeline, tenant, env) overrides live in `pipeline_dataset_bindings`. They beat the default slug cascade when present:

```
For each `dataset: {slug: S}` in pipeline P running as (tenant T, env E):
  1. pipeline_dataset_bindings (P, T, E, S)        → use that target dataset row
  2. pipeline_dataset_bindings (P, T, NULL, S)     → use that target row (all envs)
  3. datasets.resolveSlug(S, T, E)                 → default env→tenant→global cascade
```

Common use case: "Tenant B's prod pipeline writes to a schema-v2 dataset; everything else stays on v1." Create one binding row pinning slug `docs` → dataset `docs-v2-tenantB` for (pipeline=ingest, tenant=B, env=prod). No spec change.

Manage via the Datasets screen's "Binding overrides targeting this dataset" section, or the per-pipeline bindings API:

```
GET    /api/pipelines/:id/dataset-bindings
POST   /api/pipelines/:id/dataset-bindings
PATCH  /api/dataset-bindings/:id   { targetDatasetId? }
DELETE /api/dataset-bindings/:id
```

## CRUD APIs

### Connections

| Verb   | Path                                | Notes                                                   |
| ------ | ----------------------------------- | ------------------------------------------------------- |
| GET    | `/api/connections`                  | with `x-tenant-id`: tenant + inherited globals; without: globals only (admin) |
| GET    | `/api/connections/:id`              | single row                                              |
| POST   | `/api/connections`                  | `{ tenantId, environmentId?, name, datasourceType, config, secretRefId? }` — pass `tenantId: null` for a global row |
| PATCH  | `/api/connections/:id`              | partial update                                          |
| DELETE | `/api/connections/:id`              | hard delete                                             |
| GET    | `/api/connections/resolve/:name`    | diagnostic — returns `{ resolved, reason }` where reason is `env_specific`, `tenant_fallback`, or `no_match` |

### Bindings

| Verb   | Path                                          | Notes                                                |
| ------ | --------------------------------------------- | ---------------------------------------------------- |
| GET    | `/api/pipelines/:id/dataset-bindings`         | all binding rows for a pipeline                      |
| POST   | `/api/pipelines/:id/dataset-bindings`         | `{ tenantId, environmentId?, sourceSlug, targetDatasetId }` |
| PATCH  | `/api/dataset-bindings/:id`                   | retarget (`targetDatasetId` only)                    |
| DELETE | `/api/dataset-bindings/:id`                   |                                                      |

### Supported `datasourceType`

`opensearch`, `qdrant`, `dgraph`, `pgvector`, `postgres`, `redis`. Adding a new type means adding a backend in the resolver + a plugin that knows how to consume it.

## Dataset namespace policy

A dataset's `backends.<modality>` block accepts an optional `namespace`
field that controls how the collection / index / predicate name is
**isolated across tenants and environments at resolve-time**. The base
collection name lives on the dataset version
(`dataset_versions.backend_collections.<modality>`); the resolver
appends a deterministic, sanitised suffix before any plugin sees it.
Plugins read the effective name from `ResolvedDataset.backendCollections`
unchanged — no plugin changes are required to adopt this.

### Why on the dataset, not the connection

The connection is a pure host + credential abstraction. A single
OpenSearch / Qdrant / Dgraph cluster legitimately hosts both shared
org-wide indices (e.g. a reference taxonomy every tenant reads from)
and per-tenant indices (e.g. each tenant's own knowledge base) — anchoring
the policy on the dataset lets each dataset pick its own isolation level
without forking the connection.

### The matrix

| Dataset scope | `shared` | `by-tenant` | `by-tenant-env` | `by-env` |
| ------------- | :------: | :---------: | :-------------: | :------: |
| global        |    ✓     |     ✓       |        ✓        |    —     |
| tenant        |    ✓     |     —       |        —        |    ✓     |
| environment   |    ✓     |     —       |        —        |    —     |

Reasoning:

- **Tenant-scope** rows already pin a tenant on the row itself, so
  `by-tenant` would add nothing. `by-env` is meaningful and supported.
- **Environment-scope** rows already pin both, so any non-`shared`
  policy is a no-op — the validator rejects it at the API to keep the
  data model honest.
- **Missing / undefined** policy ALWAYS resolves to `shared` so legacy
  rows written before this field existed keep their old behaviour
  exactly.

### Suffix rules

```
shared          → <base>
by-tenant       → <base>_<sanitised(tenantSlug)>
by-tenant-env   → <base>_<sanitised(tenantSlug)>_<sanitised(envName)>
by-env          → <base>_<sanitised(envName)>
```

The sanitiser lowercases, collapses any non-alphanumeric to `_`, and
deduplicates runs — so `Tenant-A` becomes `tenant_a` in the suffix and
the result is safe to use as an OpenSearch index name, a Qdrant
collection, or a Dgraph predicate prefix.

If the resolver can't get the required context (e.g. a cluster-admin
tool calls `resolve()` without a `tenantId` on a `by-tenant` dataset),
it degrades silently to the base name — preserving the dataset's
inspectability without fabricating a fake suffix. **This is not a
loophole** for plugins: every real plugin execution flows through the
runtime with a wired tenant/env context.

### Setting the policy

UI: Datasets → pick a dataset → "Backend namespace policy" disclosure
under "Modalities + backends" → per-modality dropdown with a live
preview of the effective collection name. The validator runs both
client-side (option list filtered to legal values for the scope) and
server-side (POST + PATCH both call `validateNamespacePolicyForScope`).

API: include `namespace` on any `backends.<modality>` block in
`POST /api/datasets` or `PATCH /api/datasets/:id`. Illegal combinations
return 422 with `path: "backends.<modality>.namespace"`.

### Recommendations

- **Global datasets**: prefer `by-tenant` unless the data is genuinely
  shared (an org-wide reference index). `shared` on a global dataset
  means every tenant reads and writes the same collection — almost
  always a security issue.
- **Tenant datasets**: prefer `shared` unless you actually need per-env
  splits. The tenant cascade already isolates by tenant via the
  connection.
- **Environment datasets**: nothing to choose — only `shared` applies.

## Multi-connection per dataset — deferred

For v1, **one (dataset, modality) resolves to exactly one connection**. Read-replica / write-primary splits, multi-region failover, and shard fan-out all need a "give me the *read* connection on this dataset" / "the *write* one" distinction. The model has room for it (a `role: "read" | "write"` field on the dataset's backend connection ref) but the UI + plugin-side selection are out of scope for now.

If you have a real use case for multi-connection, file it with the read/write split details and we'll prioritise. The above sentence is the entire deferral commitment — no implicit fallback semantics, no half-shipped v0.

## Secret handling

`connection.secretRefId` points at a row in `secret_refs` (same table the plugin `secrets:` block uses). Connection rows never store plaintext — the secret resolves via `DatabaseEncryptedSecretProvider` at runtime, scoped by the calling tenant.

Plugins today still get credentials via their own `secrets:` block in the spec; PR-followup work will let the runtime auto-resolve a connection's `secretRefId` into the plugin's `secrets` map under well-known keys (e.g. `secrets.username`, `secrets.password`). Tracked separately.
