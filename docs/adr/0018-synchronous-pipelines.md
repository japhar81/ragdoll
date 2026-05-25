# ADR 0018: Synchronous Pipelines and MCP Auto-Exposure

## Status

Accepted.

## Context

Pipelines historically ran one way: `/api/pipelines/:id/run` enqueued a
`RunPipelineJob` onto BullMQ and a worker drained it. The caller got a
job id back and polled `/api/executions/:id` for the result. That
shape fits ingestion / batch evaluation / scheduled runs, but it does
NOT fit interactive retrieval: a chat client wants the answer back
in a single HTTP round-trip, ideally with progress events as the DAG
runs. The original `/api/pipelines/:id/stream` endpoint acknowledged
this but returned a `not_enabled` stub.

Phase 8 introduces a second execution model — synchronous, in-process,
on the API pod — and pairs it with MCP auto-exposure so an LLM client
can call a pipeline as a tool.

## Decision

`PipelineSpec.metadata.executionKind` opts in to synchronous mode:

  metadata.executionKind: "batch" | "synchronous"   (default batch)
  metadata.mcpExpose:     boolean                   (default false)

Two new endpoints, both gated by the same `pipeline:run` RBAC the
batch path uses:

  POST /api/pipelines/:id/invoke
    Runs the DAG IN-PROCESS on the API pod. Returns
    `{ executionId, output, status: "succeeded" }` in one HTTP round-
    trip. Skips BullMQ entirely.

  POST /api/pipelines/:id/stream
    Same execution, wrapped in SSE. Yields `execution.started` then
    awaits the run and yields `execution.completed` / `output` /
    `done` as the run progresses. Real chunked delivery via the
    Fastify glue layer (async-iterable body → `reply.raw.write`).

Internally a single `runSyncPipeline(args)` helper handles config
resolution + DagExecutor construction + the Phase 5 dataset resolver.
Both endpoints call it; the executor is the same one the worker uses,
so v2 plugins behave identically on both paths. Per-execution call
stack + `MAX_SYNC_DEPTH=8` + cycle detection lets `pipeline_call`
compose synchronous sub-pipelines safely.

MCP auto-exposure: the existing `/mcp` server's `ListTools` /
`CallTool` handlers append every pipeline with
`executionKind: synchronous` AND `mcpExpose: true` to the dynamic
tool catalog. Tool name = pipeline slug; handler POSTs to /invoke so
the same auth + RBAC + dataset resolution apply. Lookup is per-MCP-
request so RBAC filtering on `/api/pipelines` is honored — a viewer's
MCP session only sees tools they could call via REST.

## Consequences

- Chat-style RAG is finally first-class. Build the pipeline
  (`query_hyde → dataset_search → rerank_llm → basic_rag_prompt →
  provider_chat`), flip it to synchronous, hit /invoke. Answer comes
  back in one call.
- MCP becomes a tool authoring surface. Operators ship a pipeline,
  flip `mcpExpose: true`, and an LLM client (Claude Desktop, etc.)
  picks it up as a callable tool by name. No glue code.
- The API pod does real work now. Synchronous executions consume CPU
  + memory there; for serious traffic patterns operators should
  consider running the API in a worker-style pool or splitting a
  dedicated `api-sync` deployment.
- The worker is still required for batch / scheduled / webhook runs.
  Synchronous-only deployments could in principle drop the worker
  but the scheduler + ingest flows live there.
- `pipeline_call` is sync-only by design. Batch pipelines can't
  sub-invoke because BullMQ jobs aren't awaitable in-process. The
  plugin throws a clear error rather than silently degrading.

## Alternatives considered

1. **Use the worker for sync execution too** (enqueue + wait on the
   job to finish via a short-poll). Tempting because it reuses the
   existing path, but it adds the BullMQ round-trip and Redis
   serialization to every chat request — a real latency tax.
2. **Server-Sent Events on /run instead of a new endpoint.** Mixes
   contracts (the same route accepts both queue-and-return and
   stream-immediately semantics depending on Accept header). Cleaner
   to keep `/run` as the batch entry point and stand up `/invoke` +
   `/stream` separately.
3. **Token-by-token provider streaming through to the HTTP response.**
   Currently the SSE frames are lifecycle (started / completed /
   output). Real provider token streaming requires a provider-layer
   AsyncIterable + plumbing it through the executor; deferred.
