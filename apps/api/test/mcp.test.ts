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

// ---- Danger annotations + full-control surface --------------------------

test("MCP listTools advertises annotations: readOnlyHint, destructiveHint, idempotentHint", async () => {
  const h = buildHarness({ withAuth: true });
  const bearer = await seedAdmin(h);
  const client = await bootClient({ app: h.app, bearer });
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  // Spot-check: list_* tools are read-only.
  for (const n of ["list_tenants", "list_pipelines", "list_executions", "list_users", "list_roles"]) {
    const t = byName.get(n);
    assert.ok(t, `missing tool: ${n}`);
    assert.equal(t!.annotations?.readOnlyHint, true, `${n} should be readOnly`);
    assert.equal(t!.annotations?.destructiveHint, false, `${n} should NOT be destructive`);
  }

  // Spot-check: destructive tools flag destructiveHint AND prefix the description.
  for (const n of [
    "delete_tenant",
    "delete_pipeline",
    "deploy_pipeline",
    "rollback_pipeline",
    "delete_schedule",
    "delete_secret",
    "create_secret",
    "delete_user",
    "add_grant",
    "remove_grant",
    "set_role_permissions",
    "delete_role",
    "delete_identity_provider",
    "update_auth_settings",
    "delete_pipeline_trigger",
    "upsert_config_definition",
    "delete_config_definition",
    "delete_environment",
    "delete_activation",
    "delete_folder"
  ]) {
    const t = byName.get(n);
    assert.ok(t, `missing tool: ${n}`);
    assert.equal(t!.annotations?.readOnlyHint, false, `${n} should NOT be readOnly`);
    assert.equal(t!.annotations?.destructiveHint, true, `${n} should be destructive`);
    assert.match(
      String(t!.description),
      /^⚠ DANGEROUS:/,
      `${n} description should start with ⚠ DANGEROUS:`
    );
  }
  await client.close();
});

test("MCP can create and then delete a pipeline end-to-end (full control)", async () => {
  const h = buildHarness({ withAuth: true });
  const bearer = await seedAdmin(h);
  const client = await bootClient({ app: h.app, bearer });

  const slug = `mcp-create-${randomUUID().slice(0, 8)}`;
  const created = await client.callTool({
    name: "create_pipeline",
    arguments: { slug, name: "MCP Created" }
  });
  assert.equal(created.isError ?? false, false);
  const createdBody = JSON.parse(
    (created.content as Array<{ text: string }>)[0].text
  );
  const pipelineId = createdBody.pipeline.id;
  assert.ok(pipelineId);

  // Verify it shows up in list_pipelines.
  const list = await client.callTool({ name: "list_pipelines", arguments: {} });
  const listBody = JSON.parse(
    (list.content as Array<{ text: string }>)[0].text
  );
  assert.ok(
    listBody.pipelines.some((p: { id: string }) => p.id === pipelineId),
    "created pipeline should appear in list_pipelines"
  );

  // Delete (the dangerous tool path) and verify it's gone.
  const deleted = await client.callTool({
    name: "delete_pipeline",
    arguments: { id: pipelineId }
  });
  assert.equal(deleted.isError ?? false, false);

  const after = await client.callTool({ name: "list_pipelines", arguments: {} });
  const afterBody = JSON.parse(
    (after.content as Array<{ text: string }>)[0].text
  );
  assert.ok(
    !afterBody.pipelines.some((p: { id: string }) => p.id === pipelineId),
    "deleted pipeline should be gone from list_pipelines"
  );
  await client.close();
});

test("MCP can create a tenant + environment + folder via tools", async () => {
  const h = buildHarness({ withAuth: true });
  const bearer = await seedAdmin(h);
  const client = await bootClient({ app: h.app, bearer });

  const tenantSlug = `mcp-t-${randomUUID().slice(0, 8)}`;
  const tenant = await client.callTool({
    name: "create_tenant",
    arguments: { slug: tenantSlug, name: "MCP Tenant" }
  });
  assert.equal(tenant.isError ?? false, false);
  const tenantBody = JSON.parse(
    (tenant.content as Array<{ text: string }>)[0].text
  );
  const tenantId = tenantBody.tenant.id;

  const env = await client.callTool({
    name: "create_environment",
    arguments: { tenant: tenantId, name: "qa", isProduction: false }
  });
  assert.equal(env.isError ?? false, false);

  const folder = await client.callTool({
    name: "create_folder",
    arguments: { name: "from-mcp" }
  });
  assert.equal(folder.isError ?? false, false);
  await client.close();
});
