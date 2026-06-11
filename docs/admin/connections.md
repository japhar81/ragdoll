# Connections + dataset bindings

This doc covers the operator-facing model for **how a pipeline knows where to read and write**. Three layers — keep them straight and the rest follows.

ADR-0023 retired the old "backends.&lt;modality&gt;" + "modalities[]" shape on the dataset and the matching "modality + provider" shape on plugin manifests. Both are gone from the data model entirely. If you've read older drafts of this doc, the visible difference is:

| old                                                 | new                                              |
| --------------------------------------------------- | ------------------------------------------------ |
| `backends.vector.{provider, connectionName}`        | `bindings.vectors.{connection}`                  |
| `modalities: ["vector"]`                            | (gone — derived from `bindings` keys)            |
| plugin `requires: [{modality, provider}]`           | plugin `requires: [{binding, kind \| kindOneOf}]`|
| `dataset_modality_mismatch` / `_provider_mismatch`  | `dataset_binding_missing` / `_binding_kind_mismatch`|

## The three layers

```
                      ┌────────────────────────────────────────┐
                      │ Plugin (qdrant_vector_store)           │
                      │   requires: [{binding:"vectors",       │
                      │              kind:"qdrant"}]           │
                      └──────────────┬─────────────────────────┘
                                     │ no host/url config — just declares what it needs
                                     ▼
                ┌────────────────────────────────────────────┐
                │ Dataset (slug: "docs")                     │
                │   bindings.vectors = {                     │
                │     connection: "qdrant-main",             │
                │     collection: "docs_v1",                 │
                │     namespace:  "by-tenant"                │
                │   }                                        │
                └──────────────┬─────────────────────────────┘
                               │ pinned per (tenant, env) by the runtime
                               ▼
        ┌───────────────────────────────────────────────┐
        │ Connection (slug: "qdrant-main")              │
        │   tenant=NULL, env=NULL  → host: shared       │
        │   tenant=A,    env=NULL  → host: a.example    │
        │   tenant=B,    env=prod  → host: b-prod.ex    │
        └───────────────────────────────────────────────┘
```

**Plugin** — declares the dataset slot it needs (binding name + acceptable connection kind) via `requires` in its manifest. Knows NOTHING about hosts, ports, URLs. The runtime hard-fails before the plugin runs if the binding doesn't resolve.

**Dataset** — operator-defined logical corpus. The `bindings:` map names slots (free-text — common ones are `vectors`, `text`, `graph`, `rows`) and each slot points at a `connection` slug + optional `collection` override + optional `namespace` policy. The dataset is referenced by `{slug, alias}` from pipeline specs; the runtime walks env→tenant→global to pick the actual row. Per-(pipeline, tenant, env) **binding overrides** can pin a specific physical row for one pipeline-on-this-scope.

**Connection** — per-(tenant, env) host + credentials + kind. Globals (tenant=NULL) act as cluster-wide defaults that tenants inherit. Cascade:

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
    { binding: "vectors", kind: "qdrant" }
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

`kindOneOf: ["qdrant", "opensearch"]` lets a plugin accept any of several kinds; `kind: "qdrant"` is sugar for a 1-element `kindOneOf`. Omitting both = any kind acceptable (just need the binding by name).

Hybrid plugins list every slot they need:

```typescript
requires: [
  { binding: "vectors", kind: "opensearch" },
  { binding: "text",    kind: "opensearch" }
]
```

Validation happens twice:

- **At edit time** (Builder): the spec validator checks the bound dataset's binding names + connection kinds against the plugin's `requires`. Mismatches surface as `dataset_binding_missing` and `dataset_binding_kind_mismatch` — Run / Deploy are blocked until fixed.
- **At execute time** (worker): if the resolved dataset's `bindings.<name>.connection` doesn't resolve, the plugin throws a preflight error pointing at the offending dataset slug. The execution row is marked `failed` before any work runs.

## Connection cascade

Connections live in the unified `connections` table (ADR-0023 §1). The resolver walks three tiers, picking the most-specific match for `(tenant T, env E, slug N)`:

| Tier | Row shape                                  | Use case                              |
| ---- | ------------------------------------------ | ------------------------------------- |
| 3    | `tenant_id=T, environment_id=E, slug=N`    | Per-env override for tenant T         |
| 2    | `tenant_id=T, environment_id=NULL, slug=N` | Tenant-wide override (all envs)       |
| 1    | `tenant_id=NULL, environment_id=NULL, slug=N` | Cluster-wide default for every tenant |

Globals require `connection:admin` at scope `*`; tenant rows require `connection:admin` on the tenant.

### Example

Tenant A has one OpenSearch cluster shared across envs; Tenant B has three (one per env):

```
Connections:
  slug=os, tenant=NULL, env=NULL    → host: dev-default.example   # safety net
  slug=os, tenant=A, env=NULL        → host: os.tenantA.example   # tenant-wide
  slug=os, tenant=B, env=dev         → host: os-dev.tenantB.example
  slug=os, tenant=B, env=prod        → host: os-prod.tenantB.example
  slug=os, tenant=B, env=qa          → host: os-qa.tenantB.example
```

The pipeline spec just says `dataset: {slug: "docs", alias: "stable"}` and the dataset's `bindings.text.connection = "os"`. Each tenant resolves "os" to their own cluster — no spec change, no per-tenant dataset copies.

## Dataset binding overrides

Per-(pipeline, tenant, env) overrides live in `pipeline_dataset_bindings`. They beat the default slug cascade when present:

```
For each `dataset: {slug: S}` in pipeline P running as (tenant T, env E):
  1. pipeline_dataset_bindings (P, T, E, S)        → use that target dataset row
  2. pipeline_dataset_bindings (P, T, NULL, S)     → use that target row (all envs)
  3. datasets.resolveSlug(S, T, E)                 → default env→tenant→global cascade
```

Common use case: "Tenant B's prod pipeline writes to a schema-v2 dataset; everything else stays on v1." Create one binding row pinning slug `docs` → dataset `docs-v2-tenantB` for (pipeline=ingest, tenant=B, env=prod). No spec change.

Manage via the Datasets screen's "Used by" panel (which shows every pipeline node wiring this slug, with a deep-link to the Builder) or the per-pipeline bindings API:

```
GET    /api/pipelines/:id/dataset-bindings
POST   /api/pipelines/:id/dataset-bindings
PATCH  /api/dataset-bindings/:id   { targetDatasetId? }
DELETE /api/dataset-bindings/:id
```

## CRUD APIs

### Connections (ADR-0023 unified registry)

| Verb   | Path                                | Notes                                                   |
| ------ | ----------------------------------- | ------------------------------------------------------- |
| GET    | `/api/connections`                  | with `x-tenant-id`: tenant + inherited globals; without: globals only (admin) |
| GET    | `/api/connections/:id`              | single row                                              |
| POST   | `/api/connections`                  | `{ scope, tenantId?, environmentId?, slug, displayName, kind, config, secretRefKey? }` |
| PUT    | `/api/connections/:id`              | replace                                                 |
| DELETE | `/api/connections/:id`              | soft archive                                            |
| POST   | `/api/connections/:id/probe`        | synchronous probe via the driver's `probe()` hook       |
| GET    | `/api/connection-kinds`             | every registered driver's `displayName` + `configSchema` + `datasetBindings` |

### Bindings

| Verb   | Path                                          | Notes                                                |
| ------ | --------------------------------------------- | ---------------------------------------------------- |
| GET    | `/api/pipelines/:id/dataset-bindings`         | all binding rows for a pipeline                      |
| POST   | `/api/pipelines/:id/dataset-bindings`         | `{ tenantId, environmentId?, sourceSlug, targetDatasetId }` |
| PATCH  | `/api/dataset-bindings/:id`                   | retarget (`targetDatasetId` only)                    |
| DELETE | `/api/dataset-bindings/:id`                   |                                                      |
| GET    | `/api/datasets/:id/used-by`                   | server-side cross-ref of pipelines + nodes wiring this dataset |

### Supported connection kinds

The set of registered driver kinds is whatever's installed today — `GET /api/connection-kinds` returns the live list. Out of the box: `qdrant`, `opensearch`, `dgraph`, `postgres`, `mongodb`, `clickhouse`. Adding a new kind = adding a driver plugin (ADR-0024); the Connections screen's "Type" picker populates from the same endpoint, no UI changes needed.

## Dataset namespace policy

A dataset's `bindings.<name>` block accepts an optional `namespace`
field that controls how the collection / index / predicate name is
**isolated across tenants and environments at resolve-time**. The base
collection name lives on the dataset version
(`dataset_versions.backend_collections.<name>`); the resolver appends a
deterministic, sanitised suffix before any plugin sees it. Plugins read
the effective name from `ResolvedDataset.bindings.<name>.collection`
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

UI: Datasets → pick a dataset → Bindings table → per-binding "Namespace"
dropdown. Legal values are filtered to what the dataset's scope allows;
the validator runs server-side too (POST + PATCH both call
`validateNamespacePolicyForScope`).

API: include `namespace` on any `bindings.<name>` block in
`POST /api/datasets` or `PATCH /api/datasets/:id`. Illegal combinations
return 422 with `path: "bindings.<name>.namespace"`.

### Recommendations

- **Global datasets**: prefer `by-tenant` unless the data is genuinely
  shared (an org-wide reference index). `shared` on a global dataset
  means every tenant reads and writes the same collection — almost
  always a security issue.
- **Tenant datasets**: prefer `shared` unless you actually need per-env
  splits. The tenant cascade already isolates by tenant via the
  connection.
