/**
 * Tests for the CLI's cascade-delete helpers (apps/cli/src/cascade.ts)
 * + a smoke-test that every delete command actually appends ?force=true
 * when --force is passed.
 *
 * No subprocess shell-out — registers the commands against an
 * in-process `commander` program, intercepts `globalThis.fetch` to
 * capture the URL each delete hits, and asserts the wire shape.
 * Keeps the test fast + survives `npm run test:cli` without needing a
 * running API.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import type { Ctx } from "../src/ctx.ts";
import { forceQs } from "../src/cascade.ts";
import { registerTenants } from "../src/commands/tenants.ts";
import { registerPipelines } from "../src/commands/pipelines.ts";
import { registerAccess } from "../src/commands/access.ts";
import { registerResources } from "../src/commands/resources.ts";

const ctx: Ctx = {
  config: { apiUrl: "http://test.invalid" },
  opts: () => ({ output: "json", apiUrl: "http://test.invalid", tenant: undefined })
};

// ---------------------------------------------------------------------------
// forceQs (pure)
// ---------------------------------------------------------------------------

test("forceQs: true -> '?force=true'; false / undefined -> '' (no query)", () => {
  assert.equal(forceQs(true), "?force=true");
  assert.equal(forceQs(false), "");
  assert.equal(forceQs(undefined), "");
});

// ---------------------------------------------------------------------------
// Delete command --force plumbing
// ---------------------------------------------------------------------------

/**
 * Build a fresh commander tree with every cascade-aware delete
 * registered, swap fetch to a capturer, run a single command, restore
 * fetch + emit/exit, and return the URLs that were hit.
 */
async function runDeleteCmd(argv: string[], responseStatus = 204): Promise<{
  calls: { method: string; url: string }[];
  exitCode: number | undefined;
}> {
  const calls: { method: string; url: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: { method?: string; body?: string }) => {
    calls.push({ method: init?.method ?? "GET", url: String(url) });
    return new Response(null, { status: responseStatus });
  }) as unknown as typeof fetch;
  // The commands write to stdout via emit; redirect to a void writer so
  // the test runner stays quiet.
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((_: string | Uint8Array) => true) as unknown as typeof process.stdout.write;
  // commander calls process.exit on errors; we capture instead.
  const realExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error(`__exit_${code}`);
  }) as never;
  try {
    const program = new Command();
    registerTenants(program, ctx);
    registerPipelines(program, ctx);
    registerAccess(program, ctx);
    registerResources(program, ctx);
    try {
      await program.parseAsync(["node", "ragdoll", ...argv]);
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith("__exit_")) throw e;
    }
  } finally {
    globalThis.fetch = realFetch;
    process.stdout.write = realStdoutWrite;
    process.exit = realExit;
  }
  return { calls, exitCode };
}

test("tenants delete: --force appends ?force=true; absent leaves the URL clean", async () => {
  const def = await runDeleteCmd(["tenants", "delete", "tenant-uuid"]);
  assert.ok(
    def.calls.some((c) => c.method === "DELETE" && c.url === "http://test.invalid/api/tenants/tenant-uuid"),
    `expected default DELETE, got: ${JSON.stringify(def.calls)}`
  );
  const force = await runDeleteCmd(["tenants", "delete", "tenant-uuid", "--force"]);
  assert.ok(
    force.calls.some((c) => c.method === "DELETE" && c.url === "http://test.invalid/api/tenants/tenant-uuid?force=true"),
    `expected force DELETE, got: ${JSON.stringify(force.calls)}`
  );
});

test("pipelines delete: --force appends ?force=true", async () => {
  const force = await runDeleteCmd(["pipelines", "delete", "p-id", "--force"]);
  assert.ok(
    force.calls.some((c) => c.url === "http://test.invalid/api/pipelines/p-id?force=true")
  );
});

test("roles delete: --force appends ?force=true", async () => {
  const force = await runDeleteCmd(["roles", "delete", "tenant_admin", "--force"]);
  assert.ok(
    force.calls.some((c) => c.url === "http://test.invalid/api/roles/tenant_admin?force=true")
  );
});

test("folders delete: --force appends ?force=true (new CLI surface)", async () => {
  const force = await runDeleteCmd(["folders", "delete", "f-id", "--force"]);
  assert.ok(
    force.calls.some((c) => c.url === "http://test.invalid/api/folders/f-id?force=true")
  );
});

test("datasets delete: --force appends ?force=true (new CLI surface)", async () => {
  const force = await runDeleteCmd(["datasets", "delete", "d-id", "--force"]);
  assert.ok(
    force.calls.some((c) => c.url === "http://test.invalid/api/datasets/d-id?force=true")
  );
});

test("connections delete: default soft-archives (no query); --force hard-deletes (new CLI surface)", async () => {
  const def = await runDeleteCmd(["connections", "delete", "c-id"]);
  assert.ok(
    def.calls.some((c) => c.url === "http://test.invalid/api/connections/c-id"),
    "default URL should NOT carry ?force=true"
  );
  const force = await runDeleteCmd(["connections", "delete", "c-id", "--force"]);
  assert.ok(
    force.calls.some((c) => c.url === "http://test.invalid/api/connections/c-id?force=true")
  );
});

// ---------------------------------------------------------------------------
// 409 has_dependents → pretty-print + exit 3
// ---------------------------------------------------------------------------

test("delete on 409 has_dependents: prints the per-kind breakdown to stderr and exits 3", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: "has_dependents",
        message: "Cannot delete folder.",
        dependents: { pipelines: 3, subfolders: 1 },
        hint: "?force=true to cascade"
      }),
      { status: 409, headers: { "content-type": "application/json" } }
    )) as unknown as typeof fetch;
  const stderrChunks: string[] = [];
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as unknown as typeof process.stderr.write;
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((_: string | Uint8Array) => true) as unknown as typeof process.stdout.write;
  const realExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error(`__exit_${code}`);
  }) as never;
  try {
    const program = new Command();
    registerResources(program, ctx);
    try {
      await program.parseAsync(["node", "ragdoll", "folders", "delete", "f-id"]);
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith("__exit_")) throw e;
    }
  } finally {
    globalThis.fetch = realFetch;
    process.stderr.write = realStderrWrite;
    process.stdout.write = realStdoutWrite;
    process.exit = realExit;
  }
  assert.equal(exitCode, 3, "cascade refusal exits 3 (distinct from generic ApiError = 2)");
  const out = stderrChunks.join("");
  assert.match(out, /3 pipelines/);
  assert.match(out, /1 subfolders/);
  assert.match(out, /--force to cascade-delete \(nukes 4 items\)/);
});
