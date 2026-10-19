/**
 * Batching / scale plugins (ADR-00XX, pipeline batching / M2).
 *
 *   - `stage_collection`: write an in-memory documents array to a durable,
 *     *paged* collection store and emit a small {@link CollectionHandle} in its
 *     place. Everything downstream flows the handle, not the documents — so the
 *     runtime's in-run output map holds kilobytes, not gigabytes.
 *   - `foreach_batch`: run a body sub-pipeline once per batch of a collection,
 *     reading a staged handle ONE PAGE AT A TIME (or slicing an array) with
 *     bounded concurrency and resumable checkpointing. Peak memory ≈
 *     pageSize × concurrency × docSize, independent of the total corpus size.
 *
 * Both are in-process only (they use the runtime's `runSubgraph` / state).
 */
import type { InProcessPlugin } from "../../../../packages/plugin-sdk/src/index.ts";
import {
  FileSystemCollectionStore,
  defaultCollectionRoot,
  isCollectionHandle,
  type CollectionHandle,
  type CollectionStore
} from "../../../../packages/collection-store/src/index.ts";
import { normaliseBodySpec } from "./control-flow.ts";

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Reconstruct a readable store from a self-describing handle. */
function storeForHandle(handle: CollectionHandle): CollectionStore {
  if (handle.backend === "fs") {
    return new FileSystemCollectionStore(handle.root ?? defaultCollectionRoot());
  }
  throw new Error(
    `foreach_batch: cannot read a "${handle.backend}" collection across nodes — ` +
      `stage with a durable backend (fs / a shared volume)`
  );
}

export const stageCollectionPlugin: InProcessPlugin = {
  manifest: {
    id: "stage_collection",
    name: "Stage Collection",
    version: "1.0.0",
    category: "transformer",
    description:
      "Writes the incoming documents array to a durable, paged collection store and emits a small `handle` in its place. Pass the handle to `foreach_batch` to process a large corpus in bounded-memory batches instead of holding every document in RAM. The collection root must be a DURABLE, SHARED mount in production (set RAGDOLL_COLLECTION_DIR).",
    configSchema: {
      type: "object",
      properties: {
        pageSize: {
          type: "integer",
          default: 500,
          description: "Documents per page (shard). This is the batch size `foreach_batch` will use for the resulting handle."
        },
        root: {
          type: "string",
          description: "Collection root directory. Defaults to RAGDOLL_COLLECTION_DIR (a shared/durable mount in prod)."
        },
        schema: { type: "object", description: "Optional schema/metadata recorded on the collection." }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "documents", required: true, description: "The documents array to stage out of RAM." }
    ],
    outputPorts: [
      { name: "handle", description: "A CollectionHandle referencing the staged, paged collection." },
      { name: "count", description: "Total documents staged." },
      { name: "pageCount", description: "Number of pages (batches)." }
    ],
    capabilities: ["ingestion"],
    ui: { icon: "database", formHints: { schema: { widget: "json" } } }
  },
  async execute({ inputs, config }) {
    const docs = (inputs.documents ?? inputs.items) as unknown[] | undefined;
    if (!Array.isArray(docs)) {
      throw new Error(`stage_collection: inputs.documents must be an array, got ${typeof docs}`);
    }
    const pageSize = Math.max(1, Number(config.pageSize ?? 500) | 0);
    const root = typeof config.root === "string" && config.root ? config.root : defaultCollectionRoot();
    const store = new FileSystemCollectionStore(root);
    const writer = await store.create();
    for (let i = 0; i < docs.length; i += pageSize) {
      await writer.appendPage(docs.slice(i, i + pageSize));
    }
    const handle = await writer.finalize({ schema: isObject(config.schema) ? config.schema : undefined });
    return {
      outputs: { handle, count: handle.count, pageCount: handle.pageCount },
      metadata: { backend: handle.backend, pageSize }
    };
  }
};

export const forEachBatchPlugin: InProcessPlugin = {
  manifest: {
    id: "foreach_batch",
    name: "ForEach Batch",
    version: "1.0.0",
    category: "control",
    description:
      "Runs the body subgraph once per BATCH of a collection, with bounded concurrency and resumable checkpointing. Input is either a staged `handle` (read one page at a time — bounded memory regardless of corpus size) or an in-memory `items`/`documents` array (sliced by batchSize). Each iteration receives `{ batch, batchIndex, totalBatches }`. With a `resumeKey`, committed batches are checkpointed so a re-run skips them. Output is a bounded SUMMARY (counts), not every batch result.",
    configSchema: {
      type: "object",
      required: ["body"],
      properties: {
        batchSize: { type: "integer", default: 500, description: "Documents per batch when the input is an array. Ignored for a handle (each staged page is a batch)." },
        concurrency: { type: "integer", default: 1, description: "Max batches processed in parallel." },
        resumeKey: { type: "string", description: "When set, committed batch indexes are checkpointed in the pipeline's ingest state so a re-run resumes instead of restarting." },
        continueOnError: { type: "boolean", default: false, description: "When true, a failing batch is recorded (not fatal) and the run continues; the summary lists failed batches. When false (default), the first failure fails the run — committed batches are still checkpointed for resume." },
        body: { type: "object", description: "Pipeline body executed per batch. Stored as { nodes, edges }. Receives { batch, batchIndex, totalBatches }." }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "handle", description: "A staged CollectionHandle (from stage_collection). Preferred for large corpora — read one page at a time." },
      { name: "items", description: "An in-memory array to batch (alias: documents). Used when no handle is supplied." },
      { name: "documents", description: "Alias for items." }
    ],
    outputPorts: [
      { name: "totalBatches", description: "Total batches in the collection." },
      { name: "batchesProcessed", description: "Batches processed this run." },
      { name: "batchesSkipped", description: "Batches skipped because already committed under resumeKey." },
      { name: "batchesFailed", description: "Count of batches that failed." },
      { name: "failed", description: "Indexes of failed batches (for targeted resume)." }
    ],
    capabilities: ["ingestion"],
    ui: { icon: "layers", formHints: { body: { widget: "json" } } }
  },
  async execute({ inputs, config, runSubgraph, ingestStateStore }) {
    if (!runSubgraph) {
      throw new Error("foreach_batch: runtime did not provide runSubgraph (external plugin transport not supported)");
    }
    const body = normaliseBodySpec(config.body, "foreach_batch body");
    const batchSize = Math.max(1, Number(config.batchSize ?? 500) | 0);
    const concurrency = Math.max(1, Number(config.concurrency ?? 1) | 0);
    const continueOnError = config.continueOnError === true;
    const resumeKey =
      typeof config.resumeKey === "string" && config.resumeKey ? config.resumeKey : undefined;

    // Resolve the batch source — a staged handle (bounded page reads) or an
    // in-memory array (sliced).
    let totalBatches: number;
    let loadBatch: (i: number) => Promise<unknown[]>;
    const handle = inputs.handle;
    if (isCollectionHandle(handle)) {
      const store = storeForHandle(handle);
      totalBatches = handle.pageCount; // each staged page is one batch
      loadBatch = (i) => store.readPage(handle, i);
    } else {
      const items = (inputs.items ?? inputs.documents) as unknown[] | undefined;
      if (!Array.isArray(items)) {
        throw new Error(
          "foreach_batch: provide inputs.handle (a staged collection) or inputs.items/documents (an array)"
        );
      }
      totalBatches = Math.ceil(items.length / batchSize);
      loadBatch = async (i) => items.slice(i * batchSize, (i + 1) * batchSize);
    }

    // Resume: skip batches already committed under resumeKey.
    const committed = new Set<number>();
    if (resumeKey && ingestStateStore) {
      for (const entry of await ingestStateStore.list({ stateKey: resumeKey })) {
        const n = Number(entry.docId);
        if (Number.isInteger(n)) committed.add(n);
      }
    }
    const pending = Array.from({ length: totalBatches }, (_v, i) => i).filter((i) => !committed.has(i));
    const batchesSkipped = totalBatches - pending.length;

    // Serialize checkpoint writes (replaceAll is wholesale).
    let checkpointChain: Promise<void> = Promise.resolve();
    const checkpoint = (i: number): void => {
      committed.add(i);
      if (!resumeKey || !ingestStateStore) return;
      const entries = [...committed].map((n) => ({
        docId: String(n),
        lastSeen: new Date().toISOString()
      }));
      checkpointChain = checkpointChain.then(() =>
        ingestStateStore.replaceAll({ stateKey: resumeKey, entries })
      );
    };

    const failed: number[] = [];
    let aborted = false;
    let cursor = 0;
    const runners = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
      while (!aborted && cursor < pending.length) {
        const i = pending[cursor];
        cursor += 1;
        const batch = await loadBatch(i);
        try {
          await runSubgraph(body, {
            ...inputs,
            batch,
            batchIndex: i,
            totalBatches,
            batchSize: batch.length
          });
          checkpoint(i);
        } catch (e) {
          failed.push(i);
          if (!continueOnError) {
            aborted = true;
            throw e;
          }
        }
      }
    });

    try {
      await Promise.all(runners);
    } catch (e) {
      // Fail-fast: committed batches are still flushed so a re-run (same
      // resumeKey) resumes from here rather than restarting at zero.
      await checkpointChain.catch(() => undefined);
      throw e;
    }
    await checkpointChain.catch(() => undefined);

    return {
      outputs: {
        totalBatches,
        batchesProcessed: pending.length - failed.length,
        batchesSkipped,
        batchesFailed: failed.length,
        failed: [...failed].sort((a, b) => a - b)
      }
    };
  }
};
