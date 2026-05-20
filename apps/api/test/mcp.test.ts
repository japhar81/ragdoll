/**
 * MCP smoke: pair our /mcp server with the SDK's in-memory transport so we
 * can list tools and call one end-to-end without standing up an HTTP server.
 * The principal is supplied via the fake IncomingMessage's headers — same
 * code path that the streamable HTTP transport feeds.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildHarness } from "./helpers.ts";
import { PasswordService } from "../../../packages/auth/src/index.ts";
import { buildServer } from "../src/mcp.ts";

async function bootClient(opts: {
  app: ReturnType<typeof buildHarness>["app"];
  bearer?: string;
  tenant?: string;
}): Promise<Client> {
  // Minimal IncomingMessage-shaped object — only `headers` is read by mcp.ts.
  const fakeReq = {
    headers: {
      ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
      ...(opts.tenant ? { "x-tenant-id": opts.tenant } : {})
    }
  } as unknown as Parameters<typeof buildServer>[1];
  const server = buildServer(opts.app, fakeReq);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0.0.1" }, {});
  await client.connect(b);
  return client;
}

async function seedAdmin(
  h: ReturnType<typeof buildHarness>
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await h.deps.users!.create({
    id,
    email: `mcp-${id.slice(0, 8)}@x.io`,
    displayName: "MCP Admin",
    passwordHash: await new PasswordService().hash("password123"),
    status: "active",
    createdAt: now,
    updatedAt: now
  });
  await h.deps.rbacPolicies!.addGrant({
    id: randomUUID(),
    userId: id,
    role: "platform_admin",
    scope: "*",
    createdAt: now
  });
  return h.sessions.sign({ id, type: "user", roles: [] }, 3600);
}

test("MCP listTools returns the full catalog", async () => {
  const h = buildHarness({ withAuth: true });
  const bearer = await seedAdmin(h);
  const client = await bootClient({ app: h.app, bearer });
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const expected of [
    "list_tenants",
    "list_pipelines",
    "get_pipeline",
    "run_pipeline",
    "list_executions",
    "get_execution_trace",
    "list_pipeline_triggers",
    "create_pipeline_trigger",
    "list_users",
    "list_roles",
    "get_audit_log"
  ]) {
    assert.ok(names.includes(expected), `missing tool: ${expected}`);
  }
  await client.close();
});

test("MCP callTool list_tenants returns the tenants the principal can see", async () => {
  const h = buildHarness({ withAuth: true });
  const bearer = await seedAdmin(h);
  await h.deps.tenants.create({
    id: randomUUID(),
    slug: "acme",
    name: "Acme",
    status: "active",
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const client = await bootClient({ app: h.app, bearer });
  const res = await client.callTool({ name: "list_tenants", arguments: {} });
  assert.equal(res.isError ?? false, false);
  const c = res.content as Array<{ type: string; text: string }>;
  const body = JSON.parse(c[0].text);
  assert.equal(body.tenants.length, 1);
  assert.equal(body.tenants[0].slug, "acme");
  await client.close();
});

test("MCP callTool with an unknown tool returns isError, not a throw", async () => {
  const h = buildHarness({ withAuth: true });
  const bearer = await seedAdmin(h);
  const client = await bootClient({ app: h.app, bearer });
  const res = await client.callTool({
    name: "no_such_tool",
    arguments: {}
  });
  assert.equal(res.isError, true);
  await client.close();
});

test("MCP requires auth: an unauthenticated tool call yields HTTP 401 inside the content", async () => {
  const h = buildHarness({ withAuth: true });
  const client = await bootClient({ app: h.app }); // no bearer
  const res = await client.callTool({ name: "list_tenants", arguments: {} });
  assert.equal(res.isError, true);
  const c = res.content as Array<{ type: string; text: string }>;
  assert.match(c[0].text, /HTTP 401/);
  await client.close();
});
