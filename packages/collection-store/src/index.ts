/**
 * Collection store (ADR-00XX, pipeline batching / M2).
 *
 * A document collection staged out of pipeline RAM and into durable, *paged*
 * storage, addressed by a small {@link CollectionHandle}. This is the
 * "batch-by-reference" primitive: a source stages its output to a collection
 * and passes the handle downstream, so the runtime's in-memory output map holds
 * kilobytes (a handle) instead of gigabytes (every document). A batch iterator
 * (`foreach_batch`) then reads the collection ONE PAGE AT A TIME and runs a
 * sub-pipeline per page — peak memory ≈ pageSize × concurrency × docSize,
 * independent of the total corpus size. Persistent handles also give
 * "reprocess previously staged content" for free.
 *
 * Two backings:
 *   - {@link FileSystemCollectionStore} — the real one. Pages are JSONL files
 *     under `<root>/<id>/`; reads touch one page file at a time. In production
 *     `<root>` must be DURABLE + SHARED across workers (a PVC / object-store
 *     mount) for cross-run reprocessing and multi-worker resume.
 *   - {@link InMemoryCollectionStore} — holds pages in RAM; for tests only (it
 *     defeats the memory purpose, so never use it as a runtime backing).
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Format tag so a stale/foreign handle is rejected rather than mis-read. */
export const COLLECTION_HANDLE_KIND = "ragdoll.collection/v1";

/**
 * A small, serializable reference to a staged collection. Flows between
 * pipeline steps in place of the documents themselves.
 */
export interface CollectionHandle {
  kind: typeof COLLECTION_HANDLE_KIND;
  backend: "fs" | "memory";
  /** Unique collection id within the backing store. */
  id: string;
  /** Number of pages (shards). */
  pageCount: number;
  /** Total documents across all pages. */
  count: number;
  /** fs backend only: the root directory the pages live under. */
  root?: string;
  /** Optional author-supplied schema/metadata for the collection. */
  schema?: Record<string, unknown>;
  createdAt: string;
}

export function isCollectionHandle(value: unknown): value is CollectionHandle {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === COLLECTION_HANDLE_KIND &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

/** Streaming writer — append pages, then finalize to get the handle. */
export interface CollectionWriter {
  /** Append one page (shard) of documents. */
  appendPage(docs: unknown[]): Promise<void>;
  /** Flush metadata and return the handle. No further appends after this. */
  finalize(meta?: { schema?: Record<string, unknown> }): Promise<CollectionHandle>;
}

export interface CollectionStore {
  /** Begin writing a new collection. */
  create(args?: { id?: string }): Promise<CollectionWriter>;
  /** Read one 0-indexed page of a collection. Touches a single page. */
  readPage(handle: CollectionHandle, pageIndex: number): Promise<unknown[]>;
}

// ---------------------------------------------------------------------------
// In-memory (tests only)
// ---------------------------------------------------------------------------

export class InMemoryCollectionStore implements CollectionStore {
  private pages = new Map<string, unknown[][]>();

  async create(args?: { id?: string }): Promise<CollectionWriter> {
    const id = args?.id ?? randomUUID();
    const shards: unknown[][] = [];
    this.pages.set(id, shards);
    let count = 0;
    return {
      appendPage: async (docs) => {
        shards.push(docs);
        count += docs.length;
      },
      finalize: async (meta) => ({
        kind: COLLECTION_HANDLE_KIND,
        backend: "memory",
        id,
        pageCount: shards.length,
        count,
        schema: meta?.schema,
        createdAt: new Date().toISOString()
      })
    };
  }

  async readPage(handle: CollectionHandle, pageIndex: number): Promise<unknown[]> {
    const shards = this.pages.get(handle.id);
    if (!shards) throw new Error(`collection ${handle.id} not found in this in-memory store`);
    return shards[pageIndex] ?? [];
  }
}

// ---------------------------------------------------------------------------
// Filesystem (production backing)
// ---------------------------------------------------------------------------

function pagePath(root: string, id: string, pageIndex: number): string {
  return join(root, id, `page-${String(pageIndex).padStart(5, "0")}.jsonl`);
}
function manifestPath(root: string, id: string): string {
  return join(root, id, "manifest.json");
}

export class FileSystemCollectionStore implements CollectionStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  async create(args?: { id?: string }): Promise<CollectionWriter> {
    const id = args?.id ?? randomUUID();
    const root = this.root;
    await mkdir(join(root, id), { recursive: true });
    let pageCount = 0;
    let count = 0;
    return {
      appendPage: async (docs) => {
        // One JSON document per line — a page file is read whole (bounded by
        // the page size), but the format stays append/stream friendly.
        const body = docs.map((d) => JSON.stringify(d)).join("\n") + (docs.length ? "\n" : "");
        await writeFile(pagePath(root, id, pageCount), body, "utf8");
        pageCount += 1;
        count += docs.length;
      },
      finalize: async (meta) => {
        const handle: CollectionHandle = {
          kind: COLLECTION_HANDLE_KIND,
          backend: "fs",
          id,
          pageCount,
          count,
          root,
          schema: meta?.schema,
          createdAt: new Date().toISOString()
        };
        await writeFile(manifestPath(root, id), JSON.stringify(handle, null, 2), "utf8");
        return handle;
      }
    };
  }

  async readPage(handle: CollectionHandle, pageIndex: number): Promise<unknown[]> {
    const root = handle.root ?? this.root;
    if (pageIndex < 0 || pageIndex >= handle.pageCount) return [];
    const raw = await readFile(pagePath(root, handle.id, pageIndex), "utf8");
    const lines = raw.split("\n").filter((line) => line.length > 0);
    return lines.map((line) => JSON.parse(line) as unknown);
  }
}

/**
 * Default collection root for the filesystem backing. In k8s this MUST be a
 * durable, shared mount (PVC / object-store FUSE) for cross-run reprocessing
 * and multi-worker resume; locally it falls back to a temp dir.
 */
export function defaultCollectionRoot(): string {
  return process.env.RAGDOLL_COLLECTION_DIR ?? join(process.env.TMPDIR ?? "/tmp", "ragdoll-collections");
}
