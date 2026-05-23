/**
 * Live-events surface: audit→bus integration AND the /api/events WebSocket
 * endpoint (auth-after-open, tenant scope filtering, Builder room).
 *
 * The bus is the same `ChangeBus` interface both the audit helper and the
 * worker publish on, so a single subscriber observes everything end-to-end
 * without standing up Redis.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import WS from "ws";
import { buildHarness } from "./helpers.ts";
import { mountWebsocket } from "../src/websocket.ts";
import {
  InMemoryChangeBus,
  type ChangeEvent,
  type WsServerMessage
} from "../../../packages/events/src/index.ts";
import { PasswordService } from "../../../packages/auth/src/index.ts";

/** Insert a user + grants directly and return a Bearer token + header. */
async function seedUser(
  h: ReturnType<typeof buildHarness>,
  opts: {
    email: string;
    password?: string;
    grants?: Array<{ role: string; scope: string }>;
  }
): Promise<{ id: string; token: string; bearer: Record<string, string> }> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await h.deps.users!.create({
    id,
    email: opts.email,
    displayName: opts.email,
    passwordHash: opts.password
      ? await new PasswordService().hash(opts.password)
      : null,
    status: "active",
    createdAt: now,
    updatedAt: now
  });
  for (const g of opts.grants ?? []) {
    await h.deps.rbacPolicies!.addGrant({
      id: randomUUID(),
      userId: id,
      role: g.role,
      scope: g.scope,
      createdAt: now
    });
  }
  const token = h.sessions.sign({ id, type: "user", roles: [] }, 3600);
  return { id, token, bearer: { authorization: `Bearer ${token}` } };
}

/** Start a Fastify server mounting just `/api/events`; returns the URL the
 *  ws client should connect to plus a teardown. */
async function startWsServer(
  h: ReturnType<typeof buildHarness>,
  bus: InMemoryChangeBus
): Promise<{ url: string; close: () => Promise<void> }> {
  const app: FastifyInstance = Fastify({ logger: false });
  await mountWebsocket(app, {
    bus,
    auth: h.deps.auth,
    authorizer: h.deps.authorizer,
    logger: h.deps.logger
  });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  // Fastify returns an http:// URL; we need ws://.
  const url = `ws://${address.replace(/^https?:\/\//, "")}/api/events`;
  return { url, close: async () => void (await app.close()) };
}

/** Promise that resolves with the next server frame matching `predicate`. */
function nextFrame(
  ws: WS,
  predicate: (msg: WsServerMessage) => boolean,
  timeoutMs = 2000
): Promise<WsServerMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: WS.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as WsServerMessage;
        if (predicate(msg)) {
          ws.off("message", onMessage);
          clearTimeout(timer);
          resolve(msg);
        }
      } catch {
        /* keep listening */
      }
    };
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("WS frame timeout"));
    }, timeoutMs);
    ws.on("message", onMessage);
  });
}

function waitOpen(ws: WS): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WS.OPEN) return resolve();
    ws.once("open", () => resolve());
    ws.once("error", (e) => reject(e));
  });
}

// --- audit → bus ----------------------------------------------------------

test("audit() publishes a ChangeEvent for every mutation", async () => {
  const bus = new InMemoryChangeBus();
  const seen: ChangeEvent[] = [];
  bus.subscribe((e) => seen.push(e));
  const h = buildHarness({ withAuth: true, changeBus: bus });
  const { bearer } = await seedUser(h, {
    email: "admin@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });

  const res = await h.request({
    method: "POST",
    path: "/api/tenants",
    headers: bearer,
    body: { slug: "demo-events", name: "Demo Events" }
  });
  assert.equal(res.status, 201);

  assert.equal(seen.length, 1);
  const event = seen[0];
  assert.equal(event.action, "tenant.create");
  assert.equal(event.targetType, "tenant");
  assert.ok(event.targetId);
  // tenant.create is global scope (the actor's principal carries no tenant
  // either), so we publish with tenantId: null.
  assert.equal(event.tenantId, null);
});

// --- WebSocket: auth + delivery -------------------------------------------

test("WS rejects messages before auth and accepts a valid Bearer", async () => {
  const bus = new InMemoryChangeBus();
  const h = buildHarness({ withAuth: true, changeBus: bus });
  const { token } = await seedUser(h, {
    email: "admin@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const srv = await startWsServer(h, bus);

  const ws = new WS(srv.url);
  await waitOpen(ws);

  // Trying to subscribe before auth -> error frame.
  ws.send(JSON.stringify({ type: "ping" }));
  const err = await nextFrame(ws, (m) => m.type === "error");
  assert.equal(err.type, "error");

  ws.send(JSON.stringify({ type: "auth", token }));
  const ready = await nextFrame(ws, (m) => m.type === "ready");
  assert.equal(ready.type, "ready");

  ws.close();
  await new Promise((r) => ws.once("close", () => r(undefined)));
  await srv.close();
});

test("a tenant-scoped user only receives events for their tenant", async () => {
  const bus = new InMemoryChangeBus();
  const h = buildHarness({ withAuth: true, changeBus: bus });
  // Seed two tenants directly so we can scope grants.
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const now = new Date().toISOString();
  await h.deps.tenants.create({
    id: tenantA,
    slug: "a",
    name: "A",
    status: "active",
    metadata: {},
    createdAt: now,
    updatedAt: now
  });
  await h.deps.tenants.create({
    id: tenantB,
    slug: "b",
    name: "B",
    status: "active",
    metadata: {},
    createdAt: now,
    updatedAt: now
  });
  const { token } = await seedUser(h, {
    email: "scoped@x.io",
    grants: [{ role: "tenant_admin", scope: `t/${tenantA}` }]
  });
  const srv = await startWsServer(h, bus);

  const ws = new WS(srv.url);
  await waitOpen(ws);
  ws.send(JSON.stringify({ type: "auth", token }));
  await nextFrame(ws, (m) => m.type === "ready");

  // Publish a B-scoped event THEN an A-scoped event; the WS should drop the
  // first and deliver the second.
  await bus.publish({
    id: randomUUID(),
    action: "pipeline.update",
    targetType: "pipeline",
    targetId: "p-b",
    tenantId: tenantB,
    actorId: null,
    at: new Date().toISOString()
  });
  await bus.publish({
    id: randomUUID(),
    action: "pipeline.update",
    targetType: "pipeline",
    targetId: "p-a",
    tenantId: tenantA,
    actorId: null,
    at: new Date().toISOString()
  });

  const got = await nextFrame(ws, (m) => m.type === "event");
  assert.equal(got.type, "event");
  if (got.type === "event") {
    assert.equal(got.event.tenantId, tenantA);
    assert.equal(got.event.targetId, "p-a");
  }

  ws.close();
  await new Promise((r) => ws.once("close", () => r(undefined)));
  await srv.close();
});

// --- WebSocket: Builder room ----------------------------------------------

test("Builder room broadcasts edits to peers but not the sender", async () => {
  const bus = new InMemoryChangeBus();
  const h = buildHarness({ withAuth: true, changeBus: bus });
  const pipelineId = randomUUID();
  const alice = await seedUser(h, {
    email: "alice@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const bob = await seedUser(h, {
    email: "bob@x.io",
    grants: [{ role: "platform_admin", scope: "*" }]
  });
  const srv = await startWsServer(h, bus);

  const a = new WS(srv.url);
  const b = new WS(srv.url);
  await Promise.all([waitOpen(a), waitOpen(b)]);
  a.send(JSON.stringify({ type: "auth", token: alice.token }));
  b.send(JSON.stringify({ type: "auth", token: bob.token }));
  await Promise.all([
    nextFrame(a, (m) => m.type === "ready"),
    nextFrame(b, (m) => m.type === "ready")
  ]);

  a.send(JSON.stringify({ type: "builder:join", pipelineId }));
  b.send(JSON.stringify({ type: "builder:join", pipelineId }));
  // Both receive an updated roster.
  await nextFrame(a, (m) => m.type === "builder:roster");
  await nextFrame(b, (m) => m.type === "builder:roster");

  // Alice broadcasts an edit. Bob receives it; Alice does not.
  const editPromise = nextFrame(b, (m) => m.type === "builder:edit");
  a.send(
    JSON.stringify({
      type: "builder:edit",
      pipelineId,
      spec: { nodes: [{ id: "n1" }], edges: [] }
    })
  );
  const edit = await editPromise;
  assert.equal(edit.type, "builder:edit");
  if (edit.type === "builder:edit") {
    assert.equal(edit.edit.pipelineId, pipelineId);
    assert.deepEqual(edit.edit.spec, { nodes: [{ id: "n1" }], edges: [] });
  }
  // And the server didn't echo to Alice — give the event loop a tick and
  // confirm no `builder:edit` arrived on her socket.
  const aGotEdit = await new Promise<boolean>((resolve) => {
    const onMsg = (raw: WS.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as WsServerMessage;
        if (msg.type === "builder:edit") resolve(true);
      } catch {
        /* ignore */
      }
    };
    a.on("message", onMsg);
    setTimeout(() => {
      a.off("message", onMsg);
      resolve(false);
    }, 100);
  });
  assert.equal(aGotEdit, false);

  a.close();
  b.close();
  await Promise.all([
    new Promise((r) => a.once("close", () => r(undefined))),
    new Promise((r) => b.once("close", () => r(undefined)))
  ]);
  await srv.close();
});
