/**
 * Tests for the batching / scale plugins: stage_collection + foreach_batch.
 * Deep coverage of batching math, staged-handle (bounded) reads, bounded
 * concurrency, and resumable checkpointing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageCollectionPlugin, forEachBatchPlugin } from "../src/plugins/batching.ts";
import { FileSystemCollectionStore } from "../../../packages/collection-store/src/index.ts";
import type { IngestStateEntry } from "../../../packages/plugin-sdk/src/index.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const run = (plugin: any, input: Record<string, unknown>) => plugin.execute(input as any);

const EMPTY_BODY = { nodes: [], edges: [] };

function docs(n: number): Array<{ id: number }> {
  return Array.from({ length: n }, (_v, i) => ({ id: i }));
}

test("stage_collection writes a paged collection and emits a handle (count + pages)", async () => {
  const root = mkdtempSync(join(tmpdir(), "rd-stage-"));
  const out = await run(stageCollectionPlugin, {
    inputs: { documents: docs(100) },
    config: { pageSize: 30, root }
  });
  const handle = out.outputs.handle;
  assert.equal(out.outputs.count, 100);
  assert.equal(out.outputs.pageCount, 4); // ceil(100/30)
  assert.equal(handle.backend, "fs");
  // Documents are really on disk + readable by a fresh store.
  const store = new FileSystemCollectionStore(root);
  let total = 0;
  for (let p = 0; p < handle.pageCount; p += 1) total += (await store.readPage(handle, p)).length;
  assert.equal(total, 100);
});

test("foreach_batch over an ARRAY: correct batching math + per-batch body input", async () => {
  const calls: Array<{ batchIndex: number; size: number; totalBatches: number }> = [];
  const out = await run(forEachBatchPlugin, {
    inputs: { items: docs(10) },
    config: { batchSize: 4, body: EMPTY_BODY },
    runSubgraph: async (_spec: unknown, inp: Record<string, unknown>) => {
      calls.push({
        batchIndex: inp.batchIndex as number,
        size: (inp.batch as unknown[]).length,
        totalBatches: inp.totalBatches as number
      });
      return {};
    }
  });
  assert.equal(out.outputs.totalBatches, 3); // ceil(10/4)
  assert.equal(out.outputs.batchesProcessed, 3);
  assert.deepEqual(calls.map((c) => c.batchIndex), [0, 1, 2]);
  assert.deepEqual(calls.map((c) => c.size), [4, 4, 2]);
  assert.ok(calls.every((c) => c.totalBatches === 3));
});

test("foreach_batch over a staged HANDLE reads one page per batch (bounded) and covers all docs", async () => {
  const root = mkdtempSync(join(tmpdir(), "rd-fe-"));
  const staged = await run(stageCollectionPlugin, {
    inputs: { documents: docs(25) },
    config: { pageSize: 10, root }
  });
  const seen: number[] = [];
  let maxBatchSize = 0;
  const out = await run(forEachBatchPlugin, {
    inputs: { handle: staged.outputs.handle },
    config: { body: EMPTY_BODY },
    runSubgraph: async (_spec: unknown, inp: Record<string, unknown>) => {
      const batch = inp.batch as Array<{ id: number }>;
      maxBatchSize = Math.max(maxBatchSize, batch.length);
      for (const d of batch) seen.push(d.id);
      return {};
    }
  });
  assert.equal(out.outputs.totalBatches, 3); // 10 + 10 + 5
  assert.equal(out.outputs.batchesProcessed, 3);
  assert.equal(maxBatchSize, 10); // never more than a page in memory at once
  assert.equal(seen.length, 25);
});

test("foreach_batch honors bounded concurrency", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await run(forEachBatchPlugin, {
    inputs: { items: docs(12) },
    config: { batchSize: 1, concurrency: 3, body: EMPTY_BODY },
    runSubgraph: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return {};
    }
  });
  assert.equal(out.outputs.batchesProcessed, 12);
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded 3`);
  assert.ok(peak >= 2, `expected real parallelism, peak was ${peak}`);
});

test("foreach_batch resumes: committed batches are skipped and new ones checkpointed", async () => {
  // State store pre-seeded as if batches 0 and 1 already committed.
  let entries: IngestStateEntry[] = [
    { docId: "0", lastSeen: "t" },
    { docId: "1", lastSeen: "t" }
  ];
  const store = {
    list: async () => entries,
    replaceAll: async (args: { entries: IngestStateEntry[] }) => {
      entries = args.entries;
    }
  };
  const processed: number[] = [];
  const out = await run(forEachBatchPlugin, {
    inputs: { items: docs(20) }, // batchSize 4 → 5 batches (0..4)
    config: { batchSize: 4, resumeKey: "rk", body: EMPTY_BODY },
    ingestStateStore: store,
    runSubgraph: async (_spec: unknown, inp: Record<string, unknown>) => {
      processed.push(inp.batchIndex as number);
      return {};
    }
  });
  assert.equal(out.outputs.totalBatches, 5);
  assert.equal(out.outputs.batchesSkipped, 2);
  assert.equal(out.outputs.batchesProcessed, 3);
  assert.deepEqual(processed.sort((a, b) => a - b), [2, 3, 4]); // only the uncommitted
  // All five are now committed in the checkpoint.
  assert.deepEqual(entries.map((e) => Number(e.docId)).sort((a, b) => a - b), [0, 1, 2, 3, 4]);
});

test("foreach_batch fail-fast: a failing batch fails the run but commits the ones that finished", async () => {
  let entries: IngestStateEntry[] = [];
  const store = {
    list: async () => entries,
    replaceAll: async (args: { entries: IngestStateEntry[] }) => {
      entries = args.entries;
    }
  };
  await assert.rejects(
    () =>
      run(forEachBatchPlugin, {
        inputs: { items: docs(12) }, // batchSize 4 → batches 0,1,2
        config: { batchSize: 4, concurrency: 1, resumeKey: "rk", body: EMPTY_BODY },
        ingestStateStore: store,
        runSubgraph: async (_spec: unknown, inp: Record<string, unknown>) => {
          if (inp.batchIndex === 1) throw new Error("batch 1 boom");
          return {};
        }
      }),
    /batch 1 boom/
  );
  // Batch 0 committed (so a resume skips it); batch 1 failed, batch 2 never ran.
  assert.deepEqual(entries.map((e) => Number(e.docId)), [0]);
});

test("foreach_batch continueOnError: records failures and finishes the rest", async () => {
  const out = await run(forEachBatchPlugin, {
    inputs: { items: docs(12) }, // batches 0,1,2
    config: { batchSize: 4, continueOnError: true, body: EMPTY_BODY },
    runSubgraph: async (_spec: unknown, inp: Record<string, unknown>) => {
      if (inp.batchIndex === 1) throw new Error("boom");
      return {};
    }
  });
  assert.equal(out.outputs.batchesFailed, 1);
  assert.deepEqual(out.outputs.failed, [1]);
  assert.equal(out.outputs.batchesProcessed, 2);
});
