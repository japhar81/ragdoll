export type DistanceMetric = "cosine" | "dot" | "euclidean";

export interface CollectionConfig {
  dimensions: number;
  distance: DistanceMetric;
}

export interface VectorPoint {
  id: string;
  vector: number[];
  payload?: Record<string, unknown>;
  tenantId: string;
}

export interface VectorQuery {
  vector: number[];
  topK: number;
  filter?: Record<string, unknown>;
  tenantId: string;
}

export interface VectorQueryResult {
  id: string;
  score: number;
  payload?: Record<string, unknown>;
}

export interface VectorStore {
  ensureCollection(name: string, config: CollectionConfig): Promise<void>;
  upsert(collection: string, points: VectorPoint[]): Promise<void>;
  query(collection: string, query: VectorQuery): Promise<VectorQueryResult[]>;
  /** Delete specific points by id. Used by delta_filter / qdrant_delete to
   *  remove docs whose source has been removed from disk. */
  deleteByIds(collection: string, ids: string[]): Promise<void>;
  deleteByTenant(collection: string, tenantId: string): Promise<void>;
  deleteCollection(name: string): Promise<void>;
}

export interface VectorStoreConfig {
  url?: string;
  apiKey?: string;
}

export class VectorStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorStoreError";
  }
}

export class CollectionNotFoundError extends VectorStoreError {
  constructor(name: string) {
    super(`Vector collection not found: ${name}`);
    this.name = "CollectionNotFoundError";
  }
}

export class DimensionMismatchError extends VectorStoreError {
  constructor(expected: number, received: number) {
    super(`Vector dimension mismatch: expected ${expected}, received ${received}`);
    this.name = "DimensionMismatchError";
  }
}

export function score(metric: DistanceMetric, a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new DimensionMismatchError(a.length, b.length);
  }
  if (metric === "euclidean") {
    let sum = 0;
    for (let index = 0; index < a.length; index += 1) {
      const delta = a[index] - b[index];
      sum += delta * delta;
    }
    // Higher score = closer; negate distance so larger is better and rankings stay consistent.
    return -Math.sqrt(sum);
  }
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
  }
  if (metric === "dot") {
    return dot;
  }
  // cosine
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dot / denominator;
}

interface StoredCollection {
  config: CollectionConfig;
  points: Map<string, VectorPoint>;
}

function matchesFilter(payload: Record<string, unknown> | undefined, filter?: Record<string, unknown>): boolean {
  if (!filter) return true;
  const target = payload ?? {};
  return Object.entries(filter).every(([key, value]) => {
    if (Array.isArray(value)) {
      return value.includes(target[key]);
    }
    return target[key] === value;
  });
}

export class InMemoryVectorStore implements VectorStore {
  private collections = new Map<string, StoredCollection>();

  async ensureCollection(name: string, config: CollectionConfig): Promise<void> {
    const existing = this.collections.get(name);
    if (existing) {
      existing.config = config;
      return;
    }
    this.collections.set(name, { config, points: new Map() });
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    const stored = this.requireCollection(collection);
    for (const point of points) {
      if (point.vector.length !== stored.config.dimensions) {
        throw new DimensionMismatchError(stored.config.dimensions, point.vector.length);
      }
      stored.points.set(point.id, {
        id: point.id,
        vector: point.vector,
        payload: point.payload,
        tenantId: point.tenantId
      });
    }
  }

  async query(collection: string, query: VectorQuery): Promise<VectorQueryResult[]> {
    const stored = this.requireCollection(collection);
    const ranked: VectorQueryResult[] = [];
    for (const point of stored.points.values()) {
      if (point.tenantId !== query.tenantId) continue;
      if (!matchesFilter(point.payload, query.filter)) continue;
      ranked.push({
        id: point.id,
        score: score(stored.config.distance, query.vector, point.vector),
        payload: point.payload
      });
    }
    ranked.sort((left, right) => right.score - left.score);
    return ranked.slice(0, Math.max(0, query.topK));
  }

  async deleteByIds(collection: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const stored = this.requireCollection(collection);
    for (const id of ids) stored.points.delete(id);
  }

  async deleteByTenant(collection: string, tenantId: string): Promise<void> {
    const stored = this.requireCollection(collection);
    for (const [id, point] of stored.points) {
      if (point.tenantId === tenantId) {
        stored.points.delete(id);
      }
    }
  }

  async deleteCollection(name: string): Promise<void> {
    this.collections.delete(name);
  }

  private requireCollection(name: string): StoredCollection {
    const stored = this.collections.get(name);
    if (!stored) throw new CollectionNotFoundError(name);
    return stored;
  }
}

const QDRANT_DISTANCE: Record<DistanceMetric, string> = {
  cosine: "Cosine",
  dot: "Dot",
  euclidean: "Euclid"
};

export class QdrantVectorStore implements VectorStore {
  private url: string;
  private apiKey?: string;
  private clientPromise?: Promise<unknown>;

  constructor(config: VectorStoreConfig) {
    if (!config.url) {
      throw new VectorStoreError("QdrantVectorStore requires a url");
    }
    this.url = config.url;
    this.apiKey = config.apiKey;
  }

  private async client(): Promise<any> {
    if (!this.clientPromise) {
      this.clientPromise = import("@qdrant/js-client-rest").then(({ QdrantClient }) => {
        return new QdrantClient({ url: this.url, apiKey: this.apiKey });
      });
    }
    return this.clientPromise;
  }

  async ensureCollection(name: string, config: CollectionConfig): Promise<void> {
    const client = await this.client();
    let exists = false;
    try {
      await client.getCollection(name);
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) {
      await client.createCollection(name, {
        vectors: { size: config.dimensions, distance: QDRANT_DISTANCE[config.distance] }
      });
    }
    // Tenant payload index keeps deleteByTenant / filtered queries efficient.
    try {
      await client.createPayloadIndex(name, { field_name: "tenantId", field_schema: "keyword" });
    } catch {
      // Index may already exist; safe to ignore.
    }
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    if (points.length === 0) return;
    const client = await this.client();
    await client.upsert(collection, {
      wait: true,
      points: points.map((point) => ({
        id: point.id,
        vector: point.vector,
        payload: { ...(point.payload ?? {}), tenantId: point.tenantId }
      }))
    });
  }

  async query(collection: string, query: VectorQuery): Promise<VectorQueryResult[]> {
    const client = await this.client();
    const must: Array<Record<string, unknown>> = [{ key: "tenantId", match: { value: query.tenantId } }];
    if (query.filter) {
      for (const [key, value] of Object.entries(query.filter)) {
        must.push(
          Array.isArray(value)
            ? { key, match: { any: value } }
            : { key, match: { value } }
        );
      }
    }
    const response = await client.search(collection, {
      vector: query.vector,
      limit: Math.max(1, query.topK),
      filter: { must },
      with_payload: true
    });
    return (response as Array<{ id: string | number; score: number; payload?: Record<string, unknown> }>).map((hit) => ({
      id: String(hit.id),
      score: hit.score,
      payload: hit.payload
    }));
  }

  async deleteByIds(collection: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const client = await this.client();
    await client.delete(collection, { wait: true, points: ids });
  }

  async deleteByTenant(collection: string, tenantId: string): Promise<void> {
    const client = await this.client();
    await client.delete(collection, {
      wait: true,
      filter: { must: [{ key: "tenantId", match: { value: tenantId } }] }
    });
  }

  async deleteCollection(name: string): Promise<void> {
    const client = await this.client();
    await client.deleteCollection(name);
  }
}

let processWideInMemoryStore: InMemoryVectorStore | undefined;

/**
 * Returns the process-wide singleton InMemoryVectorStore. An upsert plugin and a
 * retriever plugin running in the same process/test share this instance so that
 * data written by one is visible to the other.
 */
export function getInMemoryVectorStore(): InMemoryVectorStore {
  if (!processWideInMemoryStore) {
    processWideInMemoryStore = new InMemoryVectorStore();
  }
  return processWideInMemoryStore;
}

/**
 * Resets the process-wide in-memory singleton. Intended for tests.
 */
export function resetInMemoryVectorStore(): void {
  processWideInMemoryStore = undefined;
}

/**
 * Factory: returns a QdrantVectorStore when a url is configured (via config.url
 * or the QDRANT_URL environment variable), otherwise the process-wide singleton
 * InMemoryVectorStore.
 */
export function createVectorStore(config: VectorStoreConfig = {}): VectorStore {
  const url = config.url ?? process.env.QDRANT_URL;
  if (url) {
    return new QdrantVectorStore({ url, apiKey: config.apiKey ?? process.env.QDRANT_API_KEY });
  }
  return getInMemoryVectorStore();
}
