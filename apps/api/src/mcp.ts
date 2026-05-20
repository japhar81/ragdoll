/**
 * MCP (Model Context Protocol) server for the RAGdoll control plane.
 *
 * Mounted on `/mcp` so an LLM client connected via Streamable HTTP transport
 * can list / call tools that wrap our existing API. Stateless: each request
 * gets a fresh {@link Server} + {@link StreamableHTTPServerTransport}, so a
 * per-request principal is captured cleanly via closures (no AsyncLocalStorage
 * gymnastics).
 *
 * The tools never re-implement business logic — they invoke `app.handle(...)`
 * in-process with the caller's Authorization header attached, so RBAC (Casbin
 * scopes) applies exactly as it would for a direct HTTP client. A tool that
 * needs a tenant context honours the user's `x-tenant-id` if present, else
 * falls back to a per-call `tenant` argument.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import type { App, AppRequest, AppResponse } from "./app.ts";

/** Headers the tool dispatch forwards from the original MCP HTTP request. */
function principalHeaders(
  req: IncomingMessage,
  tenantOverride?: string
): Record<string, string> {
  const headers: Record<string, string> = {};
  const auth = req.headers.authorization;
  if (typeof auth === "string") headers.authorization = auth;
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string") headers["x-api-key"] = apiKey;
  const tenant = tenantOverride ?? req.headers["x-tenant-id"];
  if (typeof tenant === "string" && tenant.length > 0) {
    headers["x-tenant-id"] = tenant;
  }
  return headers;
}

/** Run an in-process API call. Mirrors the HTTP path exactly (auth + RBAC). */
async function callApi(
  app: App,
  args: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: unknown;
    query?: Record<string, string | undefined>;
  }
): Promise<AppResponse> {
  const request: AppRequest = {
    method: args.method,
    path: args.path,
    headers: args.headers,
    query: args.query ?? {},
    body: args.body
  };
  return app.handle(request);
}

function jsonResult(body: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }]
  };
}

function errorResult(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
} {
  return { content: [{ type: "text", text: message }], isError: true };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
    headers: Record<string, string>
  ) => Promise<AppResponse>;
}

/**
 * The full tool catalog. Each handler returns an {@link AppResponse}; the
 * dispatcher below maps non-2xx into `isError: true` so the client sees a
 * structured error and the LLM can react.
 */
function toolCatalog(app: App): ToolDef[] {
  const obj = (
    properties: Record<string, unknown>,
    required: string[] = []
  ) => ({
    type: "object" as const,
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false
  });
  const str = (description: string) => ({ type: "string", description });
  const opt = (description: string) => ({ type: "string", description });

  return [
    {
      name: "list_tenants",
      description: "List tenants visible to the caller.",
      inputSchema: obj({}),
      handler: (_a, h) => callApi(app, { method: "GET", path: "/api/tenants", headers: h })
    },
    {
      name: "list_pipelines",
      description: "List every pipeline.",
      inputSchema: obj({}),
      handler: (_a, h) => callApi(app, { method: "GET", path: "/api/pipelines", headers: h })
    },
    {
      name: "get_pipeline",
      description: "Fetch a pipeline by UUID or slug.",
      inputSchema: obj({ id: str("pipeline id or slug") }, ["id"]),
      handler: (a, h) =>
        callApi(app, {
          method: "GET",
          path: `/api/pipelines/${encodeURIComponent(String(a.id))}`,
          headers: h
        })
    },
    {
      name: "list_pipeline_versions",
      description: "List saved versions for a pipeline.",
      inputSchema: obj({ id: str("pipeline id or slug") }, ["id"]),
      handler: (a, h) =>
        callApi(app, {
          method: "GET",
          path: `/api/pipelines/${encodeURIComponent(String(a.id))}/versions`,
          headers: h
        })
    },
    {
      name: "run_pipeline",
      description:
        "Enqueue a pipeline run. Returns the executionId; poll get_execution / get_execution_trace.",
      inputSchema: obj(
        {
          id: str("pipeline id or slug"),
          input: { description: "Input payload for the pipeline." },
          environment: opt("default: dev"),
          activation: opt("optional activation label"),
          tenant: opt("override tenant UUID")
        },
        ["id"]
      ),
      handler: (a, h) =>
        callApi(app, {
          method: "POST",
          path: `/api/pipelines/${encodeURIComponent(String(a.id))}/run`,
          headers: a.tenant ? { ...h, "x-tenant-id": String(a.tenant) } : h,
          body: {
            input: a.input,
            environment: typeof a.environment === "string" ? a.environment : "dev",
            ...(typeof a.activation === "string" ? { activation: a.activation } : {})
          }
        })
    },
    {
      name: "list_executions",
      description: "Recent pipeline executions visible to the caller.",
      inputSchema: obj({
        pipeline_id: opt("filter by pipeline id"),
        status: opt("filter by status"),
        limit: { type: "integer", default: 25 }
      }),
      handler: (a, h) => {
        const q: Record<string, string | undefined> = {};
        if (a.pipeline_id) q.pipeline_id = String(a.pipeline_id);
        if (a.status) q.status = String(a.status);
        if (a.limit) q.limit = String(a.limit);
        return callApi(app, { method: "GET", path: "/api/executions", headers: h, query: q });
      }
    },
    {
      name: "get_execution",
      description: "Get a single execution record.",
      inputSchema: obj({ id: str("execution id") }, ["id"]),
      handler: (a, h) =>
        callApi(app, {
          method: "GET",
          path: `/api/executions/${encodeURIComponent(String(a.id))}`,
          headers: h
        })
    },
    {
      name: "get_execution_trace",
      description: "Per-node trace for an execution (input/output, status, latency).",
      inputSchema: obj({ id: str("execution id") }, ["id"]),
      handler: (a, h) =>
        callApi(app, {
          method: "GET",
          path: `/api/executions/${encodeURIComponent(String(a.id))}/trace`,
          headers: h
        })
    },
    {
      name: "list_schedules",
      description: "List cron schedules (filterable by tenant / pipeline).",
      inputSchema: obj({ tenant: opt("tenant uuid"), pipeline: opt("pipeline uuid") }),
      handler: (a, h) => {
        const q: Record<string, string | undefined> = {};
        if (a.tenant) q.tenant = String(a.tenant);
        if (a.pipeline) q.pipeline = String(a.pipeline);
        return callApi(app, { method: "GET", path: "/api/schedules", headers: h, query: q });
      }
    },
    {
      name: "list_pipeline_triggers",
      description: "List webhook triggers for a pipeline.",
      inputSchema: obj({ id: str("pipeline id or slug") }, ["id"]),
      handler: (a, h) =>
        callApi(app, {
          method: "GET",
          path: `/api/pipelines/${encodeURIComponent(String(a.id))}/triggers`,
          headers: h
        })
    },
    {
      name: "create_pipeline_trigger",
      description:
        "Mint a public webhook URL that starts the pipeline when POSTed to.",
      inputSchema: obj(
        {
          id: str("pipeline id or slug"),
          name: str("operator-facing label, e.g. \"github-push\""),
          environment: str("e.g. dev | prod"),
          activation: opt("optional activation label")
        },
        ["id", "name", "environment"]
      ),
      handler: (a, h) =>
        callApi(app, {
          method: "POST",
          path: `/api/pipelines/${encodeURIComponent(String(a.id))}/triggers`,
          headers: h,
          body: {
            name: a.name,
            environment: a.environment,
            activationLabel: typeof a.activation === "string" ? a.activation : undefined
          }
        })
    },
    {
      name: "list_users",
      description: "List users (user:manage).",
      inputSchema: obj({}),
      handler: (_a, h) => callApi(app, { method: "GET", path: "/api/users", headers: h })
    },
    {
      name: "list_roles",
      description: "List roles + their effective permissions.",
      inputSchema: obj({}),
      handler: (_a, h) => callApi(app, { method: "GET", path: "/api/roles", headers: h })
    },
    {
      name: "list_identity_providers",
      description: "List SSO connections (secrets redacted).",
      inputSchema: obj({}),
      handler: (_a, h) =>
        callApi(app, { method: "GET", path: "/api/identity-providers", headers: h })
    },
    {
      name: "get_audit_log",
      description: "Recent audit log entries (audit:view).",
      inputSchema: obj({
        tenant: opt("tenant uuid"),
        limit: { type: "integer", default: 50 }
      }),
      handler: (a, h) => {
        const q: Record<string, string | undefined> = {};
        if (a.tenant) q.tenant_id = String(a.tenant);
        if (a.limit) q.limit = String(a.limit);
        return callApi(app, { method: "GET", path: "/api/audit", headers: h, query: q });
      }
    },
    {
      name: "get_usage_summary",
      description: "Token + cost usage records (with a small summary).",
      inputSchema: obj({
        tenant: opt("tenant uuid"),
        execution: opt("execution id")
      }),
      handler: (a, h) => {
        const q: Record<string, string | undefined> = {};
        if (a.tenant) q.tenant_id = String(a.tenant);
        if (a.execution) q.execution_id = String(a.execution);
        return callApi(app, { method: "GET", path: "/api/usage", headers: h, query: q });
      }
    }
  ];
}

/**
 * Build a fresh, per-request MCP server with closures over the auth headers.
 * Exported so tests can pair it with the SDK's in-memory transport.
 */
export function buildServer(app: App, req: IncomingMessage): Server {
  const baseHeaders = principalHeaders(req);
  const tools = toolCatalog(app);
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: "ragdoll", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const def = byName.get(request.params.name);
    if (!def) return errorResult(`unknown tool: ${request.params.name}`);
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    // Per-call tenant override (passed as `tenant` in args for run_pipeline,
    // schedules, etc.) is also accepted as a global x-tenant-id header.
    const tenantOverride =
      typeof args.tenant === "string" ? args.tenant : undefined;
    const headers = tenantOverride
      ? { ...baseHeaders, "x-tenant-id": tenantOverride }
      : baseHeaders;
    try {
      const res = await def.handler(args, headers);
      if (res.status >= 400) {
        return errorResult(
          `HTTP ${res.status}: ${
            typeof res.body === "string" ? res.body : JSON.stringify(res.body)
          }`
        );
      }
      return jsonResult(res.body);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  });

  // Resources: pipeline specs surfaced as readable URIs. Listing is dynamic
  // and reflects what the calling principal can see (RBAC filter is applied
  // by /api/pipelines and the spec route).
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const res = await callApi(app, {
      method: "GET",
      path: "/api/pipelines",
      headers: baseHeaders
    });
    if (res.status >= 400) return { resources: [] };
    const pipelines = (res.body as { pipelines?: Array<{ id: string; slug: string; name: string }> }).pipelines ?? [];
    return {
      resources: pipelines.map((p) => ({
        uri: `ragdoll://pipelines/${p.id}`,
        name: `${p.name} (${p.slug})`,
        description: "Pipeline metadata and latest published spec",
        mimeType: "application/json"
      }))
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const url = new URL(request.params.uri);
    if (url.protocol !== "ragdoll:") {
      throw new Error(`unsupported resource scheme: ${url.protocol}`);
    }
    const segments = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    // ragdoll://pipelines/<id>
    if (url.hostname === "pipelines" && segments.length === 0) {
      throw new Error("missing pipeline id");
    }
    const pipelineId = url.hostname === "pipelines" ? segments[0] : segments[0];
    const res = await callApi(app, {
      method: "GET",
      path: `/api/pipelines/${encodeURIComponent(pipelineId)}`,
      headers: baseHeaders
    });
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "application/json",
          text:
            typeof res.body === "string"
              ? res.body
              : JSON.stringify(res.body, null, 2)
        }
      ]
    };
  });

  return server;
}

/**
 * Fastify-side handler: stateless per-request server + transport. Returns a
 * promise that resolves once the response has been fully written by the SDK.
 */
export async function handleMcpRequest(
  app: App,
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody: unknown
): Promise<void> {
  const server = buildServer(app, req);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined // stateless
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } finally {
    // Best-effort cleanup; closing the transport ends any open SSE stream.
    transport.close?.();
    server.close?.();
  }
}
