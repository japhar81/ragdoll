# MCP Endpoint (`/mcp`)

RAGdoll exposes a [Model Context Protocol](https://modelcontextprotocol.io)
server at `POST /mcp` (Streamable HTTP transport, stateless mode) so an LLM
client — Claude Desktop, IDE extensions, or any MCP client — can list and
call tools that drive the platform.

Tools never re-implement business logic: every call re-enters `app.handle(...)`
in-process with the original `Authorization` header attached, so Casbin RBAC
applies exactly as it would for a direct HTTP request.

## Tools

| Tool | Effect |
| --- | --- |
| `list_tenants` | GET /api/tenants |
| `list_pipelines` | GET /api/pipelines |
| `get_pipeline` | GET /api/pipelines/{id} |
| `list_pipeline_versions` | GET /api/pipelines/{id}/versions |
| `run_pipeline` | POST /api/pipelines/{id}/run (`input`, `environment`, `activation`, `tenant`) |
| `list_executions`, `get_execution`, `get_execution_trace` | execution + trace |
| `list_schedules` | GET /api/schedules |
| `list_pipeline_triggers`, `create_pipeline_trigger` | webhook trigger lifecycle |
| `list_users`, `list_roles`, `list_identity_providers` | access-control surface |
| `get_audit_log`, `get_usage_summary` | observability |

## Resources

A `pipelines` resource is exposed dynamically — listing reflects the pipelines
the calling principal can see; reading returns the pipeline metadata as JSON:

```
ragdoll://pipelines/<pipelineId>
```

## Connecting

A minimal client (Streamable HTTP):

```jsonc
// e.g. Claude Desktop's `claude_desktop_config.json` mcpServers entry
{
  "mcpServers": {
    "ragdoll": {
      "type": "http",
      "url": "https://api.example/mcp",
      "headers": {
        "authorization": "Bearer <session-token-or-rgd-api-key>",
        "x-tenant-id": "<tenant-uuid>"   // optional; many tools accept `tenant` as an arg too
      }
    }
  }
}
```

For local dev with the bundled bootstrap admin:

```jsonc
{
  "mcpServers": {
    "ragdoll-local": {
      "type": "http",
      "url": "http://localhost:3001/mcp",
      "headers": { "authorization": "Bearer <login token from /api/auth/login>" }
    }
  }
}
```

## Authorization

`/mcp` is **not** in the public-path list — every request must carry a Bearer
token (or `x-api-key`) the {@link AuthResolver} accepts. Unauthenticated
calls surface as `HTTP 401` inside the tool's `content` (`isError: true`).
Scoped permissions still apply: a `tenant_admin @ t/T` can `run_pipeline` for
pipelines in T but not in another tenant.

## Operational notes

- **Stateless**: each `/mcp` request spawns a fresh `Server` + transport, so
  no per-session state survives across calls. Useful state (pipelines, runs,
  grants) is persisted in the control plane and re-read on each tool call.
- **Audit**: tool calls produce the same audit rows as the equivalent HTTP
  requests, including `pipeline.run` on `run_pipeline`.
- **Errors**: non-2xx API responses are returned as `isError: true` content
  rather than thrown, so the LLM gets a structured message to react to.
