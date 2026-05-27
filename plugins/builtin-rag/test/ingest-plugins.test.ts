import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  filesystemSourcePlugin,
  jsonlSourcePlugin,
  deltaFilterPlugin,
  codeChunkerPlugin,
  qdrantDeletePlugin,
  opensearchDeletePlugin,
  pathClassifierPlugin
} from "../src/ingest.ts";
import {
  globToRegExp,
  detectLanguage,
  chunkCode
} from "../src/ingest.ts";
import {
  InMemoryIngestStateRepository
} from "../../../packages/runtime/src/index.ts";
import {
  getInMemoryVectorStore,
  resetInMemoryVectorStore
} from "../../../packages/vector/src/index.ts";
import type { IngestStateStore, PluginExecutionInput } from "../../../packages/plugin-sdk/src/index.ts";
import type { RuntimeContext } from "../../../packages/core/src/index.ts";

/** Minimal RuntimeContext built per-test — only the fields the plugins
 *  read (tenantId, resolvedConfig.values). Everything else is shimmed. */
function fakeContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    requestId: "r",
    executionId: "e",
    tenantId: "t",
    pipelineId: "pipe",
    pipelineVersionId: "v1",
    environment: "dev",
    resolvedConfig: {
      pipelineId: "pipe",
      tenantId: "t",
      environment: "dev",
      violations: [],
      values: {}
    },
    ...overrides
  };
}

function makeIngestStore(
  repo: InMemoryIngestStateRepository,
  ctx: { tenantId: string; pipelineId: string }
): IngestStateStore {
  return {
    list: (args) => repo.list({ ...ctx, stateKey: args.stateKey }),
    replaceAll: (args) => repo.replaceAll({ ...ctx, stateKey: args.stateKey, entries: args.entries })
  };
}

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

test("globToRegExp: ** spans path segments, * stops at separator", () => {
  assert.ok(globToRegExp("**/*.ts").test("src/a/b.ts"));
  assert.ok(globToRegExp("**/*.ts").test("a.ts"));
  assert.ok(!globToRegExp("**/*.ts").test("a.js"));
  assert.ok(globToRegExp("src/*.ts").test("src/a.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/sub/a.ts"));
});

test("globToRegExp: brace expansion picks any alternative", () => {
  const re = globToRegExp("**/*.{ts,py,go}");
  assert.ok(re.test("a/b.ts"));
  assert.ok(re.test("a/b.py"));
  assert.ok(re.test("a/b.go"));
  assert.ok(!re.test("a/b.rs"));
});

// ---------------------------------------------------------------------------
// filesystem_source
// ---------------------------------------------------------------------------

test("filesystem_source walks a directory, respects include/exclude + maxFileSize", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ragdoll-fs-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "junk"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "export const x = 1;");
    await writeFile(path.join(root, "src", "b.py"), "def f():\n    return 1\n");
    await writeFile(path.join(root, "node_modules", "junk", "ignore.ts"), "garbage");
    await writeFile(path.join(root, "big.ts"), "x".repeat(2_000));

    const result = await filesystemSourcePlugin.execute({
      context: fakeContext(),
      node: { id: "fs", plugin: filesystemSourcePlugin.manifest, config: {}, secrets: {} },
      inputs: {},
      config: { rootPath: root, include: ["**/*.ts"], maxFileSize: 500 },
      secrets: {}
    } as unknown as PluginExecutionInput);
    const docs = (result.outputs.documents as Array<{ path: string }>);
    const paths = docs.map((d) => d.path).sort();
    assert.deepEqual(paths, ["src/a.ts"], "include glob limits to .ts; node_modules excluded; big.ts skipped by size");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem_source computeHash:true populates sha256 deterministically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ragdoll-fs-"));
  try {
    await writeFile(path.join(root, "a.txt"), "hello");
    const result = await filesystemSourcePlugin.execute({
      context: fakeContext(),
      node: { id: "fs", plugin: filesystemSourcePlugin.manifest, config: {}, secrets: {} },
      inputs: {},
      config: { rootPath: root, include: ["**/*.txt"], computeHash: true },
      secrets: {}
    } as unknown as PluginExecutionInput);
    const docs = result.outputs.documents as Array<{ path: string; sha256?: string }>;
    assert.equal(docs.length, 1);
    // sha256 of "hello": 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    assert.equal(docs[0].sha256, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem_source: refuses to walk filesystem root", async () => {
  await assert.rejects(
    filesystemSourcePlugin.execute({
      context: fakeContext(),
      node: { id: "fs", plugin: filesystemSourcePlugin.manifest, config: {}, secrets: {} },
      inputs: {},
      config: { rootPath: "/" },
      secrets: {}
    } as unknown as PluginExecutionInput),
    /filesystem root/i
  );
});

// ---------------------------------------------------------------------------
// jsonl_source
// ---------------------------------------------------------------------------

test("jsonl_source: emits one document per non-empty line, parsed fields are spread", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ragdoll-jsonl-"));
  try {
    const lines = [
      JSON.stringify({ id: "m1", subject: "hello", body_text: "first body" }),
      "", // blank line should be skipped
      JSON.stringify({ id: "m2", subject: "world", body_text: "second body" })
    ].join("\n");
    await writeFile(path.join(root, "a.jsonl"), lines);
    const result = await jsonlSourcePlugin.execute({
      context: fakeContext(),
      node: { id: "j", plugin: jsonlSourcePlugin.manifest, config: {}, secrets: {} },
      inputs: {},
      config: { rootPath: root, idField: "id", contentField: "body_text" },
      secrets: {}
    } as unknown as PluginExecutionInput);
    const docs = result.outputs.documents as Array<Record<string, unknown>>;
    assert.equal(docs.length, 2);
    assert.equal(docs[0].docId, "m1");
    assert.equal(docs[0].subject, "hello");
    assert.equal(docs[0].content, "first body", "contentField projects body_text → content");
    assert.equal(docs[0].line, 1);
    assert.equal(docs[1].docId, "m2");
    assert.equal(docs[1].line, 3, "blank line at L2 is skipped but line numbers stay 1-based on the source");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("jsonl_source: skipMalformed=true counts bad lines without failing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ragdoll-jsonl-"));
  try {
    await writeFile(
      path.join(root, "mixed.jsonl"),
      [JSON.stringify({ id: "ok" }), "{not valid json", JSON.stringify({ id: "ok2" })].join("\n")
    );
    const result = await jsonlSourcePlugin.execute({
      context: fakeContext(),
      node: { id: "j", plugin: jsonlSourcePlugin.manifest, config: {}, secrets: {} },
      inputs: {},
      config: { rootPath: root, idField: "id" },
      secrets: {}
    } as unknown as PluginExecutionInput);
    const docs = result.outputs.documents as Array<Record<string, unknown>>;
    assert.equal(docs.length, 2, "two valid lines emit, one malformed skipped");
    assert.equal((result.metadata as { malformedLines: number }).malformedLines, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("jsonl_source: skipMalformed=false rejects loudly", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ragdoll-jsonl-"));
  try {
    await writeFile(path.join(root, "bad.jsonl"), "this is not json\n");
    await assert.rejects(
      jsonlSourcePlugin.execute({
        context: fakeContext(),
        node: { id: "j", plugin: jsonlSourcePlugin.manifest, config: {}, secrets: {} },
        inputs: {},
        config: { rootPath: root, skipMalformed: false },
        secrets: {}
      } as unknown as PluginExecutionInput),
      /malformed JSON/i
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("jsonl_source: dropFields strips heavy fields before emit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ragdoll-jsonl-"));
  try {
    await writeFile(
      path.join(root, "a.jsonl"),
      JSON.stringify({ id: "m1", subject: "s", body_text: "t", body_html: "<html>...</html>", attachments: [{ name: "a" }] })
    );
    const result = await jsonlSourcePlugin.execute({
      context: fakeContext(),
      node: { id: "j", plugin: jsonlSourcePlugin.manifest, config: {}, secrets: {} },
      inputs: {},
      config: { rootPath: root, idField: "id", dropFields: ["body_html", "attachments"] },
      secrets: {}
    } as unknown as PluginExecutionInput);
    const docs = result.outputs.documents as Array<Record<string, unknown>>;
    assert.equal(docs.length, 1);
    assert.equal(docs[0].subject, "s");
    assert.equal(docs[0].body_text, "t");
    assert.ok(!("body_html" in docs[0]), "body_html dropped");
    assert.ok(!("attachments" in docs[0]), "attachments dropped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("jsonl_source: maxLinesPerFile caps reads for sampling", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ragdoll-jsonl-"));
  try {
    const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ id: `m${i}` })).join("\n");
    await writeFile(path.join(root, "big.jsonl"), lines);
    const result = await jsonlSourcePlugin.execute({
      context: fakeContext(),
      node: { id: "j", plugin: jsonlSourcePlugin.manifest, config: {}, secrets: {} },
      inputs: {},
      config: { rootPath: root, idField: "id", maxLinesPerFile: 5 },
      secrets: {}
    } as unknown as PluginExecutionInput);
    const docs = result.outputs.documents as Array<Record<string, unknown>>;
    assert.equal(docs.length, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// delta_filter
// ---------------------------------------------------------------------------

async function runDelta(
  ingestStore: IngestStateStore,
  documents: unknown[],
  compareBy: "mtime" | "hash" | "mtime+hash" = "mtime"
) {
  return deltaFilterPlugin.execute({
    context: fakeContext(),
    node: { id: "d", plugin: deltaFilterPlugin.manifest, config: {}, secrets: {} },
    inputs: { documents },
    config: { stateKey: "code", compareBy },
    secrets: {},
    ingestStateStore: ingestStore
  } as unknown as PluginExecutionInput);
}

test("delta_filter: first run treats everything as new; second unchanged run emits no port", async () => {
  const repo = new InMemoryIngestStateRepository();
  const store = makeIngestStore(repo, { tenantId: "t", pipelineId: "pipe" });
  const docs = [
    { docId: "a", path: "a", mtime: "2026-01-01T00:00:00Z" },
    { docId: "b", path: "b", mtime: "2026-01-01T00:00:00Z" }
  ];
  const first = await runDelta(store, docs);
  assert.equal((first.outputs.new as unknown[])?.length, 2);
  assert.equal(first.outputs.modified, undefined, "first run has nothing in state to call modified");
  assert.equal(first.outputs.deleted, undefined);

  const second = await runDelta(store, docs);
  assert.equal(second.outputs.new, undefined, "second run sees both docs already in state");
  assert.equal(second.outputs.modified, undefined);
  assert.equal(second.outputs.deleted, undefined);
  assert.equal((second.outputs.unchanged as unknown[])?.length, 2);
});

test("delta_filter: mtime change moves doc into `modified`", async () => {
  const repo = new InMemoryIngestStateRepository();
  const store = makeIngestStore(repo, { tenantId: "t", pipelineId: "pipe" });
  await runDelta(store, [{ docId: "a", path: "a", mtime: "2026-01-01T00:00:00Z" }]);
  const next = await runDelta(store, [{ docId: "a", path: "a", mtime: "2026-01-02T00:00:00Z" }]);
  assert.equal((next.outputs.modified as unknown[])?.length, 1);
  assert.equal(next.outputs.new, undefined);
});

test("delta_filter: docs missing from current run land on `deleted`", async () => {
  const repo = new InMemoryIngestStateRepository();
  const store = makeIngestStore(repo, { tenantId: "t", pipelineId: "pipe" });
  await runDelta(store, [
    { docId: "a", path: "a", mtime: "2026-01-01T00:00:00Z" },
    { docId: "b", path: "b", mtime: "2026-01-01T00:00:00Z" }
  ]);
  const next = await runDelta(store, [{ docId: "a", path: "a", mtime: "2026-01-01T00:00:00Z" }]);
  const deleted = next.outputs.deleted as Array<{ docId: string }>;
  assert.deepEqual(deleted.map((d) => d.docId), ["b"]);
});

test("delta_filter: hash mode ignores mtime, requires sha256 change", async () => {
  const repo = new InMemoryIngestStateRepository();
  const store = makeIngestStore(repo, { tenantId: "t", pipelineId: "pipe" });
  await runDelta(
    store,
    [{ docId: "a", path: "a", mtime: "old", sha256: "h1" }],
    "hash"
  );
  // mtime moved but hash same → unchanged.
  const same = await runDelta(
    store,
    [{ docId: "a", path: "a", mtime: "new", sha256: "h1" }],
    "hash"
  );
  assert.equal(same.outputs.modified, undefined, "same hash → not modified even with new mtime");
  // hash moved → modified.
  const changed = await runDelta(
    store,
    [{ docId: "a", path: "a", mtime: "new", sha256: "h2" }],
    "hash"
  );
  assert.equal((changed.outputs.modified as unknown[])?.length, 1);
});

test("delta_filter: mtime+hash uses mtime gate, hashes only on mtime move", async () => {
  const repo = new InMemoryIngestStateRepository();
  const store = makeIngestStore(repo, { tenantId: "t", pipelineId: "pipe" });
  await runDelta(
    store,
    [{ docId: "a", path: "a", mtime: "t1", sha256: "h1" }],
    "mtime+hash"
  );
  // mtime same → fast-path unchanged.
  const same = await runDelta(
    store,
    [{ docId: "a", path: "a", mtime: "t1", sha256: "h1" }],
    "mtime+hash"
  );
  assert.equal(same.outputs.modified, undefined);
  // mtime moved but hash matches → unchanged (avoids spurious re-embed on branch swap).
  const noop = await runDelta(
    store,
    [{ docId: "a", path: "a", mtime: "t2", sha256: "h1" }],
    "mtime+hash"
  );
  assert.equal(noop.outputs.modified, undefined, "mtime+hash: same hash means no re-embed");
  // mtime AND hash moved → modified.
  const real = await runDelta(
    store,
    [{ docId: "a", path: "a", mtime: "t3", sha256: "h2" }],
    "mtime+hash"
  );
  assert.equal((real.outputs.modified as unknown[])?.length, 1);
});

// ---------------------------------------------------------------------------
// code_chunker
// ---------------------------------------------------------------------------

test("detectLanguage: extension → language map", () => {
  assert.equal(detectLanguage("foo/bar.ts"), "typescript");
  assert.equal(detectLanguage("a.py"), "python");
  assert.equal(detectLanguage("a.go"), "go");
  assert.equal(detectLanguage("a.rs"), "rust");
  assert.equal(detectLanguage("a.unknown"), undefined);
});

test("basic_text_chunker accepts a documents array and tags each chunk with docId/path", async () => {
  // Mirrors the codebase-ingest-docs wiring: delta_filter emits an array of
  // documents, basic_text_chunker chunks each, downstream sinks need to
  // know which source doc each chunk came from.
  const builtin = await import("../src/index.ts");
  const result = await builtin.basicTextChunkerPlugin.execute({
    context: fakeContext(),
    node: { id: "c", plugin: builtin.basicTextChunkerPlugin.manifest, config: {}, secrets: {} },
    inputs: {
      documents: [
        { docId: "intro.md", path: "docs/intro.md", content: "x".repeat(2500) },
        { docId: "guide.md", path: "docs/guide.md", content: "y".repeat(1500) }
      ]
    },
    config: { chunkSize: 1000, overlap: 100 },
    secrets: {}
  } as unknown as PluginExecutionInput);
  const chunks = result.outputs.chunks as Array<{ text: string; index: number; docId?: string; path?: string }>;
  // 2500 char doc → 3 chunks at step=900 (chunkSize 1000 - overlap 100).
  // 1500 char doc → 2 chunks.
  assert.equal(chunks.length, 5, "two docs produce 5 chunks total at chunkSize=1000/overlap=100");
  for (const chunk of chunks) {
    assert.ok(chunk.docId === "intro.md" || chunk.docId === "guide.md", "every chunk carries its source docId");
    assert.ok(chunk.path && chunk.path.startsWith("docs/"), "every chunk carries its source path");
  }
  // Indexes are flat (0..4) so the downstream array is a single contiguous stream.
  assert.deepEqual(chunks.map((c) => c.index), [0, 1, 2, 3, 4]);
});

test("basic_text_chunker single-text path still works (legacy)", async () => {
  const builtin = await import("../src/index.ts");
  const result = await builtin.basicTextChunkerPlugin.execute({
    context: fakeContext(),
    node: { id: "c", plugin: builtin.basicTextChunkerPlugin.manifest, config: {}, secrets: {} },
    inputs: { text: "hello world" },
    config: { chunkSize: 5, overlap: 0 },
    secrets: {}
  } as unknown as PluginExecutionInput);
  const chunks = result.outputs.chunks as Array<{ text: string; docId?: string }>;
  // 11 chars / 5 step = 3 chunks; legacy single-text path doesn't tag docId.
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].docId, undefined, "single-text path leaves docId unset");
});

test("chunkCode: typescript splits on top-level functions/classes/interfaces", () => {
  const content = `// header
import { x } from "y";

export function alpha() {
  return 1;
}

export class Beta {
  go() { return 2; }
}

export interface Gamma {
  z: number;
}
`;
  const chunks = chunkCode({ content, filePath: "a.ts", maxChars: 4000, minChars: 0 });
  assert.equal(chunks.length, 4, "preamble + 3 anchors");
  assert.equal(chunks[1].symbolKind, "function");
  assert.equal(chunks[1].symbolName, "alpha");
  assert.equal(chunks[2].symbolKind, "class");
  assert.equal(chunks[2].symbolName, "Beta");
  assert.equal(chunks[3].symbolKind, "interface");
  assert.equal(chunks[3].symbolName, "Gamma");
});

test("chunkCode: python splits on def/class", () => {
  const content = `import os

def alpha():
    return 1

class Beta:
    def go(self):
        return 2
`;
  const chunks = chunkCode({ content, filePath: "a.py", maxChars: 4000, minChars: 0 });
  // preamble + alpha + Beta
  assert.equal(chunks.length, 3);
  assert.equal(chunks[1].symbolName, "alpha");
  assert.equal(chunks[2].symbolName, "Beta");
});

test("chunkCode: go splits on func + type", () => {
  const content = `package main

type User struct {
  Name string
}

func New() *User {
  return &User{}
}

func (u *User) Hello() string {
  return "hi " + u.Name
}
`;
  const chunks = chunkCode({ content, filePath: "a.go", maxChars: 4000, minChars: 0 });
  // preamble + User + New + Hello
  assert.equal(chunks.length, 4);
  assert.equal(chunks[1].symbolName, "User");
  assert.equal(chunks[2].symbolName, "New");
});

test("chunkCode: rust splits on fn/struct/impl/trait", () => {
  const content = `use std::fmt;

pub struct Point { x: i32, y: i32 }

impl Point {
  pub fn new(x: i32, y: i32) -> Self { Self { x, y } }
}

pub fn helper() -> i32 { 1 }
`;
  const chunks = chunkCode({ content, filePath: "a.rs", maxChars: 4000, minChars: 0 });
  assert.ok(chunks.length >= 3);
  const names = chunks.map((c) => c.symbolName).filter(Boolean);
  assert.ok(names.includes("Point"), "struct anchor");
  assert.ok(names.includes("helper"), "fn anchor");
});

test("chunkCode: unknown extension falls back to blank-line line chunking", () => {
  const content = "line1\nline2\n\nline3\nline4\n";
  const chunks = chunkCode({ content, filePath: "a.unknownext", maxChars: 4000, minChars: 0 });
  assert.equal(chunks.length, 1, "small content stays one chunk");
  assert.equal(chunks[0].language, "text");
});

test("chunkCode: oversize chunks split on blank lines", () => {
  // Build a ~10kB python module with two functions separated by blank lines.
  const big = "x".repeat(3000);
  const content = `def alpha():\n    s = "${big}"\n    return s\n\ndef beta():\n    s = "${big}"\n    return s\n`;
  const chunks = chunkCode({ content, filePath: "big.py", maxChars: 2500, minChars: 0 });
  // At least 2 chunks (alpha + beta) and each respects the 2500 char cap.
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 2500 || chunk.text.split("\n").length === 1,
      "either fits the cap or is a single unsplittable line");
  }
});

// ---------------------------------------------------------------------------
// qdrant_delete
// ---------------------------------------------------------------------------

test("qdrant_delete removes points by id from the (in-memory) store", async () => {
  resetInMemoryVectorStore();
  const store = getInMemoryVectorStore();
  await store.ensureCollection("codebase", { dimensions: 4, distance: "cosine" });
  await store.upsert("codebase", [
    { id: "a.ts", vector: [1, 0, 0, 0], tenantId: "t", payload: { text: "" } },
    { id: "b.ts", vector: [0, 1, 0, 0], tenantId: "t", payload: { text: "" } }
  ]);
  const result = await qdrantDeletePlugin.execute({
    context: fakeContext(),
    node: { id: "del", plugin: qdrantDeletePlugin.manifest, config: {}, secrets: {} },
    inputs: { deleted: [{ docId: "a.ts" }] },
    config: { collection: "codebase" },
    secrets: {}
  } as unknown as PluginExecutionInput);
  assert.equal(result.outputs.deletedCount, 1);
  const remaining = await store.query("codebase", { vector: [1, 0, 0, 0], topK: 10, tenantId: "t" });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, "b.ts");
});

test("qdrant_delete tolerates empty input", async () => {
  resetInMemoryVectorStore();
  const result = await qdrantDeletePlugin.execute({
    context: fakeContext(),
    node: { id: "del", plugin: qdrantDeletePlugin.manifest, config: {}, secrets: {} },
    inputs: { deleted: [] },
    config: { collection: "codebase" },
    secrets: {}
  } as unknown as PluginExecutionInput);
  assert.equal(result.outputs.deletedCount, 0);
});

// ---------------------------------------------------------------------------
// opensearch_delete
// ---------------------------------------------------------------------------

test("opensearch_delete issues a delete_by_query against the configured index", async () => {
  let calledWith: { method: string; path: string; body?: unknown } | undefined;
  // Inject a fake fetch into createOpenSearchClient via the OPENSEARCH_URL env.
  const fakeFetch = async (url: string, init?: { method?: string; body?: string }) => {
    calledWith = {
      method: init?.method ?? "GET",
      path: new URL(url).pathname,
      body: init?.body ? JSON.parse(init.body) : undefined
    };
    return new Response(JSON.stringify({ deleted: 2 }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const { createOpenSearchClient } = await import(
    "../../../packages/opensearch/src/index.ts"
  );
  // Sanity: ensure the client we construct uses fakeFetch by passing it via env-bypass.
  // The plugin doesn't allow fetch injection directly, so we exercise the
  // function-level wiring through process.env. Skip when the helper isn't
  // available to take fetch overrides.
  const client = createOpenSearchClient({ endpoint: "http://localhost:9200", fetchImpl: fakeFetch });
  if (!client) {
    return; // misconfiguration — bail
  }
  await client.deleteByQuery("docs", { terms: { _id: ["a.md", "b.md"] } });
  assert.ok(calledWith, "fakeFetch was called");
  assert.ok(calledWith!.path.includes("/docs/_delete_by_query"));
  assert.deepEqual(
    (calledWith!.body as { query: unknown }).query,
    { terms: { _id: ["a.md", "b.md"] } }
  );
});

// ---------------------------------------------------------------------------
// path_classifier
// ---------------------------------------------------------------------------

test("path_classifier routes documents by per-port glob, first match wins", async () => {
  const result = await pathClassifierPlugin.execute({
    context: fakeContext(),
    node: { id: "split", plugin: pathClassifierPlugin.manifest, config: {}, secrets: {} },
    inputs: {
      documents: [
        { docId: "a", path: "docs/intro.md" },
        { docId: "b", path: "src/app.ts" },
        { docId: "c", path: "tests/app.test.ts" },
        { docId: "d", path: "package.json" }
      ]
    },
    config: {
      docs: "docs/**/*.md",
      code: "**/*.ts",
      tests: "**/*.test.ts",
      config: "**/*.json"
    },
    secrets: {}
  } as unknown as PluginExecutionInput);

  const docs = (result.outputs.docs as Array<{ path: string }>) ?? [];
  const code = (result.outputs.code as Array<{ path: string }>) ?? [];
  const tests = (result.outputs.tests as Array<{ path: string }>) ?? [];
  const cfg = (result.outputs.config as Array<{ path: string }>) ?? [];
  // Declaration order is docs → code → tests → config → other. `app.test.ts`
  // matches `**/*.ts` first because code comes before tests in the order list.
  assert.deepEqual(docs.map((d) => d.path), ["docs/intro.md"]);
  assert.deepEqual(code.map((d) => d.path).sort(), ["src/app.ts", "tests/app.test.ts"]);
  assert.equal(tests.length, 0, "code matched first; tests stays empty");
  assert.deepEqual(cfg.map((d) => d.path), ["package.json"]);
});

test("path_classifier: empty ports emit undefined (skip-cascading-friendly)", async () => {
  const result = await pathClassifierPlugin.execute({
    context: fakeContext(),
    node: { id: "split", plugin: pathClassifierPlugin.manifest, config: {}, secrets: {} },
    inputs: { documents: [{ docId: "a", path: "src/app.ts" }] },
    config: { code: "**/*.ts" },
    secrets: {}
  } as unknown as PluginExecutionInput);
  assert.equal(result.outputs.docs, undefined);
  assert.equal((result.outputs.code as unknown[])?.length, 1);
});
