# ADR 0006: Vector Store Isolation Implementation

## Status

Accepted

## Context

ADR 0001 keeps vector clients behind an interface; the architecture mandates
collection-per-tenant-pipeline isolation. The implementation must enforce that
tenant boundary even within a shared collection and stay testable offline.

## Decision

`@ragdoll/vector` defines a `VectorStore` interface with two adapters. The
default `InMemoryVectorStore` is exposed as a process-wide singleton via
`getInMemoryVectorStore()` so an upsert plugin and a retriever plugin in the
same process share data. `QdrantVectorStore` lazy-imports
`@qdrant/js-client-rest` only when a URL is configured. `createVectorStore`
returns Qdrant when `config.url`/`QDRANT_URL` is set, otherwise the singleton.

Isolation is enforced at two layers: a deterministic collection name
(`rag_{environment}_{tenant_slug}_{pipeline_slug}_{embedding_profile_hash}`)
and a mandatory `tenantId` payload filter on every `query` and
`deleteByTenant`. Qdrant creates a keyword payload index on `tenantId` for
efficient filtered queries and deletes. A point's `tenantId` is always written
into its payload on upsert.

## Consequences

- Cross-tenant reads are impossible even if two tenants share a collection,
  because the tenant filter is not optional.
- `delete_tenant_vector_data` can purge a tenant by payload filter.
- Embedding-profile changes (provider/model/dimensions/distance/chunking)
  change the collection name, forcing a reindex rather than silent mixing.
- Tests exercise isolation, ranking, and the upsert/retrieve round-trip with
  no Qdrant running.
