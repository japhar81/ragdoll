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
  /**
   * Delete every point whose payload `docId` is in `docIds` AND whose
   * payload `tenantId` matches. Used by the delta-aware deletion path
   * (`qdrant_delete` → `delta_filter.deleted`) when a source document
   * disappears: the upsert side hashes `(tenant, collection, docId,
   * chunkIdx)` into a UUID per chunk, so the caller doesn't know the
   * chunk count and can't recompute the per-chunk UUIDs to call
   * `deleteByIds`. Filter-by-payload removes every chunk for a deleted
   * source in one call without that knowledge.
   *
   * Tenant scoping is mandatory: it's defense-in-depth against a docId
   * collision across tenants (every chunk's payload carries tenantId,
   * so the filter MUST require a match to prevent cross-tenant erase).
   */
  deleteByDocIds(collection: string, tenantId: string, docIds: string[]): Promise<void>;
  deleteByTenant(collection: string, tenantId: string): Promise<void>;
  deleteCollection(name: string): Promise<void>;
}

export interface VectorStoreConfig {
  url?: string;
  apiKey?: string;
  /**
   * Optional backend selector (Phase 6 of dataset/RBAC/retrieval
   * refactor). When set, wins over the URL/env autodetect. Otherwise
   * the factory picks Qdrant if a URL is configured, pgvector if
   * `RAGDOLL_VECTOR_BACKEND=pgvector` is in the env, and finally
   * falls back to the process-wide in-memory singleton.
   */
  provider?: "qdrant" | "pgvector" | "in_memory";
  /**
   * Postgres connection string for the pgvector backend. Defaults to
   * `DATABASE_URL` so a stack running with a single Postgres just
   * works.
   */
  pgUrl?: string;
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

  async deleteByDocIds(collection: string, tenantId: string, docIds: string[]): Promise<void> {
    if (docIds.length === 0) return;
    const stored = this.requireCollection(collection);
    const set = new Set(docIds);
    for (const [id, point] of stored.points) {
      if (point.tenantId !== tenantId) continue;
      const payloadDocId = (point.payload as { docId?: unknown } | undefined)?.docId;
      if (typeof payloadDocId === "string" && set.has(payloadDocId)) {
        stored.points.delete(id);
      }
    }
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

  async deleteByDocIds(collection: string, tenantId: string, docIds: string[]): Promise<void> {
    if (docIds.length === 0) return;
    const client = await this.client();
    await client.delete(collection, {
      wait: true,
      // Both clauses must match — tenant scoping is mandatory (defense
      // against a docId collision across tenants); docId membership
      // uses Qdrant's `any` matcher to delete every chunk for any of
      // the deleted source documents in one call.
      filter: {
        must: [
          { key: "tenantId", match: { value: tenantId } },
          { key: "docId", match: { any: docIds } }
        ]
      }
    });
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

export * from "./pgvector.ts";

/**
 * Process-wide PgVectorStore singleton. Lazily constructs a pool the
 * first time it's needed so the in-memory test path never imports `pg`.
 */
let processWidePgVectorStore: VectorStore | undefined;
async function getPgVectorStore(connectionString: string): Promise<VectorStore> {
  if (processWidePgVectorStore) return processWidePgVectorStore;
  // Lazy-import `pg` so the module loads cleanly in environments without
  // it (web bundle, offline test runner that hasn't installed deps).
  const pgMod = (await import("pg")) as unknown as {
    Pool: new (opts: { connectionString: string }) => unknown;
  };
  const Pool = pgMod.Pool;
  const pool = new Pool({ connectionString });
  const { PgVectorStore } = await import("./pgvector.ts");
  processWidePgVectorStore = new PgVectorStore({
    pool: pool as unknown as import("./pgvector.ts").PgPoolLike
  });
  return processWidePgVectorStore;
}

/**
 * Resets the process-wide PgVectorStore singleton. Tests only.
 */
export function resetPgVectorStore(): void {
  processWidePgVectorStore = undefined;
}

/**
 * Factory: chooses between Qdrant, pgvector, and the in-memory
 * singleton based on (in order): explicit `config.provider`,
 * `RAGDOLL_VECTOR_BACKEND` env, `QDRANT_URL` env, default in-memory.
 *
 * Sync return — when the caller asks for pgvector we still return
 * synchronously by constructing a thin proxy that awaits the pool on
 * first call. Keeps the existing plugin call sites (which expect a
 * VectorStore back, not a Promise) unchanged.
 */
export function createVectorStore(config: VectorStoreConfig = {}): VectorStore {
  const provider =
    config.provider ??
    (process.env.RAGDOLL_VECTOR_BACKEND as VectorStoreConfig["provider"] | undefined);

  if (provider === "in_memory") return getInMemoryVectorStore();

  if (provider === "pgvector") {
    const pgUrl = config.pgUrl ?? process.env.DATABASE_URL;
    if (!pgUrl) {
      throw new VectorStoreError(
        "pgvector backend requires a connection string (pgUrl or DATABASE_URL)"
      );
    }
    return createPgVectorStoreProxy(pgUrl);
  }

  if (provider === "qdrant" || config.url || process.env.QDRANT_URL) {
    const url = config.url ?? process.env.QDRANT_URL;
    if (!url) {
      throw new VectorStoreError("qdrant backend requires a url");
    }
    // Test escape hatch: a URL beginning with `memory:` (or
    // `http://memory…`) maps to the in-memory store. Lets plugin unit
    // tests construct a fake dataset whose backend resolves a
    // connection — exercising the plugin's hard-fail-on-missing-
    // connection path end-to-end — without standing up a real Qdrant.
    if (url.startsWith("memory:") || url.startsWith("http://memory")) {
      return getInMemoryVectorStore();
    }
    return new QdrantVectorStore({
      url,
      apiKey: config.apiKey ?? process.env.QDRANT_API_KEY
    });
  }
  return getInMemoryVectorStore();
}

/**
 * Proxy that defers PgVectorStore construction until the first
 * VectorStore method runs. Lets the factory stay synchronous (every
 * existing plugin call site relies on that) while the pool itself is
 * created via the lazy dynamic import.
 */
function createPgVectorStoreProxy(connectionString: string): VectorStore {
  let pending: Promise<VectorStore> | undefined;
  function instance(): Promise<VectorStore> {
    if (!pending) pending = getPgVectorStore(connectionString);
    return pending;
  }
  return {
    ensureCollection: async (name, config) =>
      (await instance()).ensureCollection(name, config),
    upsert: async (collection, points) =>
      (await instance()).upsert(collection, points),
    query: async (collection, query) =>
      (await instance()).query(collection, query),
    deleteByIds: async (collection, ids) =>
      (await instance()).deleteByIds(collection, ids),
    deleteByDocIds: async (collection, tenantId, docIds) =>
      (await instance()).deleteByDocIds(collection, tenantId, docIds),
    deleteByTenant: async (collection, tenantId) =>
      (await instance()).deleteByTenant(collection, tenantId),
    deleteCollection: async (name) =>
      (await instance()).deleteCollection(name)
  };
}
