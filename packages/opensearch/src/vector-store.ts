import type {
  CollectionConfig,
  DistanceMetric,
  VectorPoint,
  VectorQuery,
  VectorQueryResult,
  VectorStore
} from "../../vector/src/index.ts";
import { OpenSearchClient, type OpenSearchClientConfig } from "./client.ts";

/**
 * OpenSearch k-NN space_type for each platform DistanceMetric.
 * `cosinesimil` and `innerproduct`/`l2` are larger-is-better once OpenSearch
 * converts them to `_score`, matching the rest of the platform's convention.
 */
const SPACE_TYPE: Record<DistanceMetric, string> = {
  cosine: "cosinesimil",
  dot: "innerproduct",
  euclidean: "l2"
};

const VECTOR_FIELD = "vector";

function filterClauses(filter?: Record<string, unknown>): Array<Record<string, unknown>> {
  if (!filter) return [];
  return Object.entries(filter).map(([key, value]) =>
    Array.isArray(value) ? { terms: { [key]: value } } : { term: { [key]: value } }
  );
}

/**
 * VectorStore backed by an OpenSearch index using its native k-NN
 * (`knn_vector` + HNSW/Lucene). Tenant isolation mirrors QdrantVectorStore: a
 * `tenantId` keyword is stored on every doc and required on every query.
 */
export class OpenSearchVectorStore implements VectorStore {
  private readonly client: OpenSearchClient;

  constructor(config: OpenSearchClientConfig | { client: OpenSearchClient }) {
    this.client = "client" in config ? config.client : new OpenSearchClient(config);
  }

  async ensureCollection(name: string, config: CollectionConfig): Promise<void> {
    await this.client.ensureIndex(name, {
      settings: { index: { knn: true } },
      mappings: {
        properties: {
          [VECTOR_FIELD]: {
            type: "knn_vector",
            dimension: config.dimensions,
            method: {
              name: "hnsw",
              engine: "lucene",
              space_type: SPACE_TYPE[config.distance]
            }
          },
          tenantId: { type: "keyword" }
        }
      }
    });
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    if (points.length === 0) return;
    await this.client.bulkIndex(
      collection,
      points.map((point) => ({
        id: point.id,
        doc: {
          [VECTOR_FIELD]: point.vector,
          tenantId: point.tenantId,
          ...(point.payload ?? {})
        }
      })),
      true
    );
  }

  async query(collection: string, query: VectorQuery): Promise<VectorQueryResult[]> {
    const k = Math.max(1, query.topK);
    const filter = [
      { term: { tenantId: query.tenantId } },
      ...filterClauses(query.filter)
    ];
    const { hits } = await this.client.search(collection, {
      size: k,
      query: {
        knn: {
          [VECTOR_FIELD]: {
            vector: query.vector,
            k,
            filter: { bool: { must: filter } }
          }
        }
      }
    });
    return hits.map((hit) => {
      const { [VECTOR_FIELD]: _vector, tenantId: _tenantId, ...payload } = hit.source;
      return { id: hit.id, score: hit.score, payload };
    });
  }

  async deleteByTenant(collection: string, tenantId: string): Promise<void> {
    await this.client.deleteByQuery(collection, { term: { tenantId } });
  }

  async deleteCollection(name: string): Promise<void> {
    await this.client.deleteIndex(name);
  }
}
