import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileSystemCollectionStore,
  InMemoryCollectionStore,
  isCollectionHandle,
  COLLECTION_HANDLE_KIND
} from "../src/index.ts";

test("InMemoryCollectionStore round-trips pages + reports counts", async () => {
  const store = new InMemoryCollectionStore();
  const w = await store.create();
  await w.appendPage([{ id: 0 }, { id: 1 }]);
  await w.appendPage([{ id: 2 }]);
  const h = await w.finalize({ schema: { shape: "doc" } });
  assert.equal(h.kind, COLLECTION_HANDLE_KIND);
  assert.equal(h.backend, "memory");
  assert.equal(h.pageCount, 2);
  assert.equal(h.count, 3);
  assert.deepEqual(await store.readPage(h, 0), [{ id: 0 }, { id: 1 }]);
  assert.deepEqual(await store.readPage(h, 1), [{ id: 2 }]);
  assert.ok(isCollectionHandle(h));
});

test("FileSystemCollectionStore persists pages; a FRESH store instance reads by handle", async () => {
  const root = mkdtempSync(join(tmpdir(), "rd-coll-"));
  const writer = await new FileSystemCollectionStore(root).create({ id: "c1" });
  await writer.appendPage([{ id: "a" }, { id: "b" }]);
  await writer.appendPage([{ id: "c" }]);
  const handle = await writer.finalize();
  assert.equal(handle.backend, "fs");
  assert.equal(handle.root, root);
  assert.equal(handle.pageCount, 2);
  assert.equal(handle.count, 3);

  // A DIFFERENT store instance (as a downstream node / worker would construct)
  // reads the collection purely from the self-describing handle — proving the
  // data lives on disk, not in the writer's process memory.
  const reader = new FileSystemCollectionStore("/some/other/root");
  assert.deepEqual(await reader.readPage(handle, 0), [{ id: "a" }, { id: "b" }]);
  assert.deepEqual(await reader.readPage(handle, 1), [{ id: "c" }]);
  // Out-of-range page is empty, not an error.
  assert.deepEqual(await reader.readPage(handle, 2), []);
});

test("isCollectionHandle rejects plain objects / arrays", () => {
  assert.equal(isCollectionHandle({ id: "x" }), false);
  assert.equal(isCollectionHandle([1, 2, 3]), false);
  assert.equal(isCollectionHandle(null), false);
});
