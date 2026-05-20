# ADR 0012: Webhook Triggers, CLI, and MCP Endpoint

## Status

Accepted.

## Context

ADR 0009 + ADR 0011 left RAGdoll triggerable from the UI, from the auth'd
REST API, and from cron. The platform now needs:

- **Public webhooks** so external systems (CI, GitHub, Stripe-style hooks)
  can fire a run without a long-lived API key.
- A **CLI** so operators can script tenants/pipelines/users without writing
  fetch boilerplate against the OpenAPI.
- An **MCP** endpoint so an LLM client can discover and call the platform's
  surface as standard MCP tools.

## Decision

**Webhook triggers.** A new `webhook_triggers` table binds
`(tenant, pipeline, environment, [activation])` to a hashed
`wht_<prefix>_<secret>` token (mirrors `api_keys`: sha256 + 12-char prefix
lookup; constant-time compare; plaintext shown ONCE). `POST /api/triggers/
webhook/{token}` is the only public route on this surface — the token IS the
auth. Mint / list / revoke are auth'd and scoped by `pipeline:run` against
the *trigger's* scope, so a tenant operator cannot mint a trigger for a
different tenant. The run path is the shared `enqueuePipelineRun` helper,
so audit + execution seeding behave identically across all sources (UI, API,
cron, webhook). Two palette plugins ship: `webhook_trigger` (pass-through
input node) and `webhook_output` (sink that POSTs the result, with an
optional `Authorization` header sourced from a secret reference).

**CLI** (`apps/cli`). Tiny `commander`-based binary with one module per
resource group. Auth + selected tenant persist in `~/.ragdoll/config.json`
(env vars override the file for CI). Default output is JSON; `-o table`
renders homogeneous arrays. The CLI never re-implements business logic —
every command is one fetch through the same headers a human browser would
send, so RBAC behaves identically.

**MCP** (`/mcp`). Stateless Streamable HTTP transport: each request spawns
a fresh `Server` + `StreamableHTTPServerTransport`, with closures over the
caller's `Authorization` header. Tools wrap the REST surface; their handlers
re-enter `app.handle(...)` in-process, so Casbin scoping is enforced exactly
as on HTTP. The `pipelines` resource is exposed dynamically (listing reflects
what the principal can see). The SDK + transport are added as real
dependencies (`@modelcontextprotocol/sdk`); installation is required to run
the API server but the in-memory unit tests use the SDK's `InMemoryTransport`
so they don't need a live HTTP socket.

## Consequences

- One ingestion path (`enqueuePipelineRun`) means audit, execution rows, and
  worker behaviour are uniform across triggers — operators see "where it
  came from" via `source: "webhook" | "schedule" | …`.
- Public webhook tokens are bearer-in-URL; rotation = revoke + mint anew.
  Multi-replica deployments need shared DB (already the case) — there is no
  per-process trigger state.
- The CLI accepts API keys, so CI doesn't need a session token.
- MCP tool calls produce real audit rows; an LLM that runs a pipeline is
  attributable to the user whose token it carries.
- We accepted a real `npm install` requirement for the MCP server (matches
  how `casbin`, `croner`, `pg` already work). The unit-test surface stays
  install-free where it can.
