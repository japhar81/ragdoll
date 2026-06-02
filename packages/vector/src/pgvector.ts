/**
 * Phase 6 of the dataset/RBAC/retrieval refactor: a {@link VectorStore}
 * backed by Postgres + the `vector` extension (pgvector). Lives behind
 * the same interface as QdrantVectorStore and InMemoryVectorStore so
 * plugins don't see the difference — only the factory in `./index.ts`
 * chooses the implementation.
 *
 * Why pgvector matters: a lot of operators already run Postgres and
 * don't want a second stateful service. For corpora under ~10M
 * vectors it's plenty fast, and Phase 4's Dataset model (one logical
 * corpus, swappable physical backend per version) lets a team start on
 * pgvector and migrate to Qdrant later by cutting a new dataset
 * version on the Qdrant backend.
 *
 * Storage shape: one table per vector collection, named
 * `vec_<sanitized_collection>`. Columns: `id text PK`,
 * `tenant_id uuid NOT NULL`, `vector vector(<dim>) NOT NULL`,
 * `payload jsonb NOT NULL DEFAULT '{}'`. A `(tenant_id)` btree index
 * isolates per-tenant queries; an `ivfflat` index on `vector` (with
 * the configured opclass) accelerates ANN search. The collection's
 * dimensions + distance metric are captured the first time
 * `ensureCollection` is called and validated against subsequent calls.
 */
import {
  type CollectionConfig,
  type DistanceMetric,
  type VectorPoint,
  type VectorQuery,
  type VectorQueryResult,
  type VectorStore,
  CollectionNotFoundError,
  DimensionMismatchError,
  VectorStoreError
} from "./index.ts";

/**
 * Subset of pg.Pool / pg.PoolClient that we actually use. Keeping it
 * narrow lets tests inject a fake without depending on the `pg`
 * package at type level.
 */
export interface PgPoolLike {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: R[]; rowCount?: number | null }>;
}

function sanitizeCollection(name: string): string {
  // Pg identifiers cap at 63 bytes and disallow most punctuation; the
  // sanitize matches the rest of the platform's slug conventions.
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!cleaned) throw new VectorStoreError(`Invalid collection name: ${name}`);
  // Prefix so a collection table never collides with a platform table.
  return `vec_${cleaned}`.slice(0, 63);
}

/** pgvector operator + opclass per distance metric. cosine is the
 *  default platform-wide so we keep it cheapest. */
function operatorFor(distance: DistanceMetric): { op: string; opclass: string } {
  switch (distance) {
    case "cosine":
      return { op: "<=>", opclass: "vector_cosine_ops" };
    case "dot":
      // pgvector's `<#>` is *negative* dot product (lower = closer); we
      // negate the result later so callers see the same "higher = closer"
      // semantics every other backend uses.
      return { op: "<#>", opclass: "vector_ip_ops" };
    case "euclidean":
      return { op: "<->", opclass: "vector_l2_ops" };
  }
}

function literalVector(values: number[]): string {
  // pgvector accepts text-cast literals shaped like `[1,2,3]`. JSON
  // stringify is safe for finite floats.
  return JSON.stringify(values);
}

function hasPayloadFilter(
  filter: Record<string, unknown> | undefined
): filter is Record<string, unknown> {
  return !!filter && Object.keys(filter).length > 0;
}

interface PgCollectionMeta {
  dimensions: number;
  distance: DistanceMetric;
}

export class PgVectorStore implements VectorStore {
  private pool: PgPoolLike;
  /** Per-collection metadata cache. Filled on `ensureCollection`; on
   *  subsequent calls we validate dimensions match. */
  private collections = new Map<string, PgCollectionMeta>();

  constructor(options: { pool: PgPoolLike }) {
    this.pool = options.pool;
  }

  async ensureCollection(name: string, config: CollectionConfig): Promise<void> {
    const table = sanitizeCollection(name);
    const existing = this.collections.get(table);
    if (existing) {
      if (existing.dimensions !== config.dimensions) {
        throw new DimensionMismatchError(existing.dimensions, config.dimensions);
      }
      // Distance change after creation isn't supported here — pgvector
      // indexes are opclass-pinned, so a different distance means a
      // different physical table. Tell the caller plainly.
      if (existing.distance !== config.distance) {
        throw new VectorStoreError(
          `Collection ${name} already exists with distance=${existing.distance}; ` +
            `requested ${config.distance} differs`
        );
      }
      return;
    }
    const { opclass } = operatorFor(config.distance);
    // Idempotent: re-running this is safe and lets multiple processes
    // race-create the same collection without erroring.
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${table} (
         id text PRIMARY KEY,
         tenant_id uuid NOT NULL,
         vector vector(${config.dimensions}) NOT NULL,
         payload jsonb NOT NULL DEFAULT '{}'::jsonb
       )`
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${table}_tenant_idx ON ${table}(tenant_id)`
    );
    // ivfflat is the simplest serviceable ANN index pgvector offers;
    // hnsw is faster but needs explicit lists tuning. We pick a sane
    // default and let advanced users override via raw SQL.
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${table}_vector_idx ON ${table}
         USING ivfflat (vector ${opclass}) WITH (lists = 100)`
    );
    this.collections.set(table, {
      dimensions: config.dimensions,
      distance: config.distance
    });
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    if (points.length === 0) return;
    const table = sanitizeCollection(collection);
    const meta = await this.requireMeta(table);
    // Reject mismatched dimensions up front so a misconfigured upstream
    // doesn't silently corrupt a collection's index.
    for (const point of points) {
      if (point.vector.length !== meta.dimensions) {
        throw new DimensionMismatchError(meta.dimensions, point.vector.length);
      }
    }
    // One round-trip per batch via a values list. params layout:
    // ($1=id, $2=tenant_id, $3=vector_literal_cast, $4=payload_json) × N.
    const placeholders: string[] = [];
    const params: unknown[] = [];
    for (const point of points) {
      const i = params.length;
      placeholders.push(
        `($${i + 1}, $${i + 2}, $${i + 3}::vector, $${i + 4}::jsonb)`
      );
      params.push(
        point.id,
        point.tenantId,
        literalVector(point.vector),
        JSON.stringify(point.payload ?? {})
      );
    }
    await this.pool.query(
      `INSERT INTO ${table} (id, tenant_id, vector, payload)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (id) DO UPDATE
       SET tenant_id = EXCLUDED.tenant_id,
           vector = EXCLUDED.vector,
           payload = EXCLUDED.payload`,
      params
    );
  }

  async query(collection: string, query: VectorQuery): Promise<VectorQueryResult[]> {
    const table = sanitizeCollection(collection);
    const meta = await this.requireMeta(table);
    if (query.vector.length !== meta.dimensions) {
      throw new DimensionMismatchError(meta.dimensions, query.vector.length);
    }
    const { op } = operatorFor(meta.distance);
    // tenant scoping is non-negotiable — refuse the request without it
    // so a misconfigured plugin never returns cross-tenant rows.
    if (!query.tenantId) {
      throw new VectorStoreError("PgVectorStore.query requires tenantId");
    }
    // Build params + WHERE in one pass so the $N indices stay in sync
    // when the optional filter is or isn't present.
    const params: unknown[] = [literalVector(query.vector), query.tenantId];
    let filterClause = "";
    if (hasPayloadFilter(query.filter)) {
      params.push(JSON.stringify(query.filter));
      filterClause = ` AND payload @> $${params.length}::jsonb`;
    }
    params.push(query.topK);
    const limitParam = params.length;
    // For cosine + L2, pgvector returns a *distance* (lower = closer).
    // For inner product (`<#>`) the operator returns negative similarity.
    // Convert both into a "higher = closer" score by negating.
    const sql = `
      SELECT id, payload, (vector ${op} $1::vector) AS dist
      FROM ${table}
      WHERE tenant_id = $2${filterClause}
      ORDER BY dist
      LIMIT $${limitParam}`;
    const result = await this.pool.query<{
      id: string;
      payload: Record<string, unknown> | null;
      dist: number | string;
    }>(sql, params);
    return result.rows.map((row) => ({
      id: row.id,
      // pgvector returns numeric as text in some drivers; coerce.
      score: -Number(row.dist),
      payload: row.payload ?? undefined
    }));
  }

  async deleteByIds(collection: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const table = sanitizeCollection(collection);
    await this.requireMeta(table);
    await this.pool.query(
      `DELETE FROM ${table} WHERE id = ANY($1::text[])`,
      [ids]
    );
  }

  async deleteByDocIds(collection: string, tenantId: string, docIds: string[]): Promise<void> {
    if (docIds.length === 0) return;
    const table = sanitizeCollection(collection);
    await this.requireMeta(table);
    // payload->>'docId' = ANY($2) — tenant scope mandatory (same
    // defense-in-depth as the Qdrant + InMemory paths).
    await this.pool.query(
      `DELETE FROM ${table} WHERE tenant_id = $1 AND payload->>'docId' = ANY($2::text[])`,
      [tenantId, docIds]
    );
  }

  async deleteByTenant(collection: string, tenantId: string): Promise<void> {
    const table = sanitizeCollection(collection);
    await this.requireMeta(table);
    await this.pool.query(
      `DELETE FROM ${table} WHERE tenant_id = $1`,
      [tenantId]
    );
  }

  async deleteCollection(name: string): Promise<void> {
    const table = sanitizeCollection(name);
    await this.pool.query(`DROP TABLE IF EXISTS ${table}`);
    this.collections.delete(table);
  }

  /** Cache-or-discover collection metadata. Reading the table's
   *  per-column type tells us the dimension; the distance metric is
   *  implied by the ivfflat opclass we created. We only need this when
   *  the in-process cache is cold (e.g. on first call after restart). */
  private async requireMeta(table: string): Promise<PgCollectionMeta> {
    const cached = this.collections.get(table);
    if (cached) return cached;
    // Probe pg_type to read the vector column's dimensions.
    const rows = (
      await this.pool.query<{ atttypmod: number }>(
        `SELECT a.atttypmod
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         WHERE c.relname = $1 AND a.attname = 'vector' AND a.attnum > 0`,
        [table]
      )
    ).rows;
    if (rows.length === 0) {
      throw new CollectionNotFoundError(table);
    }
    // pgvector stores dimensions in atttypmod (no offset, unlike text).
    const dimensions = Number(rows[0].atttypmod);
    if (!Number.isFinite(dimensions) || dimensions <= 0) {
      throw new VectorStoreError(
        `Could not infer dimensions for collection ${table}`
      );
    }
    // Discover the distance opclass by looking at the index definition.
    // Default to cosine — it's the platform-wide default and what every
    // existing pipeline uses.
    const indexRow = (
      await this.pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
         WHERE tablename = $1 AND indexname = $2`,
        [table, `${table}_vector_idx`]
      )
    ).rows[0];
    let distance: DistanceMetric = "cosine";
    if (indexRow?.indexdef.includes("vector_ip_ops")) distance = "dot";
    if (indexRow?.indexdef.includes("vector_l2_ops")) distance = "euclidean";
    const meta = { dimensions, distance };
    this.collections.set(table, meta);
    return meta;
  }
}
