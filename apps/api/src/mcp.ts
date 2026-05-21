/**
 * MCP (Model Context Protocol) server for the RAGdoll control plane.
 *
 * Mounted on `/mcp` so an LLM client connected via Streamable HTTP transport
 * can list / call tools that wrap our entire HTTP API. Stateless: each request
 * gets a fresh {@link Server} + {@link StreamableHTTPServerTransport}, so a
 * per-request principal is captured cleanly via closures (no AsyncLocalStorage
 * gymnastics).
 *
 * Tools never re-implement business logic — they invoke `app.handle(...)`
 * in-process with the caller's Authorization header attached, so RBAC (Casbin
 * scopes) applies exactly as it would for a direct HTTP client. A tool that
 * needs a tenant context honours the user's `x-tenant-id` if present, else
 * falls back to a per-call `tenant` argument.
 *
 * **Danger annotations.** Every tool advertises `readOnlyHint` /
 * `destructiveHint` / `idempotentHint` per MCP spec so clients can gate
 * irreversible operations behind a human confirmation. Destructive tools
 * also prefix their description with "⚠ DANGEROUS: " so even a client that
 * ignores annotations sees the warning in the prompt.
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

// ---------------------------------------------------------------------------
// Auth + dispatch helpers
// ---------------------------------------------------------------------------

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
  // 204 No Content responses come back with `body === undefined`, which
  // would JSON.stringify to literal `undefined` (and fail MCP's response
  // validation — `text` must be a string). Surface those as an explicit
  // "{}" so DELETE tools have a well-formed result.
  const text =
    body === undefined
      ? "{}"
      : typeof body === "string"
        ? body
        : JSON.stringify(body, null, 2);
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
} {
  return { content: [{ type: "text", text: message }], isError: true };
}

// ---------------------------------------------------------------------------
// Tool definition helper
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  handler: (
    args: Record<string, unknown>,
    headers: Record<string, string>
  ) => Promise<AppResponse>;
}

interface ToolAnnotations {
  title?: string;
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

interface ToolOpts {
  description: string;
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
}

/**
 * Build a {@link ToolDef} with consistent metadata + a danger-marker
 * prefix on every destructive tool's description. Defaults: read-only
 * false, destructive false, idempotent false — opt in explicitly so the
 * danger annotation can never be silently lost on a new tool.
 */
function tool(
  name: string,
  opts: ToolOpts,
  inputSchema: Record<string, unknown>,
  handler: ToolDef["handler"]
): ToolDef {
  const readOnly = opts.readOnly ?? false;
  const destructive = opts.destructive ?? false;
  const idempotent = opts.idempotent ?? false;
  const description = destructive ? `⚠ DANGEROUS: ${opts.description}` : opts.description;
  return {
    name,
    description,
    inputSchema,
    annotations: {
      readOnlyHint: readOnly,
      // The destructive/idempotent hints are only meaningful when
      // readOnlyHint is false (per MCP spec). Emit them anyway for
      // belt-and-suspenders; well-behaved clients gate on readOnlyHint
      // first.
      destructiveHint: destructive,
      idempotentHint: idempotent
    },
    handler
  };
}

// ---------------------------------------------------------------------------
// Schema helpers (tiny JSON-schema DSL)
// ---------------------------------------------------------------------------

const str = (description: string) => ({ type: "string", description });
const opt = (description: string) => ({ type: "string", description });
const bool = (description: string) => ({ type: "boolean", description });
const int = (description: string) => ({ type: "integer", description });
const anyType = (description: string) => ({ description });
const obj = (
  properties: Record<string, unknown>,
  required: string[] = []
) => ({
  type: "object" as const,
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false
});

const tenantArg = opt("tenant UUID override; defaults to the session tenant");

// ---------------------------------------------------------------------------
// The tool catalog
// ---------------------------------------------------------------------------

function toolCatalog(app: App): ToolDef[] {
  return [
    // ---- Tenants -----------------------------------------------------------
    tool(
      "list_tenants",
      { description: "List tenants visible to the caller.", readOnly: true },
      obj({}),
      (_a, h) => callApi(app, { method: "GET", path: "/api/tenants", headers: h })
    ),
    tool(
      "get_tenant",
      { description: "Fetch a single tenant by id or slug.", readOnly: true },
      obj({ id: str("tenant UUID or slug") }, ["id"]),
      (a, h) =>
        callApi(app, {
          method: "GET",
          path: `/api/tenants/${encodeURIComponent(String(a.id))}`,
          headers: h
        })
    ),
    tool(
      "create_tenant",
      { description: "Provision a new tenant (slug + display name)." },
      obj(
        { slug: str("URL-safe slug"), name: str("display name") },
        ["slug", "name"]
      ),
      (a, h) =>
        callApi(app, {
          method: "POST",
          path: "/api/tenants",
          headers: h,
          body: { slug: a.slug, name: a.name }
        })
    ),
    tool(
      "update_tenant",
      { description: "Update a tenant's display name or status." },
      obj(
        {
          id: str("tenant UUID or slug"),
          name: opt("new display name"),
          status: opt("active | disabled")
        },
        ["id"]
      ),
      (a, h) =>
        callApi(app, {
          method: "PATCH",
          path: `/api/tenants/${encodeURIComponent(String(a.id))}`,
          headers: h,
          body: {
            ...(a.name ? { name: a.name } : {}),
            ...(a.status ? { status: a.status } : {})
          }
        })
    ),
    tool(
      "delete_tenant",
      {
        description:
          "Delete a tenant and CASCADE-drop its pipelines, secrets, schedules, and grants. Not reversible.",
        destructive: true
      },
      obj({ id: str("tenant UUID or slug") }, ["id"]),
      (a, h) =>
        callApi(app, {
          method: "DELETE",
          path: `/api/tenants/${encodeURIComponent(String(a.id))}`,
          headers: h
        })
    ),

    // ---- Environments (per tenant) ----------------------------------------
    tool(
      "list_environments",
      { description: "List the per-tenant environment catalog.", readOnly: true },
      obj({ tenant: tenantArg }, ["tenant"]),
      (a, h) =>
        callApi(app, {
          method: "GET",
          path: `/api/tenants/${encodeURIComponent(String(a.tenant))}/environments`,
          headers: h
        })
    ),
    tool(
      "create_environment",
      {
        description:
          "Add a deploy/run target (e.g. staging, prod) to a tenant's environment catalog."
      },
      obj(
        {
          tenant: tenantArg,
          name: str("environment name"),
          description: opt("optional human description"),
          isProduction: bool("treat as prod (locks loosely-protected paths)")
        },
        ["tenant", "name"]
      ),
      (a, h) =>
        callApi(app, {
          method: "POST",
          path: `/api/tenants/${encodeURIComponent(String(a.tenant))}/environments`,
          headers: h,
          body: {
            name: a.name,
            ...(a.description ? { description: a.description } : {}),
            ...(typeof a.isProduction === "boolean"
              ? { isProduction: a.isProduction }
              : {})
          }
        })
    ),
    tool(
      "delete_environment",
      {
        description:
          "Drop an environment from a tenant's catalog. Existing deployments / schedules referencing the name keep working but no new ones can target it.",
        destructive: true
      },
      obj(
        { tenant: tenantArg, envId: str("environment UUID") },
        ["tenant", "envId"]
      ),
      (a, h) =>
        callApi(app, {
          method: "DELETE",
          path: `/api/tenants/${encodeURIComponent(
            String(a.tenant)
          )}/environments/${encodeURIComponent(String(a.envId))}`,
          headers: h
        })
    ),

    // ---- Tenant <-> Pipeline associations + activations -------------------
    tool(
      "list_tenant_pipelines",
      {
        description:
          "List a tenant's pipeline associations (one row per (pipeline, environment)).",
        readOnly: true
      },
      obj({ tenant: tenantArg }, ["tenant"]),
      (a, h) =>
        callApi(app, {
          method: "GET",
          path: `/api/tenants/${encodeURIComponent(String(a.tenant))}/pipelines`,
          headers: h
        })
    ),
    tool(
      "associate_pipeline",
      {
        description:
          "Associate a pipeline with a tenant for a given environment. Same (pipeline, env) repeats are upserted in place."
      },
      obj(
        {
          tenant: tenantArg,
          pipelineId: str("pipeline UUID"),
          environment: str("environment name, e.g. dev | prod")
        },
        ["tenant", "pipelineId", "environment"]
      ),
      (a, h) =>
        callApi(app, {
          method: "POST",
          path: `/api/tenants/${encodeURIComponent(String(a.tenant))}/pipelines`,
          headers: h,
          body: { pipelineId: a.pipelineId, environment: a.environment }
        })
    ),
    tool(
      "set_pipeline_association_enabled",
      {
        description:
          "Enable/disable a tenant's association for one (pipeline, env). Disabled associations block runs but don't delete history."
      },
      obj(
        {
          tenant: tenantArg,
          pipelineId: str("pipeline UUID"),
          environment: str("environment name"),
          enabled: bool("true to enable, false to pause")
        },
        ["tenant", "pipelineId", "environment", "enabled"]
      ),
      (a, h) =>
        callApi(app, {
          method: "PATCH",
          path: `/api/tenants/${encodeURIComponent(
            String(a.tenant)
          )}/pipelines/${encodeURIComponent(String(a.pipelineId))}`,
          headers: h,
          body: { enabled: a.enabled, environment: a.environment }
        })
    ),
    tool(
      "list_activations",
      {
        description:
          "List a tenant's activations for a pipeline (label, env, pinned vs track-latest).",
        readOnly: true
      },
      obj(
        { tenant: tenantArg, pipelineId: str("pipeline UUID") },
        ["tenant", "pipelineId"]
      ),
      (a, h) =>
        callApi(app, {
          method: "GET",
          path: `/api/tenants/${encodeURIComponent(
            String(a.tenant)
          )}/pipelines/${encodeURIComponent(String(a.pipelineId))}/activations`,
          headers: h
        })
    ),
    tool(
      "create_activation",
      {
        description:
          "Create an activation row: label + env, either tracking-latest or pinned to a specific version."
      },
      obj(
        {
          tenant: tenantArg,
          pipelineId: str("pipeline UUID"),
          label: str("activation label, e.g. 'default' | 'live' | 'pinned'"),
          environment: str("environment name"),
          trackLatest: bool("true: always latest; false: pin a version"),
          pipelineVersionId: opt(
            "required when trackLatest=false — the version to pin"
          ),
          enabled: bool("default true")
        },
        ["tenant", "pipelineId", "label", "environment", "trackLatest"]
      ),
      (a, h) =>
        callApi(app, {
          method: "POST",
          path: `/api/tenants/${encodeURIComponent(
            String(a.tenant)
          )}/pipelines/${encodeURIComponent(String(a.pipelineId))}/activations`,
          headers: h,
          body: {
            label: a.label,
            environment: a.environment,
            trackLatest: Boolean(a.trackLatest),
            ...(a.pipelineVersionId
              ? { pipelineVersionId: a.pipelineVersionId }
              : {}),
            ...(typeof a.enabled === "boolean" ? { enabled: a.enabled } : {})
          }
        })
    ),
    tool(
      "update_activation",
      {
        description:
          "Toggle enabled, flip between track-latest and pinned, or repin to a different version."
      },
      obj(
        {
          tenant: tenantArg,
          pipelineId: str("pipeline UUID"),
          activationId: str("activation UUID"),
          enabled: bool("optional"),
          trackLatest: bool("optional"),
          pipelineVersionId: opt("optional; null to unset")
        },
        ["tenant", "pipelineId", "activationId"]
      ),
      (a, h) => {
        const body: Record<string, unknown> = {};
        if (typeof a.enabled === "boolean") body.enabled = a.enabled;
        if (typeof a.trackLatest === "boolean") body.trackLatest = a.trackLatest;
        if ("pipelineVersionId" in a) body.pipelineVersionId = a.pipelineVersionId ?? null;
        return callApi(app, {
          method: "PATCH",
          path: `/api/tenants/${encodeURIComponent(
            String(a.tenant)
          )}/pipelines/${encodeURIComponent(
            String(a.pipelineId)
          )}/activations/${encodeURIComponent(String(a.activationId))}`,
          headers: h,
          body
        });
      }
    ),
    tool(
      "delete_activation",
      {
        description:
          "Remove an activation. Active runs targeting it complete; future runs that resolved this label will 409 until re-targeted.",
        destructive: true
      },
      obj(
        {
          tenant: tenantArg,
          pipelineId: str("pipeline UUID"),
          activationId: str("activation UUID")
        },
        ["tenant", "pipelineId", "activationId"]
      ),
      (a, h) =>
        callApi(app, {
          method: "DELETE",
          path: `/api/tenants/${encodeURIComponent(
            String(a.tenant)
          )}/pipelines/${encodeURIComponent(
            String(a.pipelineId)
          )}/activations/${encodeURIComponent(String(a.activationId))}`,
          headers: h
        })
    ),

    // ---- Folders (pipeline tree) ------------------------------------------
    tool(
      "list_folders",
      { description: "List the global pipeline-folder tree.", readOnly: true },
      obj({}),
      (_a, h) => callApi(app, { method: "GET", path: "/api/folders", headers: h })
    ),
    tool(
      "create_folder",
      { description: "Create a pipeline folder; optional parentId for nesting." },
      obj(
        { name: str("folder name"), parentId: opt("optional parent folder UUID") },
        ["name"]
      ),
      (a, h) =>
        callApi(app, {
          method: "POST",
          path: "/api/folders",
          headers: h,
          body: { name: a.name, parentId: a.parentId ?? null }
        })
    ),
    tool(
      "update_folder",
      { description: "Rename a folder or reparent it." },
      obj(
        {
          id: str("folder UUID"),
          name: opt("new name"),
          parentId: opt("new parent UUID; null to move to root")
        },
        ["id"]
      ),
      (a, h) => {
        const body: Record<string, unknown> = {};
        if (a.name) body.name = a.name;
        if ("parentId" in a) body.parentId = a.parentId ?? null;
        return callApi(app, {
          method: "PATCH",
          path: `/api/folders/${encodeURIComponent(String(a.id))}`,
          headers: h,
          body
        });
      }
    ),
    tool(
      "delete_folder",
      {
        description:
          "Delete a folder. 409s if it still has pipelines or sub-folders — move them out first.",
        destructive: true
      },
      obj({ id: str("folder UUID") }, ["id"]),
      (a, h) =>
        callApi(app, {
          method: "DELETE",
          path: `/api/folders/${encodeURIComponent(String(a.id))}`,
          headers: h
        })
    ),

    // ---- Pipelines + versions + deployments -------------------------------
    tool(
      "list_pipelines",
      { description: "List every pipeline.", readOnly: true },
      obj({}),
      (_a, h) => callApi(app, { method: "GET", path: "/api/pipelines", headers: h })
    ),
    tool(
      "get_pipeline",
      { description: "Fetch a pipeline by UUID or slug.", readOnly: true },
      obj({ id: str("pipeline id or slug") }, ["id"]),
      (a, h) =>
        callApi(app, {
          method: "GET",
          path: `/api/pipelines/${encodeURIComponent(String(a.id))}`,
          headers: h
        })
    ),
    tool(
      "create_pipeline",
      {
        description:
          "Create a new pipeline shell (no spec yet). Use save_pipeline_version to add a spec."
      },
      obj(
        {
          slug: str("URL-safe slug; immutable after creation"),
          name: str("display name"),
          folderId: opt("optional folder UUID"),
          description: opt("optional description")
        },
        ["slug", "name"]
      ),
      (a, h) =>
        callApi(app, {
          method: "POST",
          path: "/api/pipelines",
          headers: h,
          body: {
            slug: a.slug,
            name: a.name,
            ...(a.folderId ? { folderId: a.folderId } : {}),
            ...(a.description ? { description: a.description } : {})
          }
        })
    ),
    tool(
      "update_pipeline",
      {
        description:
          "Update mutable pipeline metadata (name, description, folder placement). Slug is immutable."
      },
      obj(
        {
          id: str("pipeline UUID or slug"),
          name: opt("new display name"),
          description: opt("new description"),
          folderId: opt("new folder UUID; null to move to root")
        },
        ["id"]
      ),
      (a, h) => {
        const body: Record<string, unknown> = {};
        if (a.name) body.name = a.name;
        if (a.description) body.description = a.description;
        if ("folderId" in a) body.folderId = a.folderId ?? null;
        return callApi(app, {
          method: "PATCH",
          path: `/api/pipelines/${encodeURIComponent(String(a.id))}`,
          headers: h,
          body
        });
      }
    ),
    tool(
      "delete_pipeline",
      {
        description:
          "Delete a pipeline and all its versions, deployments, and activations.",
        destructive: true
      },
      obj({ id: str("pipeline UUID or slug") }, ["id"]),
      (a, h) =>
        callApi(app, {
          method: "DELETE",
          path: `/api/pipelines/${encodeURIComponent(String(a.id))}`,
          headers: h
        })
    ),
    tool(
      "save_pipeline_version",
      {
        description:
          "Save a pipeline spec as a new version. publish=true marks the row immutable & deployable. Idempotent: identical spec is a no-op (returns the existing version)."
      },
      obj(
        {
          id: str("pipeline UUID or slug"),
          spec: anyType("pipeline spec object (PipelineSpec shape)"),
          version: opt("optional semver string; auto-bumped if absent"),
          publish: bool("publish on save (default false)")
        },
        ["id", "spec"]
      ),
      (a, h) =>
        callApi(app, {
          method: "POST",
          path: `/api/pipelines/${encodeURIComponent(String(a.id))}/save`,
          headers: h,
          body: {
            spec: a.spec,
            ...(a.version ? { version: a.version } : {}),
            ...(typeof a.publish === "boolean" ? { publish: a.publish } : {})
          }
        })
    ),
    tool(
      "list_pipeline_versions",
      { description: "List saved versions for a pipeline.", readOnly: true },
      obj({ id: str("pipeline id or slug") }, ["id"]),
      (a, h) =>
        callApi(app, {
          method: "GET",
          path: `/api/pipelines/${encodeURIComponent(String(a.id))}/versions`,
          headers: h
        })
    ),
    tool(
      "deploy_pipeline",
      {
        description:
          "Deploy a published version to (env, tenant?). Upserts the existing deployment if one exists for that triple — new runs use this version immediately. Idempotent on the (pipeline, env, tenant) key.",
        destructive: true,
        idempotent: true
      },
      obj(
        {
          id: str("pipeline UUID or slug"),
          version: str("version string of a published row"),
          environment: str("environment name"),
          tenantId: opt("optional tenant UUID; omit for an org-wide deploy")
        },
        ["id", "version", "environment"]
      ),
      (a, h) =>
        callApi(app, {
          method: "POST",
          path: `/api/pipelines/${encodeURIComponent(String(a.id))}/deployments`,
          headers: h,
          body: {
            version: a.version,
            environment: a.environment,
            ...(a.tenantId ? { tenantId: a.tenantId } : {})
          }
        })
    ),
    tool(
      "rollback_pipeline",
      {
        description:
          "Roll the pipeline's latest pointer back to a prior version. Doesn't move any deployment rows — call deploy_pipeline after to actually serve the prior version.",
        destructive: true
      },
      obj(
        { id: str("pipeline UUID or slug"), versionId: str("target version UUID") },
        ["id", "versionId"]
      ),
      (a, h) =>
        callApi(app, {
          method: "POST",
          path: `/api/pipelines/${encodeURIComponent(String(a.id))}/rollback`,
          headers: h,
          body: { versionId: a.versionId }
        })
    ),
    tool(
      "validate_pipeline_spec",
      {
        description:
          "Validate a spec object (DAG, plugin refs, config refs, secret refs) without persisting it.",
        readOnly: true
      },
      obj({ spec: anyType("pipeline spec object") }, ["spec"]),
      (a, h) =>
        callApi(app, {
          method: "POST",
          path: "/api/pipelines/validate",
          headers: h,
          body: { spec: a.spec }
        })
    ),
    tool(
      "list_deployments",
      { description: "List deployment rows for a pipeline.", readOnly: true },
      obj({ id: str("pipeline UUID or slug") }, ["id"]),
      (a, h) =>
        callApi(app, {
          method: "GET",
          path: `/api/pipelines/${encodeURIComponent(String(a.id))}/deployments`,
          headers: h
        })
    ),

    // ---- Run + executions -------------------------------------------------
    tool(
      "run_pipeline",
      {
        description:
          "Enqueue a pipeline run. Returns the executionId; poll get_execution / get_execution_trace."
      },
      obj(
        {
          id: str("pipeline id or slug"),
          input: anyType("input payload for the pipeline"),
          environment: opt("default: dev"),
          activation: opt("optional activation label"),
          tenant: opt("override tenant UUID")
        },
        ["id"]
      ),
      (a, h) =>
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
    ),
    tool(
      "list_executions",
      { description: "Recent pipeline executions visible to the caller.", readOnly: true },
      obj({
        pipeline_id: opt("filter by pipeline id"),
        status: opt("filter by status"),
        limit: int("default 25")
      }),
      (a, h) => {
        const q: Record<string, string | undefined> = {};
        if (a.pipeline_id) q.pipeline_id = String(a.pipeline_id);
        if (a.status) q.status = String(a.status);
        if (a.limit) q.limit = String(a.limit);
        return callApi(app, { method: "GET", path: "/api/executions", headers: h, query: q });
      }
    ),
    tool(
      "get_execution",
      { description: "Get a single execution record.", readOnly: true },
      obj({ id: str("execution id") }, ["id"]),
      (a, h) =>
        callApi(app, {
          method: "GET",
          path: `/api/executions/${encodeURIComponent(String(a.id))}`,
          headers: h
        })
    ),
    tool(
      "get_execution_trace",
      {
        description:
          "Per-node trace for an execution (input/output, status, latency).",
        readOnly: true
      },
      obj({ id: str("execution id") }, ["id"]),
      (a, h) =>
        callApi(app, {
          method: "GET",
          path: `/api/executions/${encodeURIComponent(String(a.id))}/trace`,
          headers: h
        })
    ),

    // ---- Schedules --------------------------------------------------------
    tool(
      "list_schedules",
      { description: "List cron schedules (filterable by tenant / pipeline).", readOnly: true },
      obj({ tenant: opt("tenant uuid"), pipeline: opt("pipeline uuid") }),
      (a, h) => {
        const q: Record<string, string | undefined> = {};
        if (a.tenant) q.tenant = String(a.tenant);
        if (a.pipeline) q.pipeline = String(a.pipeline);
        return callApi(app, { method: "GET", path: "/api/schedules", headers: h, query: q });
      }
    ),
    tool(
      "create_schedule",
      {
        description:
          "Create a cron schedule that enqueues a pipeline run on a recurring cadence."
      },
      obj(
        {
          tenant: tenantArg,
          pipelineId: str("pipeline UUID"),
          environment: str("environment name"),
          cron: str("5- or 6-field cron expression (croner syntax)"),
          timezone: opt("IANA tz (default UTC)"),
          activationLabel: opt("optional activation label"),
          input: anyType("input payload sent on every run"),
          enabled: bool("default true")
        },
        ["tenant", "pipelineId", "environment", "cron"]
      ),
      (a, h) =>
        callApi(app, {
          method: "POST",
          path: "/api/schedules",
          headers: h,
          body: {
            tenantId: a.tenant,
            pipelineId: a.pipelineId,
            environment: a.environment,
            cron: a.cron,
            timezone: a.timezone ?? "UTC",
            ...(a.activationLabel ? { activationLabel: a.activationLabel } : {}),
            input: a.input ?? {},
            enabled: typeof a.enabled === "boolean" ? a.enabled : true
          }
        })
    ),
    tool(
      "toggle_schedule",
      { description: "Enable or pause an existing schedule. Idempotent.", idempotent: true },
      obj(
        { id: str("schedule UUID"), enabled: bool("true to run, false to pause") },
        ["id", "enabled"]
      ),
      (a, h) =>
        callApi(app, {
          method: "PATCH",
          path: `/api/schedules/${encodeURIComponent(String(a.id))}`,
          headers: h,
          body: { enabled: a.enabled }
        })
    ),
    tool(
      "delete_schedule",
      { description: "Delete a schedule. In-flight runs continue; no new ones fire.", destructive: true },
      obj({ id: str("schedule UUID") }, ["id"]),
      (a, h) =>
        callApi(app, {
          method: "DELETE",
          path: `/api/schedules/${encodeURIComponent(String(a.id))}`,
          headers: h
        })
    ),

    // ---- Webhook triggers -------------------------------------------------
    tool(
      "list_pipeline_triggers",
      { description: "List webhook triggers for a pipeline.", readOnly: true },
      obj({ id: str("pipeline id or slug") }, ["id"]),
      (a, h) =>
        callApi(app, {
          method: "GET",
          path: `/api/pipelines/${encodeURIComponent(String(a.id))}/triggers`,
          headers: h
        })
    ),
    tool(
      "create_pipeline_trigger",
      {
        description:
          "Mint a public webhook URL that starts the pipeline when POSTed to. The secret half of the token is shown ONCE in the response."
      },
      obj(
        {
          id: str("pipeline id or slug"),
          name: str("operator-facing label, e.g. \"github-push\""),
          environment: str("e.g. dev | prod"),
          activation: opt("optional activation label")
        },
        ["id", "name", "environment"]
      ),
      (a, h) =>
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
    ),
    tool(
      "delete_pipeline_trigger",
      {
        description:
          "Revoke a webhook trigger. The URL stops accepting POSTs immediately; in-flight runs complete.",
        destructive: true
      },
      obj({ triggerId: str("trigger UUID") }, ["triggerId"]),
      (a, h) =>
        callApi(app, {
          method: "DELETE",
          path: `/api/triggers/${encodeURIComponent(String(a.triggerId))}`,
          headers: h
        })
    ),

    // ---- Config -----------------------------------------------------------
    tool(
      "get_resolved_config",
      {
        description:
          "Resolve the effective config for (pipeline, tenant, environment) — the same lookup pipeline runs do.",
        readOnly: true
      },
      obj(
        {
          pipeline_id: str("pipeline UUID"),
          tenant_id: str("tenant UUID"),
          environment: str("environment name")
        },
        ["pipeline_id", "tenant_id", "environment"]
      ),
      (a, h) =>
        callApi(app, {
          method: "GET",
          path: "/api/config/resolved",
          headers: h,
          query: {
            pipeline_id: String(a.pipeline_id),
            tenant_id: String(a.tenant_id),
            environment: String(a.environment)
          }
        })
    ),
    tool(
      "list_config_definitions",
      { description: "List declared config keys (catalog).", readOnly: true },
      obj({}),
      (_a, h) =>
        callApi(app, { method: "GET", path: "/api/config/definitions", headers: h })
    ),
    tool(
      "upsert_config_definition",
      {
        description:
          "Declare or update a config key (type, default, allowed scopes, required, secret flag). Changing the key's secret flag rewrites how values are stored.",
        destructive: true,
        idempotent: true
      },
      obj(
        {
          key: str("dotted key, e.g. 'retrieval.top_k'"),
          type: str("string | integer | number | boolean | object | array"),
          defaultValue: anyType("default when no override applies"),
          allowedScopes: anyType("array of: global | tenant | pipeline"),
          required: bool("default false"),
          secret: bool("default false; secret-typed defs go through secret storage")
        },
        ["key", "type"]
      ),
      (a, h) =>
        callApi(app, {
          method: "PUT",
          path: `/api/config/definitions/${encodeURIComponent(String(a.key))}`,
          headers: h,
          body: {
            type: a.type,
            ...(a.defaultValue !== undefined ? { defaultValue: a.defaultValue } : {}),
            ...(a.allowedScopes !== undefined ? { allowedScopes: a.allowedScopes } : {}),
            ...(typeof a.required === "boolean" ? { required: a.required } : {}),
            ...(typeof a.secret === "boolean" ? { secret: a.secret } : {})
          }
        })
    ),
    tool(
      "delete_config_definition",
      {
        description:
          "Drop a config definition. Existing values for the key remain but no longer resolve through the catalog.",
        destructive: true
      },
      obj({ key: str("config key") }, ["key"]),
      (a, h) =>
        callApi(app, {
          method: "DELETE",
          path: `/api/config/definitions/${encodeURIComponent(String(a.key))}`,
          headers: h
        })
    ),
    tool(
      "list_config_values",
      { description: "List config values, filterable by scope.", readOnly: true },
      obj({ scope: opt("global | tenant | pipeline"), scope_id: opt("optional scope id") }),
      (a, h) => {
        const q: Record<string, string | undefined> = {};
        if (a.scope) q.scope = String(a.scope);
        if (a.scope_id) q.scope_id = String(a.scope_id);
        return callApi(app, {
          method: "GET",
          path: "/api/config/values",
          headers: h,
          query: q
        });
      }
    ),
    tool(
      "upsert_config_value",
      {
        description:
          "Set a config value at a scope (global / tenant / pipeline). Locked keys 409 from non-platform-admin callers.",
        idempotent: true
      },
      obj(
        {
          key: str("config key"),
          value: anyType("the typed value (matches the definition's type)"),
          scope: str("global | tenant | pipeline"),
          scopeId: opt("scope id (tenant UUID or pipeline UUID)")
        },
        ["key", "value", "scope"]
      ),
      (a, h) =>
        callApi(app, {
          method: "POST",
          path: "/api/config/values",
          headers: h,
          body: {
            key: a.key,
            value: a.value,
            scope: a.scope,
            ...(a.scopeId ? { scopeId: a.scopeId } : {})
          }
        })
    ),
    tool(
      "delete_config_value",
      {
        description:
          "Delete a config value. Pipelines that depended on the override revert to the next-most-specific scope (or the definition default).",
        destructive: true
      },
      obj({ id: str("config value UUID") }, ["id"]),
      (a, h) =>
        callApi(app, {
          method: "DELETE",
          path: `/api/config/values/${encodeURIComponent(String(a.id))}`,
          headers: h
        })
    ),

    // ---- Secrets ----------------------------------------------------------
    tool(
      "list_secrets",
      {
        description:
          "List managed secret references. Values are ALWAYS returned as the literal string 'REDACTED'.",
        readOnly: true
      },
      obj({}),
      (_a, h) => callApi(app, { method: "GET", path: "/api/secrets", headers: h })
    ),
    tool(
      "create_secret",
      {
        description:
          "Encrypt and persist a secret. ACCEPTS PLAINTEXT in the request body. The plaintext is encrypted with the per-instance SECRET_ENCRYPTION_KEY and never returned by any API surface afterwards.",
        destructive: true
      },
      obj(
        {
          key: str("secret key, e.g. 'llm.api_key'"),
          value: str("plaintext value (encrypted at rest, never re-emitted)"),
          scope: str("global | tenant"),
          tenantId: opt("required when scope=tenant")
        },
        ["key", "value", "scope"]
      ),
      (a, h) =>
        callApi(app, {
          method: "POST",
          path: "/api/secrets",
          headers: h,
          body: {
            key: a.key,
            value: a.value,
            scope: a.scope,
            ...(a.tenantId ? { tenantId: a.tenantId } : {})
          }
        })
    ),
    tool(
      "delete_secret",
      {
        description:
          "Delete a secret. Any pipeline that resolves this secret reference will fail to run until the secret is recreated.",
        destructive: true
      },
      obj({ id: str("secret UUID") }, ["id"]),
      (a, h) =>
        callApi(app, {
          method: "DELETE",
          path: `/api/secrets/${encodeURIComponent(String(a.id))}`,
          headers: h
        })
    ),

    // ---- Plugins (catalog) ------------------------------------------------
    tool(
      "list_plugins",
      { description: "List registered plugins (category, id, version, schema).", readOnly: true },
      obj({}),
      (_a, h) => callApi(app, { method: "GET", path: "/api/plugins", headers: h })
    ),
    tool(
      "get_plugin",
      { description: "Fetch a single plugin's manifest by category/id/version.", readOnly: true },
      obj(
        {
          category: str("plugin category"),
          id: str("plugin id"),
          version: str("plugin version")
        },
        ["category", "id", "version"]
      ),
      (a, h) =>
        callApi(app, {
          method: "GET",
          path: `/api/plugins/${encodeURIComponent(String(a.category))}/${encodeURIComponent(
            String(a.id)
          )}/${encodeURIComponent(String(a.version))}`,
          headers: h
        })
    ),

    // ---- Users + RBAC -----------------------------------------------------
    tool(
      "list_users",
      { description: "List users (user:manage).", readOnly: true },
      obj({}),
      (_a, h) => callApi(app, { method: "GET", path: "/api/users", headers: h })
    ),
    tool(
      "get_user",
      { description: "Fetch a single user.", readOnly: true },
      obj({ id: str("user UUID") }, ["id"]),
      (a, h) =>
        callApi(app, {
          method: "GET",
          path: `/api/users/${encodeURIComponent(String(a.id))}`,
          headers: h
        })
    ),
    tool(
      "create_user",
      {
        description:
          "Provision a local user. Password is OPTIONAL — omit to create an SSO-only account.",
        destructive: true
      },
      obj(
        {
          email: str("email address"),
          password: opt("plaintext password; omit for SSO-only"),
          displayName: opt("display name")
        },
        ["email"]
      ),
      (a, h) =>
        callApi(app, {
          method: "POST",
          path: "/api/users",
          headers: h,
          body: {
            email: a.email,
            ...(a.password ? { password: a.password } : {}),
            ...(a.displayName ? { displayName: a.displayName } : {})
          }
        })
    ),
    tool(
      "update_user",
      { description: "Update a user's display name or status (active | disabled)." },
      obj(
        {
          id: str("user UUID"),
          displayName: opt("new display name"),
          status: opt("active | disabled"),
          password: opt("new plaintext password (rotation)")
        },
        ["id"]
      ),
      (a, h) => {
        const body: Record<string, unknown> = {};
        if (a.displayName) body.displayName = a.displayName;
        if (a.status) body.status = a.status;
        if (a.password) body.password = a.password;
        return callApi(app, {
          method: "PATCH",
          path: `/api/users/${encodeURIComponent(String(a.id))}`,
          headers: h,
          body
        });
      }
    ),
    tool(
      "delete_user",
      {
        description:
          "Delete a user. CASCADES all of the user's role grants. The user's audit log entries are preserved (actorId remains).",
        destructive: true
      },
      obj({ id: str("user UUID") }, ["id"]),
      (a, h) =>
        callApi(app, {
          method: "DELETE",
          path: `/api/users/${encodeURIComponent(String(a.id))}`,
          headers: h
        })
    ),
    tool(
      "list_grants",
      { description: "List a user's role grants.", readOnly: true },
      obj({ id: str("user UUID") }, ["id"]),
      (a, h) =>
        callApi(app, {
          method: "GET",
          path: `/api/users/${encodeURIComponent(String(a.id))}/grants`,
          headers: h
        })
    ),
    tool(
      "add_grant",
      {
        description:
          "Grant a role to a user at a scope (global / tenant / env / pipeline). EXPANDS privileges — handle with care.",
        destructive: true
      },
      obj(
        {
          userId: str("user UUID"),
          role: str("role name"),
          tenantId: opt("tenant UUID for tenant/env/pipeline scope"),
          environment: opt("environment name for env scope"),
          pipelineId: opt("pipeline UUID for pipeline scope")
        },
        ["userId", "role"]
      ),
      (a, h) =>
        callApi(app, {
          method: "POST",
          path: `/api/users/${encodeURIComponent(String(a.userId))}/grants`,
          headers: h,
          body: {
            role: a.role,
            ...(a.tenantId ? { tenantId: a.tenantId } : {}),
            ...(a.environment ? { environment: a.environment } : {}),
            ...(a.pipelineId ? { pipelineId: a.pipelineId } : {})
          }
        })
    ),
    tool(
      "remove_grant",
      {
        description:
          "Revoke a user's role grant. The user immediately loses any access uniquely derived from the grant.",
        destructive: true
      },
      obj(
        { userId: str("user UUID"), grantId: str("grant UUID") },
        ["userId", "grantId"]
      ),
      (a, h) =>
        callApi(app, {
          method: "DELETE",
          path: `/api/users/${encodeURIComponent(
            String(a.userId)
          )}/grants/${encodeURIComponent(String(a.grantId))}`,
          headers: h
        })
    ),
    tool(
      "list_roles",
      { description: "List roles + their effective permissions.", readOnly: true },
      obj({}),
      (_a, h) => callApi(app, { method: "GET", path: "/api/roles", headers: h })
    ),
    tool(
      "create_role",
      { description: "Create a custom role. Built-in role names are reserved." },
      obj(
        { name: str("new role name"), description: opt("description") },
        ["name"]
      ),
      (a, h) =>
        callApi(app, {
          method: "POST",
          path: "/api/roles",
          headers: h,
          body: { name: a.name, ...(a.description ? { description: a.description } : {}) }
        })
    ),
    tool(
      "set_role_permissions",
      {
        description:
          "Replace a role's permission set wholesale. Affects every user holding the role globally — including built-ins.",
        destructive: true,
        idempotent: true
      },
      obj(
        {
          name: str("role name"),
          permissions: anyType("array of permission strings (full replacement)")
        },
        ["name", "permissions"]
      ),
      (a, h) =>
        callApi(app, {
          method: "PUT",
          path: `/api/roles/${encodeURIComponent(String(a.name))}/permissions`,
          headers: h,
          body: { permissions: a.permissions }
        })
    ),
    tool(
      "delete_role",
      {
        description:
          "Delete a custom role. 409s on built-in roles. Existing grants on the role are revoked.",
        destructive: true
      },
      obj({ name: str("role name") }, ["name"]),
      (a, h) =>
        callApi(app, {
          method: "DELETE",
          path: `/api/roles/${encodeURIComponent(String(a.name))}`,
          headers: h
        })
    ),

    // ---- Identity providers + auth settings -------------------------------
    tool(
      "list_identity_providers",
      { description: "List SSO connections (secrets redacted).", readOnly: true },
      obj({}),
      (_a, h) =>
        callApi(app, { method: "GET", path: "/api/identity-providers", headers: h })
    ),
    tool(
      "create_identity_provider",
      {
        description:
          "Register an OIDC or SAML identity provider. Config field values containing secrets are encrypted on write and redacted on read."
      },
      obj(
        {
          slug: str("URL-safe identifier; appears in the SSO start URL"),
          kind: str("oidc | saml"),
          displayName: str("button label on the login page"),
          config: anyType("provider-specific config object")
        },
        ["slug", "kind", "displayName", "config"]
      ),
      (a, h) =>
        callApi(app, {
          method: "POST",
          path: "/api/identity-providers",
          headers: h,
          body: {
            slug: a.slug,
            kind: a.kind,
            displayName: a.displayName,
            config: a.config
          }
        })
    ),
    tool(
      "update_identity_provider",
      { description: "Update an IdP's display name, enabled flag, or config." },
      obj(
        {
          id: str("IdP UUID"),
          displayName: opt("new label"),
          enabled: bool("toggle login availability"),
          config: anyType("partial config patch; only the keys you provide are touched")
        },
        ["id"]
      ),
      (a, h) => {
        const body: Record<string, unknown> = {};
        if (a.displayName) body.displayName = a.displayName;
        if (typeof a.enabled === "boolean") body.enabled = a.enabled;
        if (a.config !== undefined) body.config = a.config;
        return callApi(app, {
          method: "PATCH",
          path: `/api/identity-providers/${encodeURIComponent(String(a.id))}`,
          headers: h,
          body
        });
      }
    ),
    tool(
      "delete_identity_provider",
      {
        description:
          "Delete an IdP. Users provisioned via it can no longer log in via SSO; their existing accounts remain (use update_user/delete_user to clean up).",
        destructive: true
      },
      obj({ id: str("IdP UUID") }, ["id"]),
      (a, h) =>
        callApi(app, {
          method: "DELETE",
          path: `/api/identity-providers/${encodeURIComponent(String(a.id))}`,
          headers: h
        })
    ),
    tool(
      "get_auth_settings",
      { description: "Get the instance signup mode + default role.", readOnly: true },
      obj({}),
      (_a, h) => callApi(app, { method: "GET", path: "/api/auth-settings", headers: h })
    ),
    tool(
      "update_auth_settings",
      {
        description:
          "Change the instance signup mode (admin_only | open_default_role | open_no_access) and the default role granted on open signup.",
        destructive: true
      },
      obj(
        {
          signupMode: str("admin_only | open_default_role | open_no_access"),
          defaultRole: opt("role name (only honoured when signupMode=open_default_role)")
        },
        ["signupMode"]
      ),
      (a, h) =>
        callApi(app, {
          method: "PATCH",
          path: "/api/auth-settings",
          headers: h,
          body: {
            signupMode: a.signupMode,
            defaultRole: a.defaultRole ?? null
          }
        })
    ),

    // ---- Audit + usage ----------------------------------------------------
    tool(
      "get_audit_log",
      { description: "Recent audit log entries (audit:view).", readOnly: true },
      obj({ tenant: opt("tenant uuid"), limit: int("default 50") }),
      (a, h) => {
        const q: Record<string, string | undefined> = {};
        if (a.tenant) q.tenant_id = String(a.tenant);
        if (a.limit) q.limit = String(a.limit);
        return callApi(app, { method: "GET", path: "/api/audit", headers: h, query: q });
      }
    ),
    tool(
      "get_usage_summary",
      { description: "Token + cost usage records (with a small summary).", readOnly: true },
      obj({ tenant: opt("tenant uuid"), execution: opt("execution id") }),
      (a, h) => {
        const q: Record<string, string | undefined> = {};
        if (a.tenant) q.tenant_id = String(a.tenant);
        if (a.execution) q.execution_id = String(a.execution);
        return callApi(app, { method: "GET", path: "/api/usage", headers: h, query: q });
      }
    )
  ];
}

// ---------------------------------------------------------------------------
// Server wiring
// ---------------------------------------------------------------------------

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
      inputSchema: t.inputSchema,
      annotations: t.annotations
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const def = byName.get(request.params.name);
    if (!def) return errorResult(`unknown tool: ${request.params.name}`);
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    // Per-call tenant override: tools that accept `tenant` in their args
    // also accept a global x-tenant-id header. The arg wins.
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
    transport.close?.();
    server.close?.();
  }
}
