# Runtime Architecture

The runtime is a DAG executor behind `DagExecutor` (`packages/runtime`). It is
intentionally replaceable by LangGraph, Temporal, or another workflow engine.

## RuntimeContext

Each execution receives:

- `requestId`
- `executionId`
- `tenantId`
- `pipelineId`
- `pipelineVersionId`
- `environment`
- `actor`
- `resolvedConfig`
- `deadline`
- `signal`

## Version resolution

`pipelineVersionId` is resolved before the run (see ADR 0009). Precedence:
an API-pinned `pipelineVersionId` wins; otherwise, if the tenant has
activations for `(tenant, pipeline, environment)`, the worker picks one via
`resolveActivation(label)` (explicit label > `default` > sole-enabled) and
resolves `effectiveVersionId(activation, pipeline.latestVersionId)`
(track-latest follows the pointer; pinned uses its own version); otherwise
it falls back to the legacy `pipeline_deployments` selection. The resolved
id is what the executor records on the execution and span.

Scheduler-originated jobs enqueue with no `pipelineVersionId` and
`source: "schedule"`, so they take the activation path identically to API
runs.

## Node contract

Input:

```json
{
  "context": {},
  "node": {},
  "inputs": {},
  "config": {},
  "secrets": {}
}
```

Output:

```json
{
  "outputs": {},
  "metadata": {},
  "usage": {},
  "artifacts": []
}
```

## Execution controls

The executor validates the spec, then records execution and node history,
applies redaction to recorded payloads, resolves tenant secrets per node, and
resolves `${config.*}` templates from the resolved config.

- **Deadline.** Before the run and before each node, `context.deadline` is
  checked. If it has passed, a `DeadlineExceededError` is thrown.
- **Cancellation.** `context.signal` (an `AbortSignal`) is checked at the same
  points and before each plugin retry. An aborted signal raises a
  `CancelledError`. Both `DeadlineExceededError` and `CancelledError` complete
  the execution with status `cancelled` (not `failed`).
- **Retries.** Plugin nodes retry up to `maxRetries` with linear backoff;
  deadline/cancel errors are never retried.
- **Usage.** When a plugin returns `usage`, a `UsageRecord` (provider, model,
  token counts, latency) is written to the execution store; cost is computed
  outside the adapter.
- **Tracing.** An injected `Tracer` (default `NoopTracer`) emits one span per
  execution and one per node, carrying tenant, pipeline, version, execution,
  environment, and request attributes. Exceptions and error messages are
  recorded on the span. Real OpenTelemetry is wired lazily via
  `createTracer()` (see ADR 0007).
