# Triggering Pipelines

RAGdoll pipelines can be started in four ways. All four flow through the same
queue + worker + execution store, so monitoring (`/api/executions`, audit log)
is identical regardless of source.

| Source | Endpoint | Auth |
| --- | --- | --- |
| **UI** | "Run" in the Pipeline Builder | Session token |
| **REST API** | `POST /api/pipelines/{id}/run` | Bearer / API key |
| **Cron** | Worker scheduler (see `croner`) | Internal (no user) |
| **Webhook** | `POST /api/triggers/webhook/{token}` | The token itself |
| **CLI** | `ragdoll pipelines run <id>` | Whatever `~/.ragdoll/` holds |
| **MCP** | `run_pipeline` tool over `/mcp` | Bearer (forwarded from the MCP request) |

## Direct REST API

```bash
curl -X POST https://api.example/api/pipelines/<id>/run \
  -H "authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT" \
  -H "content-type: application/json" \
  -d '{"input":{"question":"What is RAGdoll?"},"environment":"prod"}'
```

Response `202` with `{ executionId, pipelineId, version, status: "accepted" }`.
Use `/api/executions/{id}/trace` to poll the per-node trace.

## Webhook triggers

Mint a public URL bound to a `(tenant, pipeline, environment, [activation])`
tuple. Anyone holding the URL can POST to it; the request body becomes the
run's input. Only a sha256 hash + 12-char prefix are stored — the plaintext
is shown ONCE.

```bash
# Mint (authenticated)
curl -X POST https://api.example/api/pipelines/<id>/triggers \
  -H "authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT" \
  -H "content-type: application/json" \
  -d '{"name":"github-push","environment":"prod"}'
# -> { trigger: { id, name, prefix, ... }, token: "wht_<prefix>_<secret>", url: "..." }

# Fire (no auth header — the path token IS the auth)
curl -X POST https://api.example/api/triggers/webhook/wht_xxx_yyy \
  -H "content-type: application/json" \
  -d '{"question":"What is RAGdoll?"}'
```

Authorization: minting / revoking requires `pipeline:run` at the target scope
(so a tenant operator can only mint for pipelines in their tenant). Revoking
is `DELETE /api/triggers/{id}`. The trigger row tracks `last_triggered_at`
for operator visibility.

There are also two palette nodes — **Webhook Trigger** (input source) and
**Webhook Output** (sink that POSTs the pipeline result to a configured URL,
with an optional `Authorization` header sourced from a secret reference).

## Cron

See [access-control.md](./access-control.md) and the Scheduler screen. Cron
parsing + DST is handled by [croner](https://github.com/Hexagon/croner).

## CLI

See [cli.md](./cli.md). Most useful for ops: `ragdoll pipelines run`,
`ragdoll pipelines triggers create / list / delete`, `ragdoll executions
trace`.

## MCP

See [mcp.md](./mcp.md). LLM clients connect to `/mcp` and call the
`run_pipeline`, `list_executions`, `create_pipeline_trigger`, etc. tools.

## What happens after a trigger fires

1. The control plane resolves the active version (activation > deployment)
   and validates the spec against the plugin registry.
2. A `run_pipeline` job is enqueued onto the same BullMQ / in-memory queue
   the worker drains.
3. An `execution` row is seeded so `GET /api/executions` reflects the run
   immediately (status `running`).
4. The worker dispatches the DAG, writing per-node traces.
5. Audit log: every trigger source writes a `pipeline.run` audit row with
   the source identified (`source: "schedule"` for cron, `source: "webhook"`
   for webhook triggers; UI / API / CLI / MCP carry the actor's principal
   id).
