# Call Pipeline

Invokes another pipeline by slug and returns its terminal output —
pipelines as reusable **modules**. Build small focused pipelines
(`retrieve-and-rerank`, `summarize`, `extract-citations`) and compose them
with this node instead of duplicating subgraphs across specs.

## Config

- `pipelineSlug` (string, required) — slug of the target pipeline.
- `pipelineVersion` (string, optional) — **pin** a specific version of the
  target for a reproducible dependency. Omit to follow the target's active
  deployment in the resolved environment (the callee can then change under you
  on redeploy).
- `environment` (string, optional) — environment to invoke the target in.
  Defaults to the caller's env (e.g. call a tenant's dev-env retriever from a
  prod-env composer).

## Inputs / Outputs

- `input` (any) — payload forwarded to the target's input node. When unwired,
  the entire `inputs` bag is passed ("just pass everything I got").
- `output` (any) — terminal output of the target pipeline.

## Module signature (typed contract)

A target pipeline can declare a signature so callers are checked, not trusting
a stringly-typed black box. In the target's spec:

```yaml
spec:
  signature:
    input:   { type: object, required: [question], properties: { question: { type: string } } }
    output:  { type: object, properties: { answer: { type: string } } }
```

- `signature.input` is validated (JSON Schema, via ajv) **at the call site,
  before the callee runs** — a bad payload fails loudly with
  `pipeline_call: input does not match "<slug>" signature: …` instead of
  corrupting data downstream.
- `signature.output` is validated on the way back — a callee that violates its
  own declared contract fails at the boundary.
- Absent → the callee is an untyped black box (unchanged legacy behavior). A
  malformed schema is treated as "no contract" rather than blocking callers.

Pin the version **and** declare a signature and a `pipeline_call` becomes a
genuine typed, reproducible dependency.

## Lineage

A nested run records the caller's execution id as its `parentExecutionId`
(persisted; `GET /api/executions/{id}` returns it). This is the call-tree edge
— a run's full composition is reconstructable, and usage/audit can be
attributed across the tree. Top-level runs have `parentExecutionId: null`.

## Gotchas

- **Synchronous-only (today).** The caller MUST itself be running
  synchronously (`/api/pipelines/:id/invoke` or `/stream`) — the runtime only
  injects the invoke capability there. A batch/queued run can't sub-invoke
  because a queued job isn't awaitable in-process. (Inline nested execution
  within a batch worker *is* awaitable and is a candidate future enhancement;
  the constraint is not fundamental, and predates the NATS queue.)
- **Cycle protection.** A → B → A throws `cycle detected`. The stack is
  per-execution, so independent invocations don't collide.
- **Depth limit.** `MAX_SYNC_DEPTH = 8` — real RAG compositions go 2–3 levels
  (planner → retriever → answer-shaper); the cap trips fast on accidental loops.
- **Same-tenant.** Nested calls run under the caller's tenant, so there is no
  cross-tenant reach. Entry is gated by the caller's `pipeline:run` on the
  OUTER pipeline; there is **not yet** a distinct per-target permission check,
  so within a tenant, anyone who can run the caller can reach any pipeline it
  names. Treat a composed pipeline's callee list as part of its trust surface.

## Typical position

`input → pipeline_call(slug: retrieve-and-rerank, pipelineVersion: 2.1.0) → basic_rag_prompt → provider_chat`
