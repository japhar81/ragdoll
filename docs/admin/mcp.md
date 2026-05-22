# MCP Endpoint (`/mcp`)

RAGdoll exposes a [Model Context Protocol](https://modelcontextprotocol.io)
server at `POST /mcp` (Streamable HTTP transport, stateless mode) so an LLM
client — Claude Desktop, IDE extensions, or any MCP client — can list and
call tools that drive the entire platform.

Tools never re-implement business logic: every call re-enters
`app.handle(...)` in-process with the original `Authorization` header
attached, so Casbin RBAC applies exactly as it would for a direct HTTP
request.

## What the LLM can do

The catalog covers **full control** over every domain in the control plane:
read, create, update, and delete for tenants, environments, pipelines,
versions, deployments, schedules, triggers, config, secrets, users, roles,
grants, and identity providers. Mutating tools that materially change state
are flagged (see "Dangerous tools" below).

### Read-only

| Tool | Effect |
| --- | --- |
| `list_tenants`, `get_tenant` | tenants |
| `list_environments` | per-tenant environment catalog |
| `list_tenant_pipelines`, `list_activations`, `list_deployments` | tenant ↔ pipeline state |
| `list_folders` | pipeline folder tree |
| `list_pipelines`, `get_pipeline`, `list_pipeline_versions` | pipelines + versions |
| `validate_pipeline_spec` | dry-run validation of a spec object |
| `list_pipeline_triggers` | webhook triggers |
| `list_schedules` | cron schedules |
| `list_config_definitions`, `list_config_values`, `get_resolved_config` | config catalog + effective resolution |
| `list_secrets` | secret metadata only — values are ALWAYS `REDACTED` |
| `list_plugins`, `get_plugin`, `get_plugin_docs` | plugin registry — manifests (config schema + named ports) and narrative docs |
| `list_users`, `get_user`, `list_grants` | users + grants |
| `list_roles`, `list_identity_providers`, `get_auth_settings` | RBAC + SSO |
| `list_executions`, `get_execution`, `get_execution_trace` | run history |
| `get_audit_log`, `get_usage_summary` | observability |

### Mutating (non-destructive)

These create new state or non-destructively update existing rows:

- `create_tenant`, `update_tenant`
- `create_environment`
- `associate_pipeline`, `set_pipeline_association_enabled`, `create_activation`, `update_activation`
- `create_pipeline`, `update_pipeline`, `save_pipeline_version`
- `create_folder`, `update_folder`
- `create_schedule`, `toggle_schedule`
- `create_pipeline_trigger`
- `upsert_config_value`
- `create_user`, `update_user`
- `create_role`, `create_identity_provider`, `update_identity_provider`
- `run_pipeline` (queues a run; the run itself may write data, but the tool
  call is the same as clicking Run in the UI)

### Dangerous — flagged in two ways

The MCP SDK supports annotation hints (`readOnlyHint`, `destructiveHint`,
`idempotentHint`). RAGdoll sets all three for every tool. In addition,
destructive tools prefix their description with **"⚠ DANGEROUS:"** so a
client that ignores annotations still sees the warning at prompt time.

| Tool | What it does |
| --- | --- |
| `delete_tenant` | CASCADE-drops the tenant and every pipeline, secret, schedule, grant under it |
| `delete_environment` | drops an env from a tenant's catalog (existing rows that reference the name still work) |
| `delete_activation` | removes an activation row; runs that resolved this label 409 until re-targeted |
| `delete_pipeline` | drops the pipeline + every version, deployment, activation |
| `delete_folder` | only if empty (409s otherwise) |
| `deploy_pipeline` | UPSERTs the active deployment for (pipeline, env, tenant) — new runs immediately use the new version |
| `rollback_pipeline` | moves the pipeline's `latest` pointer back; call `deploy_pipeline` after to actually serve the prior version |
| `delete_schedule` | in-flight runs continue; no new ones fire |
| `delete_pipeline_trigger` | revokes a webhook URL immediately |
| `upsert_config_definition` | flipping `secret: true` on an existing key changes how subsequent values are stored |
| `delete_config_definition` | values for the key stop resolving through the catalog |
| `delete_config_value` | dependents fall back to the next-most-specific scope |
| `create_secret` | accepts PLAINTEXT and writes the encrypted form; the plaintext is never re-emitted |
| `delete_secret` | every pipeline that resolves the reference fails to run until recreated |
| `create_user` | provisions an auth account |
| `delete_user` | CASCADES grants; audit log entries are preserved |
| `add_grant` / `remove_grant` | widens / narrows what a user can do; effective immediately |
| `set_role_permissions` | wholesale replacement; affects every user holding the role globally |
| `delete_role` | revokes every grant for the role; 409s on built-ins |
| `delete_identity_provider` | users provisioned via the IdP can no longer SSO in |
| `update_auth_settings` | changes the instance signup mode |

A well-behaved client should:

1. Read `tools/list` and gate destructive tools behind a confirmation step
   (Claude Desktop and the official `mcp-cli` already do this when
   `destructiveHint: true`).
2. Show the ⚠ prefix verbatim in any approval UI.
3. Refuse to call a destructive tool autonomously without a human signal.

## Building pipelines

The plugin tools give an LLM everything it needs to author a pipeline spec
from scratch — discover the nodes, then understand each one in context:

1. `list_plugins` — the registry: every plugin's category, id, version.
2. `get_plugin` — one plugin's **structured manifest**: config schema (with
   per-field types + defaults) and the named input/output **port contract**
   that edges wire to. Plugins whose ports are author-defined (e.g.
   `transform`) carry `dynamicPorts` instead of a fixed port list.
3. `get_plugin_docs` — the **narrative doc**: what the node does, its
   inputs/outputs in prose, gotchas, typical pipeline position, and worked
   examples. Read this alongside the manifest before wiring a node.

Then compose and persist the spec:

4. `validate_pipeline_spec` — dry-run a candidate spec (DAG shape, plugin
   refs, port names, config/secret refs) without saving. Iterate against the
   returned warnings/errors.
5. `create_pipeline` then `save_pipeline_version` — persist the spec as a
   version (`publish: true` to make it deployable).
6. `deploy_pipeline` then `run_pipeline` — serve and execute it.

To **edit** an existing pipeline, `list_pipeline_versions` returns every
saved version with its full spec: read the latest, modify it, and
`save_pipeline_version` the result as a new version.

## Resources

A `pipelines` resource is exposed dynamically — listing reflects the
pipelines the calling principal can see; reading returns the pipeline
metadata as JSON:

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

`/mcp` is **not** in the public-path list — every request must carry a
Bearer token (or `x-api-key`) the `AuthResolver` accepts. Unauthenticated
calls surface as `HTTP 401` inside the tool's `content` (`isError: true`).
Scoped permissions still apply: a `tenant_admin @ t/T` can `run_pipeline`
for pipelines in T but not in another tenant, and can `delete_pipeline`
for that tenant but not for another.

## Operational notes

- **Stateless**: each `/mcp` request spawns a fresh `Server` + transport,
  so no per-session state survives across calls. Useful state (pipelines,
  runs, grants) is persisted in the control plane and re-read on each
  tool call.
- **Audit**: tool calls produce the same audit rows as the equivalent
  HTTP requests, including `pipeline.run` on `run_pipeline` and
  `pipeline.delete` on `delete_pipeline`.
- **Errors**: non-2xx API responses are returned as `isError: true`
  content rather than thrown, so the LLM gets a structured message to
  react to. `204 No Content` is surfaced as `"{}"` so DELETE tools have
  a well-formed response payload.
- **Tenant scoping**: every tool that needs a tenant accepts the global
  `x-tenant-id` request header AND a per-call `tenant` argument. The
  argument wins.
