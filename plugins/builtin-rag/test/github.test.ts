/**
 * github_source plugin — exercised against a stubbed `globalThis.fetch`
 * so the suite stays offline. Three real behaviours covered:
 *
 *   1. happy path: tree → raw fetch per blob → documents emitted
 *      under the include glob, exclude glob applied;
 *   2. auth + diagnostics: 404 / 401 surface as actionable errors;
 *   3. NUL scrub: binary-heavy blobs are dropped, sparse-NUL text is
 *      sanitized in place (Postgres JSONB safety).
 *
 * The plugin uses `globalThis.fetch` directly (no injectable client),
 * so each test swaps it out and restores in a `try/finally`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { githubSourcePlugin } from "../src/github.ts";
import type {
  PluginExecutionInput,
  PluginExecutionOutput
} from "../../../packages/plugin-sdk/src/index.ts";
import type { RuntimeContext } from "../../../packages/core/src/index.ts";

function fakeContext(): RuntimeContext {
  return {
    requestId: "r",
    executionId: "e-1",
    tenantId: "t-1",
    pipelineId: "p",
    pipelineVersionId: "v1",
    environment: "dev",
    resolvedConfig: {
      pipelineId: "p",
      tenantId: "t-1",
      environment: "dev",
      violations: [],
      values: {}
    }
  };
}

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

/** Install a fake `fetch` that routes `/git/trees/` to the `tree`
 *  response and any raw.githubusercontent.com URL to the `files`
 *  map; tracks every call so tests can assert URL + headers. */
function installFakeFetch(
  tree: Array<{ path: string; type?: "blob"; size?: number; sha?: string }>,
  files: Record<string, string | { status: number; body?: string }>
): { restore: () => void; calls: FetchCall[] } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = url.toString();
    const headers = (init?.headers as Record<string, string>) ?? {};
    calls.push({ url: u, headers });
    // Default-branch lookup: github_source hits /repos/{owner}/{name}
    // first when `ref` is unset / "HEAD" / "default" (recent change).
    // Tests that pass an explicit `ref` skip this entirely.
    if (/\/repos\/[^/]+\/[^/]+(?:\?|$)/.test(u) && !u.includes("/git/trees/")) {
      return new Response(
        JSON.stringify({ default_branch: "main" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (u.includes("/git/trees/")) {
      return new Response(
        JSON.stringify({
          tree: tree.map((n) => ({
            path: n.path,
            type: n.type ?? "blob",
            size: n.size ?? n.path.length,
            sha: n.sha ?? "deadbeef"
          })),
          truncated: false
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    const rawPrefix = "https://raw.githubusercontent.com/";
    if (u.startsWith(rawPrefix)) {
      const after = u.slice(rawPrefix.length);
      // owner/repo/ref/path/inside/file.ts — strip the first three
      // segments (owner, repo, encoded ref) to get the relative path.
      const segs = after.split("/");
      const rel = segs.slice(3).map(decodeURIComponent).join("/");
      const hit = files[rel];
      if (hit === undefined) {
        return new Response("not found", { status: 404 });
      }
      if (typeof hit === "string") {
        return new Response(hit, {
          status: 200,
          headers: { "content-type": "text/plain" }
        });
      }
      return new Response(hit.body ?? "", { status: hit.status });
    }
    return new Response("unhandled", { status: 500 });
  }) as unknown as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    calls
  };
}

function runGithub(args: {
  config: Record<string, unknown>;
  secrets?: Record<string, string>;
}): Promise<PluginExecutionOutput> {
  const input: PluginExecutionInput = {
    context: fakeContext(),
    node: {
      id: "fs",
      plugin: { category: "datasource", id: "github_source", version: "1.0.0" }
    },
    inputs: {},
    config: args.config,
    secrets: args.secrets ?? {}
  };
  return githubSourcePlugin.execute(input);
}

test("github_source: tree + raw fetches produce one document per matching blob", async () => {
  const { restore, calls } = installFakeFetch(
    [
      { path: "README.md" },
      { path: "src/index.ts" },
      { path: "src/util.ts" },
      { path: "dist/index.js" }, // excluded by default
      { path: "tests/index.test.ts" }
    ],
    {
      "README.md": "# repo\nhello",
      "src/index.ts": "export const x = 1;",
      "src/util.ts": "export const y = 2;",
      "tests/index.test.ts": "test('ok')"
    }
  );
  try {
    const result = await runGithub({
      config: {
        repo: "octocat/hello",
        ref: "main",
        include: ["src/**/*.ts", "README.md"]
      }
    });
    const docs = result.outputs.documents as Array<{
      docId: string;
      content: string;
    }>;
    const paths = docs.map((d) => d.docId).sort();
    assert.deepEqual(paths, ["README.md", "src/index.ts", "src/util.ts"]);
    const readme = docs.find((d) => d.docId === "README.md");
    assert.equal(readme?.content, "# repo\nhello");
    // The tree call must hit the API host with the recursive flag.
    const treeCall = calls.find((c) => c.url.includes("/git/trees/"));
    assert.ok(treeCall, "tree call missing");
    assert.ok(treeCall!.url.includes("recursive=1"));
  } finally {
    restore();
  }
});

test("github_source: token rides on the Authorization header for every fetch", async () => {
  const { restore, calls } = installFakeFetch(
    [{ path: "a.txt" }],
    { "a.txt": "alpha" }
  );
  try {
    await runGithub({
      config: { repo: "octocat/hello", include: ["**/*.txt"] },
      secrets: { token: "ghp_fake_secret_abc" }
    });
    for (const c of calls) {
      assert.equal(
        c.headers.authorization,
        "Bearer ghp_fake_secret_abc",
        `missing auth on ${c.url}`
      );
    }
  } finally {
    restore();
  }
});

test("github_source: 404 from the tree surfaces a clear error", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("not found", { status: 404 })) as unknown as typeof fetch;
  try {
    await assert.rejects(
      () => runGithub({ config: { repo: "octocat/nope", ref: "main" } }),
      /404 — wrong repo \/ ref\?/
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("github_source: 401 mentions the missing token / scope", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
  try {
    await assert.rejects(
      () => runGithub({ config: { repo: "private/repo", ref: "main" } }),
      /token missing or insufficient scope/
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("github_source: dense-NUL blobs are dropped, sparse-NUL text is sanitized", async () => {
  // First file: NUL density above the 1% / 8-count floor → drop.
  // Second file: a single stray NUL in long otherwise-ASCII text →
  // keep the file but scrub the NUL to U+FFFD before emitting.
  const denseNul = "\u0000".repeat(50) + "x".repeat(50);
  const sparseNulText = "ok\u0000more text".padEnd(2000, " ") + "\u0000";
  const { restore } = installFakeFetch(
    [{ path: "bin.dat" }, { path: "log.txt" }],
    { "bin.dat": denseNul, "log.txt": sparseNulText }
  );
  try {
    const result = await runGithub({
      config: { repo: "x/y", include: ["**/*"] }
    });
    const docs = result.outputs.documents as Array<{
      docId: string;
      content: string;
    }>;
    assert.equal(docs.length, 1, "binary blob should be dropped");
    assert.equal(docs[0].docId, "log.txt");
    assert.ok(
      !docs[0].content.includes("\u0000"),
      "sparse NUL should have been scrubbed"
    );
    assert.ok(docs[0].content.includes("�"), "scrub replacement present");
  } finally {
    restore();
  }
});

test("github_source: rejects malformed repo strings before any network call", async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("ok");
  }) as unknown as typeof fetch;
  try {
    await assert.rejects(
      () => runGithub({ config: { repo: "not-a-valid-repo" } }),
      /must be `owner\/name`/
    );
    assert.equal(called, false, "no fetch should have happened");
  } finally {
    globalThis.fetch = original;
  }
});

test("github_source: manifest exposes config + secrets schema for the Builder", () => {
  const m = githubSourcePlugin.manifest;
  assert.equal(m.id, "github_source");
  assert.equal(m.category, "datasource");
  // The Builder relies on `secret-ref` formatting to render a secret
  // picker instead of a plain text input.
  const tokenProp = (m.secretsSchema as
    | { properties?: { token?: { format?: string } } }
    | undefined)?.properties?.token;
  assert.equal(tokenProp?.format, "secret-ref");
  // Output ports include the documents + repo summary.
  const out = m.outputPorts ?? [];
  assert.ok(out.some((p) => p.name === "documents"));
  assert.ok(out.some((p) => p.name === "repo"));
});
