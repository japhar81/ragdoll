# OpenSearch Plugins

Five in-process plugins (in `plugins/builtin-rag`) integrate OpenSearch as a
document store and a retrieval backend. They are built on `@ragdoll/opensearch`,
a dependency-free `fetch`-based client — no `@opensearch-project/opensearch`
install, and the transport is trivially stubbable in offline tests.

| Plugin | Category | Purpose |
| --- | --- | --- |
| `opensearch_input` | `datasource` | Read documents from an index (optionally `query_string`-filtered). |
| `opensearch_output` | `sink` | Bulk-index documents or embedded chunks; can provision a kNN index. |
| `opensearch_bm25_retriever` | `retriever` | Lexical BM25 retrieval via `multi_match`. |
| `opensearch_vector_retriever` | `retriever` | kNN vector retrieval over a `knn_vector` field. |
| `opensearch_hybrid_retriever` | `retriever` | Runs BM25 + kNN and fuses the rankings. |

## Connection

Every plugin resolves its endpoint in this order:

1. node `config.endpoint`
2. the `opensearch.url` resolved-config value
3. the `OPENSEARCH_URL` environment variable

Auth is via the secret-ref fields `username`/`password` (HTTP basic) or
`authorization` (a raw `Authorization` header value, e.g. an API key) which
takes precedence. The local dev cluster runs with the security plugin disabled,
so no credentials are needed there.

## Tenant isolation

Mirrors `qdrant_retriever`: `opensearch_output` stamps every document with a
`tenantId` keyword, and the retrievers add a `term` filter on the execution
tenant by default (`tenantField`, default `tenantId`; set it empty to opt out
for shared/external indexes). `opensearch_input`'s tenant filter is opt-in via
`tenantField` since it may read indexes not produced by this platform.

## Vector + hybrid indexing

`opensearch_vector_retriever` uses `OpenSearchVectorStore` (implements the
shared `VectorStore` interface) against a fixed `vector` `knn_vector` field.
To populate it, run `opensearch_output` with `vectorField: "vector"`,
`createKnnIndex: true`, `dimensions`, and `distance` so the index is created
with the right HNSW mapping. Distance → OpenSearch `space_type`:

| DistanceMetric | space_type |
| --- | --- |
| `cosine` | `cosinesimil` |
| `dot` | `innerproduct` |
| `euclidean` | `l2` |

For `opensearch_hybrid_retriever`, point both arms at one index that has the
BM25 text field(s) **and** the `vector` field.

## Hybrid fusion

`config.mode`:

- **`rrf`** (default) — Reciprocal Rank Fusion. Each arm contributes
  `1 / (rrfK + rank)` (1-based rank). Scale-free and robust; tune with
  `rrfK` (default `60`).
- **`weighted`** — min-max normalize each arm's scores to `[0,1]`, then
  `alpha * vector + (1 - alpha) * lexical`. `alpha` defaults to `0.5`.

`candidateK` controls how many hits each arm contributes before fusion
(default `max(topK*4, 20)`). The fusion math is the exported pure function
`fuseHybridResults` and is unit-tested directly.

The vector arm embeds the question with the configured `provider`/`model`
(reusing the shared embedding path) unless `inputs.queryVector` is supplied.

## Local stack

`infra/docker/docker-compose.yml` includes a single-node `opensearch` service
(security disabled, `9200` published, `opensearch-data` volume). `api` and
`worker` get `OPENSEARCH_URL=http://opensearch:9200`. `make up` brings it up;
`make refresh` only rebuilds api/worker/web, so after a fresh checkout run
`docker compose -f infra/docker/docker-compose.yml up -d opensearch` (or
`make up`) once.

## Example: hybrid RAG ingestion + query

1. `text_document_loader` → `basic_text_chunker` → `provider_embeddings`
2. `opensearch_output` with `index: kb`, `vectorField: vector`,
   `createKnnIndex: true`, `dimensions: 768`, `distance: cosine`
3. Query pipeline: `opensearch_hybrid_retriever` with `index: kb`,
   `fields: ["text"]`, `mode: rrf`, `topK: 5` → `basic_rag_prompt` →
   `provider_chat`

## Testing

- `packages/opensearch/test/opensearch.test.ts` — client + vector store with a
  stubbed `fetch` (run by `npm test`).
- `plugins/builtin-rag/test/opensearch-plugins.test.ts` — the five plugins and
  the `fuseHybridResults` math against a fake OpenSearch (run by
  `npm run test:plugins`, included in `npm run test:all`).
