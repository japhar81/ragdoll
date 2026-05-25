# ADR 0016: Datasets as First-Class Resources

## Status

Accepted.

## Context

Before this refactor, every storage-touching pipeline node named its
Qdrant collection / OpenSearch index directly in `node.config.collection`
/ `node.config.index`. That coupled ingestion and retrieval one-to-one
— a tenant with N ingest pipelines + M retrieval pipelines ended up
with N×M coordinated config blobs sharing magic strings. The platform
had no notion of "this corpus" as a thing; it could only see the
physical collection names individual pipelines happened to type. RBAC
on the corpus didn't exist (only `pipeline:run` on the pipeline that
read or wrote it), and "swap this Qdrant collection for a pgvector
one" required editing every node in every pipeline.

## Decision

Introduce a `Dataset` as a first-class, schema'd, RBAC'd resource.
Pipelines reference Datasets by id (`node.dataset = { slug, alias }`)
rather than by raw collection name; the runtime resolves the reference
at execute time and dispatches the read/write to the right backend.

Three tables back the model:

  datasets           the logical resource. Scope = global | tenant |
                     environment (CHECK constraint pins the shape);
                     carries `embedding_profile`, `chunk_schema`,
                     `modalities`, `backends`.
  dataset_versions   immutable snapshots of schema + the concrete
                     physical `backend_collections` the data lives in.
                     New schema → new version (full re-ingest).
  dataset_aliases    moveable pointers (`stable`, `staging`) into the
                     version timeline; pipelines pin to an alias so
                     the platform can swap the underlying version
                     atomically.

Slug uniqueness within scope is enforced by three partial unique
indexes (global / tenant / environment). Scope inheritance at
reference time walks `environment → tenant → global`, first match
wins — the same `support-kb` slug can shadow at three levels and
resolution picks the narrowest match for the running context.

RBAC adds three permissions (`dataset:read`, `dataset:write`,
`dataset:admin`) seeded onto every existing role appropriately. Every
mutation goes through the standard `enforce(...)` path; `viewer` reads,
`tenant_admin` administers within their tenant, etc.

The plugin contract gains a `contract: 2` opt-in. v2 plugins receive
a `ResolvedDataset` on their execution input; v1 plugins (the bulk of
existing code) keep working because the runtime's compatibility shim
splices `backendCollections.vector` into `config.collection`. A
synthesize-script migrates every existing tenant-pipeline-env row that
has a storage-touching node into a v1 dataset pointing at the existing
physical collection; no data moves.

## Consequences

- Pipelines decouple from raw collection names. One Dataset can back
  many pipelines (the ingest side and the retrieval side become
  independently editable / deployable).
- Backend swaps become metadata edits. `dataset.backends.vector.provider`
  switches a corpus from Qdrant to pgvector at version-cut time;
  pipelines using `dataset_search` / `dataset_upsert` (Phase 9 v2
  primitives) follow without a pipeline edit.
- Aliases enable canary rollouts: cut a `v2` version into a new
  collection, point the `staging` alias at it, validate, then retarget
  `stable` atomically. Pipelines pinned to `stable` cut over instantly
  with no spec change.
- The v1 shim is the migration gate. As long as legacy pipelines keep
  using `config.collection` they're untouched. As pipelines adopt
  `node.dataset`, the shim silently routes them through the dataset
  layer. A future round drops v1 entirely.
- Schema enforcement is the platform's job. v2 plugins can rely on the
  records they read/write conforming to `dataset.chunk_schema`; today
  enforcement is "the schema is metadata; nothing validates writes."
  Tightening that is a follow-up — the abstraction is ready for it.
- Datasets at global scope are intentionally rare. A platform admin
  can publish a reference corpus (curated docs) usable by every tenant;
  tenant-scoped grants don't authorize reads against globals
  automatically. The seeded role permissions opt-in to global reads
  for every role.

## Alternatives considered

1. **Continue with collection-name-in-config.** Cheapest, but every
   subsequent feature (canary, multi-backend, per-corpus RBAC) ends up
   as a special case in 25 plugins. Rejected.
2. **Make the collection a config-scope key (`vector.collection` etc.).**
   We already have this; it pushes the magic string into a shared
   config row but doesn't add structure. RBAC is still pipeline-scoped,
   versioning doesn't exist, and the plugin still has to know the
   collection name format.
3. **Couple Datasets to Pipelines structurally (foreign key from
   pipeline_versions to dataset rows).** Tempting but inverts the
   reference direction we want: a dataset doesn't care which pipelines
   read it. We keep the reference inside the pipeline spec
   (`node.dataset`) so a pipeline version's dataset coupling is frozen
   at publish time, same way config + secrets work.
