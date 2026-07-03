/**
 * Sidecar hook host (ADR 0036): the operator-configured out-of-process hook.
 * before() translates the sidecar's JSON verdict into an InterceptorDecision;
 * on() fire-and-forgets; a down sidecar is fail-open (or fail-closed).
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { sidecarHookPlugin } from "../src/platform-sidecar.ts";
import type { MutationEvent } from "../../../packages/platform-plugins/src/index.ts";

function sidecar(
  respond: (
    phase: string | undefined
  ) => { status: number; body?: unknown }
): Promise<{
  url: string;
  posts: Array<{ phase?: string; body: string }>;
  close: () => Promise<void>;
}> {
  const posts: Array<{ phase?: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const phase = req.headers["x-ragdoll-phase"] as string | undefined;
      posts.push({ phase, body: Buffer.concat(chunks).toString("utf8") });
      const { status, body } = respond(phase);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        posts,
        close: () => new Promise<void>((d) => server.close(() => d()))
      });
    });
  });
}

const ev: MutationEvent = {
  id: "m1",
  correlationId: "r1",
  event: "pipeline.deploy",
  phase: "pre",
  category: "mutation",
  at: "2026-01-01T00:00:00Z",
  actor: { id: "admin" },
  tenantId: "t1",
  target: { type: "pipeline_deployment", id: "d1" }
};

test("sidecar pre 'deny' → deny with status", async () => {
  const srv = await sidecar(() => ({
    status: 200,
    body: { decision: "deny", reason: "nope", status: 429 }
  }));
  try {
    const d = await sidecarHookPlugin({ url: srv.url }).before!(ev, {});
    assert.equal(d.action, "deny");
    assert.equal((d as { status?: number }).status, 429);
    assert.equal(srv.posts[0].phase, "pre");
  } finally {
    await srv.close();
  }
});

test("sidecar pre 'mutate' → mutate patch", async () => {
  const srv = await sidecar(() => ({
    status: 200,
    body: { decision: "mutate", patch: { after: { redacted: true } } }
  }));
  try {
    const d = await sidecarHookPlugin({ url: srv.url }).before!(ev, {});
    assert.equal(d.action, "mutate");
    assert.deepEqual((d as { patch: unknown }).patch, { after: { redacted: true } });
  } finally {
    await srv.close();
  }
});

test("sidecar pre 'fail' → fail", async () => {
  const srv = await sidecar(() => ({ status: 200, body: { decision: "fail", reason: "x" } }));
  try {
    const d = await sidecarHookPlugin({ url: srv.url }).before!(ev, {});
    assert.equal(d.action, "fail");
  } finally {
    await srv.close();
  }
});

test("sidecar 5xx is fail-open by default, fail-closed when configured", async () => {
  const srv = await sidecar(() => ({ status: 500 }));
  try {
    const open = await sidecarHookPlugin({ url: srv.url }).before!(ev, {});
    assert.equal(open.action, "continue");
    const closed = await sidecarHookPlugin({ url: srv.url, failClosed: true }).before!(ev, {});
    assert.equal(closed.action, "deny");
  } finally {
    await srv.close();
  }
});

test("sidecar on() posts the event (phase=post) fire-and-forget", async () => {
  const srv = await sidecar(() => ({ status: 200 }));
  try {
    await sidecarHookPlugin({ url: srv.url }).on!({ ...ev, phase: "post" }, {});
    assert.equal(srv.posts.length, 1);
    assert.equal(srv.posts[0].phase, "post");
    assert.equal(JSON.parse(srv.posts[0].body).event, "pipeline.deploy");
  } finally {
    await srv.close();
  }
});
