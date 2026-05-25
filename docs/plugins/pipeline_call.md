# Call Pipeline

Invokes another synchronous pipeline by slug and returns its terminal
output. Composition over inheritance: build small focused pipelines
(`retrieval`, `summarize`, `extract-citations`) and compose them with
this plugin instead of duplicating nodes across specs.

## Inputs

- `input` (any) — payload forwarded to the target pipeline's input
  node. When unset, the entire `inputs` bag is passed.

## Outputs

- `output` (any) — terminal output of the target pipeline.

## Gotchas

- **Synchronous-only**. The caller MUST itself be running synchronously
  (i.e. invoked via `/api/pipelines/:id/invoke` or `/stream`). Batch
  pipelines can't sub-invoke because BullMQ jobs aren't awaitable
  in-process; the plugin throws "pipeline_call requires synchronous
  execution context" otherwise.
- **Cycle protection**. Pipeline A → B → A throws "cycle detected".
  Track is per-execution, so two independent invocations don't collide.
- **Depth limit**. `MAX_SYNC_DEPTH = 8`. Real RAG compositions go 2-3
  levels deep (planner → retriever → answer-shaper); the cap is
  conservative and trips fast on accidental loops.
- **RBAC**. The same identity that called the outer pipeline must hold
  `pipeline:run` on the target — checked at every nested invocation.
- Target environment defaults to the caller's. Override via
  `config.environment` to call a sub-pipeline deployed in a different
  env (e.g. a tenant's dev-env retriever from a prod-env composer).

## Typical position

`input → pipeline_call(slug: retrieve-and-rerank) → basic_rag_prompt → provider_chat`
