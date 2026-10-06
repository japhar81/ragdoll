import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type { PipelineEdge, PipelineNode, PipelineSpec, RuntimeContext, SecretRef, UsageRecord } from "../../core/src/index.ts";
import { redactValue } from "../../core/src/index.ts";
import type { SecretProvider } from "../../secrets/src/index.ts";
import {
  type DatasetResolver,
  type DatasetRef,
  type IngestStateEntry,
  type IngestStateStore,
  type PluginExecutionOutput,
  type PluginRegistry,
  type ResolvedDataset
} from "../../plugin-sdk/src/index.ts";
// Transport dispatch is a separate subpath so the web bundle never reaches
// connect-rpc through pipeline-spec → plugin-sdk. Server-side runtime only.
import { executeRegisteredPlugin } from "../../plugin-sdk/src/transport.ts";
import { validatePipelineSpec } from "../../pipeline-spec/src/index.ts";
import { DatasetNotBuiltError } from "./dataset-resolver.ts";
import type { Tracer } from "../../observability/src/index.ts";
import { NoopTracer, runtimeAttributes, getMeter } from "../../observability/src/index.ts";

/** Thrown when execution exceeds `context.deadline`. */
export class DeadlineExceededError extends Error {
  constructor(message = "Execution deadline exceeded") {
    super(message);
    this.name = "DeadlineExceededError";
  }
}

/** Thrown when execution is aborted via `context.signal`. */
export class CancelledError extends Error {
  constructor(message = "Execution cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof CancelledError || error instanceof DeadlineExceededError;
}

export interface ExecutionRecord {
  executionId: string;
  tenantId: string;
  pipelineId: string;
  pipelineVersionId: string;
  /** Environment name the run was bound to (e.g. "dev", "prod"). Required:
   *  every code path that calls a pipeline knows the environment because
   *  the runtime resolves the version + config + dataset against it. The
   *  postgres store previously fell back to the literal string "unknown"
   *  when this was missing — that silently masked bugs where the SSE /
   *  in-process paths forgot to thread env through the ExecutionRecord. */
  environment: string;
  /**
   * `denied` is the terminal status the worker writes when a job is dequeued
   * but the enqueuer no longer holds the grant the run requires. Distinct
   * from `failed` so retry semantics don't kick in and so the UI can render
   * a clear "authorization revoked" message instead of an opaque error.
   */
  status: "running" | "succeeded" | "failed" | "cancelled" | "denied";
  startedAt: string;
  completedAt?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  /**
   * Identifier of the principal that originally enqueued this run. The API
   * captures it from `request.principal.id`; the worker writes it through
   * unchanged. `null` for system-triggered jobs (the scheduler / webhook
   * triggers — those have no live human principal).
   */
  actorId?: string | null;
  /**
   * When this run was invoked as a step by another pipeline (`pipeline_call`),
   * the parent execution's id — the call-tree edge. `null` for a top-level run.
   */
  parentExecutionId?: string | null;
}

export interface ExecutionNodeRecord {
  executionId: string;
  nodeId: string;
  status: "running" | "succeeded" | "failed" | "skipped";
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
}

/**
 * Per-run summary of how many nodes did work vs. were skipped. Surfaced
 * inside the execution's output bag (key `__ragdollSummary__`) so the UX
 * stops lying when "succeeded" actually means "every downstream skipped
 * because the root produced an empty bag".
 *
 * `noWorkDone=true` is the case we care about: pipeline did not throw, but
 * the only nodes that ran were source nodes — i.e. zero documents / zero
 * chunks / zero LLM calls / zero writes. The most common cause is an
 * `input`-type node receiving no run payload from "Run All", or a
 * filesystem source pointing at a path that doesn't exist (the classic
 * `/workspace` no-mount footgun).
 */
export interface RuntimeExecutionSummary {
  nodesTotal: number;
  nodesCompleted: number;
  nodesSkipped: number;
  noWorkDone: boolean;
  /** Short, machine-readable reason. Today: `"all_downstream_skipped"`
   *  when only root nodes ran; absent otherwise. */
  reason?: string;
}

/**
 * One streamed step frame (ADR-0037). Emitted when a node opts into
 * result streaming (`node.stream`) or a plugin calls `ctx.emit(...)`. The
 * runtime assigns `frameId` + `seq` and redacts `data`; stores persist it to
 * `execution_events` and the worker's publishing decorator fans a size-capped
 * copy onto the change bus.
 */
export interface ExecutionStepRecord {
  /** Stable per-frame id (becomes the execution_events row id). */
  frameId: string;
  executionId: string;
  nodeId: string;
  /** Channel label (node.streamAs, ctx.emit channel, or the node id). */
  channel: string;
  source: "node_output" | "emit";
  /** Monotonic per-execution sequence assigned by the runtime. */
  seq: number;
  at: string;
  /** Redacted body. */
  data: Record<string, unknown>;
}

export interface ExecutionStore {
  start(record: ExecutionRecord): Promise<void>;
  complete(record: ExecutionRecord): Promise<void>;
  startNode(record: ExecutionNodeRecord): Promise<void>;
  completeNode(record: ExecutionNodeRecord): Promise<void>;
  recordUsage(record: UsageRecord): Promise<void>;
  /**
   * Persist a streamed step frame (ADR-0037). Optional — stores that predate
   * result streaming simply don't implement it and the runtime skips
   * persistence for them (streaming is opt-in + best-effort). Stores that DO
   * implement it must be idempotent on `frameId` (replay-on-reconnect can
   * re-deliver). */
  recordStep?(record: ExecutionStepRecord): Promise<void>;
}

export class InMemoryExecutionStore implements ExecutionStore {
  executions: ExecutionRecord[] = [];
  nodes: ExecutionNodeRecord[] = [];
  usage: UsageRecord[] = [];

  async start(record: ExecutionRecord): Promise<void> {
    this.executions.push(record);
  }

  async complete(record: ExecutionRecord): Promise<void> {
    this.executions = this.executions.filter((existing) => existing.executionId !== record.executionId);
    this.executions.push(record);
  }

  async startNode(record: ExecutionNodeRecord): Promise<void> {
    this.nodes.push(record);
  }

  async completeNode(record: ExecutionNodeRecord): Promise<void> {
    this.nodes = this.nodes.filter((existing) => !(existing.executionId === record.executionId && existing.nodeId === record.nodeId));
    this.nodes.push(record);
  }

  async recordUsage(record: UsageRecord): Promise<void> {
    this.usage.push(record);
  }

  steps: ExecutionStepRecord[] = [];
  async recordStep(record: ExecutionStepRecord): Promise<void> {
    // Idempotent on frameId (mirrors the persistent stores' upsert semantics).
    this.steps = this.steps.filter((s) => s.frameId !== record.frameId);
    this.steps.push(record);
  }
}

/**
 * Tenant + pipeline scoped store of small ingest state buckets keyed by
 * `stateKey`. The DAG executor builds one of these per execution and hands it
 * to plugins via PluginExecutionInput so they never see other tenants' data.
 */
export interface IngestStateRepository {
  list(args: { tenantId: string; pipelineId: string; stateKey: string }): Promise<IngestStateEntry[]>;
  replaceAll(args: {
    tenantId: string;
    pipelineId: string;
    stateKey: string;
    entries: IngestStateEntry[];
  }): Promise<void>;
}

/** In-memory repository used by tests and dev runs without Postgres. */
export class InMemoryIngestStateRepository implements IngestStateRepository {
  private rows = new Map<string, IngestStateEntry[]>();
  private key(args: { tenantId: string; pipelineId: string; stateKey: string }): string {
    return `${args.tenantId} ${args.pipelineId} ${args.stateKey}`;
  }
  async list(args: { tenantId: string; pipelineId: string; stateKey: string }): Promise<IngestStateEntry[]> {
    return [...(this.rows.get(this.key(args)) ?? [])];
  }
  async replaceAll(args: {
    tenantId: string;
    pipelineId: string;
    stateKey: string;
    entries: IngestStateEntry[];
  }): Promise<void> {
    this.rows.set(this.key(args), [...args.entries]);
  }
}

/**
 * Optional execution-lifecycle interceptors (ADR 0036 pre-lane). The worker
 * adapts its platform-plugin dispatcher into these callbacks; the runtime
 * stays decoupled from `@ragdoll/platform-plugins`. Each returns void when it
 * has nothing to change (or no hooks matched).
 */
export interface ExecutionLifecycleHooks {
  /** Before any node runs. Return `deny` to abort (execution → `denied`), or
   *  `input` to replace the run input. */
  onStart?(args: {
    context: RuntimeContext;
    input: Record<string, unknown>;
  }): Promise<
    { deny?: { reason: string }; input?: Record<string, unknown> } | void
  >;
  /** After the last node, before the terminal success commit. Return `fail`
   *  to force-fail the run, or `output` to replace the result. */
  onFinish?(args: {
    context: RuntimeContext;
    output: Record<string, unknown>;
  }): Promise<
    { fail?: { reason: string }; output?: Record<string, unknown> } | void
  >;
}

export interface DagExecutorOptions {
  pluginRegistry: PluginRegistry;
  secretProvider: SecretProvider;
  store: ExecutionStore;
  /** Optional. When unset, plugins requesting ingestStateStore see undefined
   *  and must handle that themselves (delta_filter treats it as empty state). */
  ingestStateRepository?: IngestStateRepository;
  /**
   * Optional dataset resolver (Phase 5 of dataset/RBAC/retrieval
   * refactor). When wired AND a node carries `dataset: { slug, alias? }`,
   * the executor resolves it against the running tenant/env and either
   * hands a v2 plugin a {@link ResolvedDataset} on its execution input
   * OR splices the resolved backend collection names into a v1 plugin's
   * `config.collection` / `config.index` via the shim. When unset every
   * plugin sees only what was in `node.config` — preserves the
   * install-free unit-test path and pre-Phase-5 behaviour exactly.
   */
  datasetResolver?: DatasetResolver;
  /**
   * ADR-0021 external connection resolver. When wired AND a node carries
   * `connection: { slug }`, the executor resolves it through the same
   * env -> tenant -> global cascade as datasets and hands the v2 plugin
   * a {@link ResolvedExternalConnection} on `input.connection`. When
   * unset, `connection`-bearing nodes get `input.connection = undefined`
   * and the plugin can fall back to its `secrets.dsn`-shaped contract.
   */
  externalConnectionResolver?: {
    resolve(args: {
      slug: string;
      tenantId?: string;
      environmentId?: string;
    }): Promise<
      | {
          id: string;
          slug: string;
          kind: string;
          secret?: string;
          options: Record<string, unknown>;
          cascadeReason: "global" | "tenant" | "environment";
        }
      | undefined
    >;
  };
  /**
   * Sync nested-pipeline invocation (Phase 9, Round 2). When wired,
   * the `pipeline_call` plugin (and any other v2 plugin that wants
   * to compose) can reach for `input.runPipelineByRef`. Only the
   * synchronous API path populates this; the worker leaves it unset
   * because batch jobs can't synchronously await another batch job.
   */
  runPipelineByRef?: (args: {
    slug: string;
    input: unknown;
    environment?: string;
  }) => Promise<{ output: Record<string, unknown> }>;
  /**
   * Optional token sink for streaming LLM nodes. The executor invokes
   * this with each token a streaming-capable plugin emits, plus the
   * node id so the SSE route can label which node produced the
   * stream. Wired only when /stream's generator constructs the
   * executor; /invoke leaves it unset.
   */
  onToken?: (event: { nodeId: string; token: string }) => void;
  /**
   * Optional per-step result sink (ADR-0037). The executor invokes this with
   * each streamed step frame — from a node that opted in via `node.stream`,
   * or from a plugin calling `ctx.emit(...)`. Mirrors {@link onToken}: the
   * synchronous `/stream` route wires this to push SSE frames directly, while
   * the worker leaves it unset and relies on `store.recordStep` +
   * `PublishingExecutionStore` (change bus) instead. Frames are already
   * redacted + sequenced when they reach here. */
  onStep?: (frame: ExecutionStepRecord) => void;
  /** Execution-lifecycle interceptors (ADR 0036). Unset → no interception. */
  lifecycle?: ExecutionLifecycleHooks;
  maxRetries?: number;
  redactNodePayloads?: boolean;
  tracer?: Tracer;
}

// Process-wide pipeline metrics — initialized lazily so the runtime package
// stays import-safe in offline/test paths where no meter is wired (NoopMeter
// returned by getMeter() makes the counter/histogram calls cheap no-ops).
// Per-node labels: plugin_id, plugin_category, status. tenant_id / execution_id
// belong on traces, NOT metrics — adding them blows up Prometheus cardinality.
let pipelineNodeDuration: ReturnType<ReturnType<typeof getMeter>["histogram"]> | undefined;
let pipelineNodeFailures: ReturnType<ReturnType<typeof getMeter>["counter"]> | undefined;
function ensurePipelineMetrics(): void {
  if (pipelineNodeDuration && pipelineNodeFailures) return;
  const meter = getMeter();
  pipelineNodeDuration = meter.histogram("ragdoll_pipeline_node_duration_ms", {
    description: "Per-node (plugin) execution latency inside a pipeline run."
  });
  pipelineNodeFailures = meter.counter("ragdoll_pipeline_node_failures_total", {
    description: "Pipeline node failures, labeled by plugin and failure kind.",
    unit: "{failure}"
  });
}

export class DagExecutor {
  private options: DagExecutorOptions;
  private tracer: Tracer;
  /** ADR-0023: per-run map of pipeline-level binding declarations. Set
   *  by runDag at start of execute; consumed by executeNode to resolve
   *  `node.binding: <id>` references. Empty when the spec has no
   *  bindings block (legacy specs). */
  private currentBindings: Map<string, { dataset?: string; connection?: string }> =
    new Map();
  /** ADR-0037: monotonic per-execution step sequence, so a client can order
   *  streamed frames deterministically even though the DAG runs branches in
   *  parallel. Keyed by executionId; cleared when execute() returns. */
  private stepSeq: Map<string, number> = new Map();

  constructor(options: DagExecutorOptions) {
    this.options = options;
    this.tracer = options.tracer ?? new NoopTracer();
    ensurePipelineMetrics();
  }

  async execute(args: {
    spec: PipelineSpec;
    context: RuntimeContext;
    input: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const validation = validatePipelineSpec(args.spec, this.options.pluginRegistry);
    if (!validation.valid) throw new Error(`Pipeline validation failed: ${validation.errors.map((issue) => issue.message).join("; ")}`);

    const startedAt = new Date().toISOString();
    const execution: ExecutionRecord = {
      executionId: args.context.executionId,
      tenantId: args.context.tenantId,
      pipelineId: args.context.pipelineId,
      pipelineVersionId: args.context.pipelineVersionId,
      environment: args.context.environment,
      status: "running",
      startedAt,
      input: this.redact(args.input),
      parentExecutionId: args.context.parentExecutionId ?? null
    };
    await this.options.store.start({ ...execution, actorId: args.context.actor?.id ?? null });

    const span = this.tracer.startSpan("pipeline.execute", runtimeAttributes(args.context));
    // A deny path completes the execution as `denied` then throws; the catch
    // must NOT then overwrite it with `failed` (denied is terminal + must not
    // trigger retries — see tests/security/rbac-audit). This flag guards that.
    let terminalRecorded = false;
    try {
      this.checkAborted(args.context);
      // Defense-in-depth permission check at executor entry. The worker
      // attaches `principalAuthorize` when it has both an authorizer wired
      // and an `enqueuedBy` block on the job — a denial here means the
      // enqueuer lost `pipeline:run` between enqueue and dequeue. We mark
      // the execution `denied` (not `failed`, so retry semantics don't
      // fire) and bail before running any nodes.
      if (args.context.principalAuthorize) {
        const allowed = args.context.principalAuthorize("pipeline:run", {
          tenantId: args.context.tenantId,
          pipelineId: args.context.pipelineId,
          environment: args.context.environment
        });
        if (!allowed) {
          await this.options.store.complete({
            ...execution,
            actorId: args.context.actor?.id ?? null,
            status: "denied",
            completedAt: new Date().toISOString(),
            error: "principal no longer holds pipeline:run for this scope"
          });
          terminalRecorded = true;
          throw new Error("execution denied: principal lacks pipeline:run");
        }
      }
      // ADR 0036 execution.start (pre): a platform plugin may veto the run
      // (→ denied, before any node/compute) or rewrite the input.
      let runInput = args.input;
      if (this.options.lifecycle?.onStart) {
        const res = await this.options.lifecycle.onStart({
          context: args.context,
          input: runInput
        });
        if (res?.deny) {
          await this.options.store.complete({
            ...execution,
            actorId: args.context.actor?.id ?? null,
            status: "denied",
            completedAt: new Date().toISOString(),
            error: `denied by platform plugin: ${res.deny.reason}`
          });
          terminalRecorded = true;
          throw new Error(`execution denied by platform plugin: ${res.deny.reason}`);
        }
        if (res?.input) runInput = res.input;
      }
      const { output, summary } = await this.runDag(args.spec, args.context, runInput);
      // Surface a non-fatal warning when the pipeline "succeeded" but every
      // non-root node skipped (i.e. the root produced an empty bag and every
      // downstream got dead inputs). Today the UX lies about this — the run
      // shows green. The summary lives in the output bag under
      // `__ragdollSummary__` so any execution viewer surfaces it without
      // a schema change, and a structured log line lets operators grep for
      // no-work runs. Future: promote to a dedicated `executions.summary`
      // column once the UI layer cares.
      const enrichedOutput =
        summary.nodesSkipped > 0
          ? { ...output, __ragdollSummary__: summary }
          : output;
      if (summary.noWorkDone) {
        // Structured warning, not error — pipeline did not throw. The fields
        // match what the future UI badge would render: "0 of 7 nodes worked".
        // eslint-disable-next-line no-console
        console.warn(
          JSON.stringify({
            level: "warn",
            message: "pipeline.no_work_done",
            executionId: args.context.executionId,
            pipelineId: args.context.pipelineId,
            nodesTotal: summary.nodesTotal,
            nodesCompleted: summary.nodesCompleted,
            nodesSkipped: summary.nodesSkipped,
            reason: summary.reason,
            timestamp: new Date().toISOString()
          })
        );
      }
      // ADR 0036 execution.finish (pre): a platform plugin may rewrite the
      // output or force-fail an otherwise-successful run (compliance/redaction)
      // before the terminal status is committed.
      let finalOutput = enrichedOutput;
      if (this.options.lifecycle?.onFinish) {
        const res = await this.options.lifecycle.onFinish({
          context: args.context,
          output: finalOutput
        });
        if (res?.fail) {
          // Throw → the catch below records status `failed`.
          throw new Error(
            `execution force-failed by platform plugin: ${res.fail.reason}`
          );
        }
        if (res?.output) finalOutput = res.output;
      }
      await this.options.store.complete({
        ...execution,
        actorId: args.context.actor?.id ?? null,
        status: "succeeded",
        completedAt: new Date().toISOString(),
        output: this.redact(finalOutput)
      });
      return finalOutput;
    } catch (error) {
      span.recordException(error);
      span.setAttribute("error", true);
      span.setAttribute("error.message", error instanceof Error ? error.message : String(error));
      if (!terminalRecorded) {
        await this.options.store.complete({
          ...execution,
          actorId: args.context.actor?.id ?? null,
          status: isAbortError(error) ? "cancelled" : "failed",
          completedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error)
        });
      }
      throw error;
    } finally {
      span.end();
      this.stepSeq.delete(args.context.executionId);
    }
  }

  /**
   * Emit one streamed step frame (ADR-0037): assign a monotonic seq + frameId,
   * redact the body, persist it via `store.recordStep`, and hand it to the
   * `onStep` sink. Best-effort on every side — a streaming failure MUST NOT
   * fail or slow the run, so both the persist and the sink swallow errors.
   */
  private async emitStep(
    context: RuntimeContext,
    args: {
      nodeId: string;
      channel: string;
      source: "node_output" | "emit";
      data: Record<string, unknown>;
    }
  ): Promise<void> {
    // Nothing observes step frames on this run — skip the work entirely.
    if (!this.options.onStep && !this.options.store.recordStep) return;
    const seq = (this.stepSeq.get(context.executionId) ?? 0) + 1;
    this.stepSeq.set(context.executionId, seq);
    const redacted = this.redact(args.data);
    const frame: ExecutionStepRecord = {
      frameId: randomUUID(),
      executionId: context.executionId,
      nodeId: args.nodeId,
      channel: args.channel || args.nodeId,
      source: args.source,
      seq,
      at: new Date().toISOString(),
      data:
        redacted && typeof redacted === "object" && !Array.isArray(redacted)
          ? (redacted as Record<string, unknown>)
          : { value: redacted }
    };
    try {
      await this.options.store.recordStep?.(frame);
    } catch {
      /* persistence is best-effort; streaming must never break the run */
    }
    try {
      this.options.onStep?.(frame);
    } catch {
      /* sink errors are non-fatal */
    }
  }

  /**
   * Throws {@link DeadlineExceededError} if the deadline has passed, or
   * {@link CancelledError} if the abort signal is already aborted. Deadline is
   * checked first so an expired deadline is reported as such.
   */
  private checkAborted(context: RuntimeContext): void {
    if (context.deadline && Date.now() > context.deadline.getTime()) {
      throw new DeadlineExceededError(
        `Execution deadline exceeded at ${context.deadline.toISOString()}`
      );
    }
    if (context.signal?.aborted) {
      const reason = (context.signal as AbortSignal & { reason?: unknown }).reason;
      throw new CancelledError(
        reason instanceof Error ? reason.message : reason ? String(reason) : "Execution cancelled"
      );
    }
  }

  /**
   * Public entrypoint plugins use to recursively execute a body spec
   * (for/foreach/while). Shares the parent's secret provider, plugin registry,
   * and observability tracer; allocates a fresh execution id under the same
   * tenant/pipeline so any sub-execution rows in the store don't collide.
   */
  async runSubgraph(args: {
    spec: PipelineSpec;
    context: RuntimeContext;
    input: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    // No store.start/complete wrapper here — a subgraph is part of its parent
    // execution, not a separately surfaced run. Node-level records still write
    // because runDag drives executeNode which calls store.startNode/completeNode.
    // The summary is parent-level concern; sub-executions discard theirs.
    const { output } = await this.runDag(args.spec, args.context, args.input);
    return output;
  }

  private async runDag(
    spec: PipelineSpec,
    context: RuntimeContext,
    initialInput: Record<string, unknown>
  ): Promise<{ output: Record<string, unknown>; summary: RuntimeExecutionSummary }> {
    // ADR-0023: pre-resolve the pipeline-level `bindings:` block so
    // executeNode can resolve `node.binding: <id>` references via a
    // single Map lookup. Each entry is exactly-one-of {dataset,
    // connection}. The shape is identical to what a node would have
    // declared inline.
    const bindingMap = new Map<
      string,
      { dataset?: string; connection?: string }
    >();
    for (const decl of spec.spec.bindings ?? []) {
      if (!decl.id) continue;
      bindingMap.set(decl.id, {
        dataset: decl.dataset,
        connection: decl.connection
      });
    }
    this.currentBindings = bindingMap;

    const nodes = new Map(spec.spec.nodes.map((node) => [node.id, node]));
    const incoming = new Map<string, PipelineEdge[]>();
    const outgoing = new Map<string, PipelineEdge[]>();
    for (const edge of spec.spec.edges) {
      incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
      outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
    }

    const ready = spec.spec.nodes.filter((node) => (incoming.get(node.id) ?? []).length === 0).map((node) => node.id);
    const completed = new Set<string>();
    const skipped = new Set<string>();
    const outputs = new Map<string, Record<string, unknown>>();
    const resolved = (nodeId: string) => completed.has(nodeId) || skipped.has(nodeId);

    // Drain the ready queue in concurrent batches. Every node that becomes
    // ready in a given iteration runs in parallel (Promise.all). After the
    // batch settles, we look at each completed/skipped node's outgoing
    // edges to find newly-ready downstreams and queue them for the next
    // batch. Two independent branches off a shared root therefore overlap
    // in wall-clock time; converging nodes wait for the slowest upstream
    // because they only become ready once ALL incoming edges resolve.
    while (ready.length > 0) {
      const batch = [...ready];
      ready.length = 0;

      await Promise.all(
        batch.map(async (nodeId) => {
          const node = nodes.get(nodeId)!;
          const incomingEdges = incoming.get(nodeId) ?? [];

          // Skip decision: a node skips if every incoming edge is dead
          // (source skipped or its `fromPort` emitted undefined). Root
          // nodes always run because they have no incoming edges.
          let skip = false;
          if (incomingEdges.length > 0) {
            const liveEdges = incomingEdges.filter((edge) => this.isEdgeLive(edge, outputs, skipped));
            if (liveEdges.length === 0) skip = true;
          }

          if (skip) {
            await this.markSkipped(context, node);
            skipped.add(nodeId);
          } else {
            const effectiveInput = this.buildNodeInputs(nodeId, incomingEdges, outputs, initialInput);
            this.checkAborted(context);
            const nodeOutput = await this.executeNode(context, node, effectiveInput);
            outputs.set(nodeId, nodeOutput.outputs);
            completed.add(nodeId);
          }
        })
      );

      // Re-fill the ready queue from the batch we just settled. A
      // downstream node enters ready iff every one of its upstreams is
      // resolved (completed OR skipped) AND it hasn't been seen yet.
      for (const nodeId of batch) {
        for (const edge of outgoing.get(nodeId) ?? []) {
          const next = edge.to;
          if (resolved(next) || ready.includes(next)) continue;
          if ((incoming.get(next) ?? []).every((upstream) => resolved(upstream.from))) {
            ready.push(next);
          }
        }
      }
    }

    // Build the summary BEFORE picking terminal output so the same logic
    // applies to all return paths below. A run "did no work" iff every
    // non-source node skipped (the only completed nodes were root nodes
    // with no incoming edges — typically `input` / `fs` / etc.). This is
    // the "succeeded but did nothing" case: pipeline didn't throw, the
    // source produced empty, downstream had nothing to do.
    const nonRootCompleted = [...completed].filter(
      (id) => (incoming.get(id) ?? []).length > 0
    ).length;
    const summary: RuntimeExecutionSummary = {
      nodesTotal: spec.spec.nodes.length,
      nodesCompleted: completed.size,
      nodesSkipped: skipped.size,
      noWorkDone: completed.size > 0 && nonRootCompleted === 0 && skipped.size > 0,
      ...(completed.size > 0 && nonRootCompleted === 0 && skipped.size > 0
        ? { reason: "all_downstream_skipped" }
        : {})
    };

    // Pick terminal output: explicit `output` node wins; otherwise fall back to
    // the last declared node. Both paths defer to the sole live upstream when
    // present, so an `if_then` that picked the `then` branch returns that
    // branch's terminal payload (the `else` upstream is skipped and ignored).
    const pickOutput = (): Record<string, unknown> => {
      const outputNode = spec.spec.nodes.find((node) => node.type === "output");
      if (outputNode) {
        if (skipped.has(outputNode.id)) return {};
        const liveIncoming = (incoming.get(outputNode.id) ?? []).filter((edge) =>
          this.isEdgeLive(edge, outputs, skipped)
        );
        if (liveIncoming.length > 0) return outputs.get(liveIncoming[0].from) ?? {};
        return outputs.get(outputNode.id) ?? {};
      }
      for (let i = spec.spec.nodes.length - 1; i >= 0; i -= 1) {
        const candidate = spec.spec.nodes[i];
        if (completed.has(candidate.id)) return outputs.get(candidate.id) ?? {};
      }
      return {};
    };
    return { output: pickOutput(), summary };
  }

  /**
   * An edge is "live" when its source ran (not skipped) AND, if the edge has a
   * declared `fromPort`, the source actually emitted a value on that port. An
   * edge without a `fromPort` is live as long as the source ran — that's the
   * back-compat path for plugins that haven't declared output ports yet.
   */
  private isEdgeLive(
    edge: PipelineEdge,
    outputs: Map<string, Record<string, unknown>>,
    skipped: Set<string>
  ): boolean {
    if (skipped.has(edge.from)) return false;
    const sourceOutputs = outputs.get(edge.from);
    if (!sourceOutputs) return false;
    if (!edge.fromPort) return true;
    return sourceOutputs[edge.fromPort] !== undefined;
  }

  /**
   * Three-layer input bag:
   *   1. Flat-merged upstream outputs at root — fixes the historical
   *      `inputs.documents` footgun where downstream plugins hardcoded the
   *      upstream node id.
   *   2. Per-source-node wrapper (`inputs[sourceNodeId]`) — preserves any
   *      existing reads like `inputs.retrieve.documents`.
   *   3. Port-wired values (`inputs[toPort]`) — explicit named wiring wins
   *      over both layers below it.
   * Root nodes (no incoming edges) receive `initialInput` directly so the
   * pipeline-level input shape is unchanged.
   */
  private buildNodeInputs(
    _nodeId: string,
    incomingEdges: PipelineEdge[],
    outputs: Map<string, Record<string, unknown>>,
    initialInput: Record<string, unknown>
  ): Record<string, unknown> {
    if (incomingEdges.length === 0) return initialInput;
    const result: Record<string, unknown> = {};
    for (const edge of incomingEdges) {
      const sourceOutputs = outputs.get(edge.from);
      if (!sourceOutputs) continue;
      // Layer 1: flat merge (skip when the source has a fromPort declared —
      // that's an explicit slot, not bulk output).
      if (!edge.fromPort) {
        for (const [key, value] of Object.entries(sourceOutputs)) {
          if (value !== undefined) result[key] = value;
        }
      }
      // Layer 2: per-source wrapper.
      result[edge.from] = sourceOutputs;
      // Layer 3: port wiring overrides both layers above when explicit.
      if (edge.fromPort && edge.toPort) {
        const portValue = sourceOutputs[edge.fromPort];
        if (portValue !== undefined) result[edge.toPort] = portValue;
      } else if (edge.fromPort && !edge.toPort) {
        // Source-side only — surface the named slot at root under its source name.
        const portValue = sourceOutputs[edge.fromPort];
        if (portValue !== undefined) result[edge.fromPort] = portValue;
      } else if (!edge.fromPort && edge.toPort) {
        // Target-side only — wrap the source's whole output bag under toPort.
        result[edge.toPort] = sourceOutputs;
      }
    }
    return result;
  }

  private async markSkipped(context: RuntimeContext, node: PipelineNode): Promise<void> {
    const ts = new Date().toISOString();
    await this.options.store.startNode({
      executionId: context.executionId,
      nodeId: node.id,
      status: "skipped",
      startedAt: ts
    });
    await this.options.store.completeNode({
      executionId: context.executionId,
      nodeId: node.id,
      status: "skipped",
      startedAt: ts,
      completedAt: ts,
      latencyMs: 0
    });
  }

  private async executeNode(context: RuntimeContext, node: PipelineNode, inputs: Record<string, unknown>): Promise<PluginExecutionOutput> {
    const started = performance.now();
    const startedAt = new Date().toISOString();
    const span = this.tracer.startSpan(`node.${node.id}`, {
      "node.id": node.id,
      "node.type": node.type ?? (node.plugin ? "plugin" : "unknown"),
      "plugin.id": node.plugin?.id,
      "plugin.category": node.plugin?.category,
      "plugin.version": node.plugin?.version,
      "tenant.id": context.tenantId,
      "execution.id": context.executionId
    });
    await this.options.store.startNode({
      executionId: context.executionId,
      nodeId: node.id,
      status: "running",
      startedAt,
      input: this.redact(inputs)
    });

    try {
      let output: PluginExecutionOutput;
      if (node.type === "input") {
        // Input nodes echo whatever's in their input bag (the run-time
        // payload for root inputs). When `node.config.default` is set,
        // those values fill in any missing keys — so a demo pipeline can
        // ship a sensible default payload that's used when "Run All"
        // fires with no body, while still letting a real POST /run with
        // a body override per-key. Without this, demos like
        // transform-demo / xml-codec-demo no-op on Run All because their
        // root input bag is empty and the whole DAG skip-cascades.
        const rawDefault = node.config?.default;
        const defaults =
          rawDefault && typeof rawDefault === "object" && !Array.isArray(rawDefault)
            ? (rawDefault as Record<string, unknown>)
            : {};
        output = { outputs: { ...defaults, ...inputs } };
      } else if (node.type === "output") {
        output = { outputs: inputs };
      } else if (node.plugin) {
        const plugin = this.options.pluginRegistry.require(node.plugin);
        const ingestStateStore: IngestStateStore | undefined = this.options.ingestStateRepository
          ? {
              // Auto-scope every call by the executing tenant + pipeline so a
              // plugin can never accidentally read another tenant's state.
              list: (args) =>
                this.options.ingestStateRepository!.list({
                  tenantId: context.tenantId,
                  pipelineId: context.pipelineId,
                  stateKey: args.stateKey
                }),
              replaceAll: (args) =>
                this.options.ingestStateRepository!.replaceAll({
                  tenantId: context.tenantId,
                  pipelineId: context.pipelineId,
                  stateKey: args.stateKey,
                  entries: args.entries
                })
            }
          : undefined;
        // ADR-0023: `node.binding: <id>` wins over inline `node.dataset`
        // / `node.connection` when set. Look up the pipeline-level
        // declaration; the result is either a dataset slug or a
        // connection slug (decl shape enforces exactly one). The
        // existing dataset / connection resolution paths below then
        // operate on the resolved slug.
        let effectiveDatasetRef: DatasetRef | undefined = node.dataset as DatasetRef | undefined;
        let effectiveConnectionSlug: string | undefined = (
          node as { connection?: { slug: string } }
        ).connection?.slug;
        if (node.binding) {
          const decl = this.currentBindings.get(node.binding);
          if (decl?.dataset) {
            effectiveDatasetRef = { slug: decl.dataset };
            effectiveConnectionSlug = undefined;
          } else if (decl?.connection) {
            effectiveConnectionSlug = decl.connection;
            effectiveDatasetRef = undefined;
          }
        }
        // Phase 5: resolve the optional dataset ref, then either pass it
        // through to v2 plugins or shim collection names into v1 config.
        // Failed resolution falls through with a logged warning rather
        // than aborting — keeps pre-Phase-5 behaviour when the dataset
        // refactor hasn't reached this pipeline yet.
        const resolved =
          effectiveDatasetRef && this.options.datasetResolver
            ? await this.options.datasetResolver
                .resolve({
                  ref: effectiveDatasetRef,
                  tenantId: context.tenantId,
                  environmentId: context.environment,
                  // PR3: the resolver consults pipeline_dataset_bindings
                  // first when pipelineId is set, so an operator's per-
                  // (pipeline, tenant, env) override wins over the
                  // default scope cascade.
                  pipelineId: context.pipelineId
                })
                .catch((err) => {
                  // A dataset that EXISTS but was never cut into a version is
                  // a real misconfiguration — surface it accurately instead
                  // of letting a downstream sink mislabel the empty dataset
                  // as a missing binding.
                  if (err instanceof DatasetNotBuiltError) throw err;
                  // Every OTHER resolution failure keeps the pre-Phase-5
                  // tolerance (fall through with the dataset unresolved so
                  // config-as-source still works) — but LOG it. A silently
                  // swallowed resolver error (e.g. a bad env/connection lookup)
                  // used to surface only as a misleading downstream
                  // "requires a <X> binding" error at the sink, which made it
                  // very hard to diagnose.
                  // eslint-disable-next-line no-console
                  console.warn(
                    JSON.stringify({
                      level: "warn",
                      message: "dataset.resolution_failed",
                      executionId: context.executionId,
                      pipelineId: context.pipelineId,
                      nodeId: node.id,
                      datasetSlug: effectiveDatasetRef?.slug,
                      error: err instanceof Error ? err.message : String(err)
                    })
                  );
                  return undefined;
                })
            : undefined;
        // ADR-0021 + ADR-0023: resolve a connection slug (from
        // `node.connection.slug`, OR the pipeline-level binding map) to
        // a ResolvedExternalConnection. `connection:use` is enforced
        // here via the principal's authorize closure when wired —
        // defense in depth on top of the validator's compile-time check.
        const resolvedConn =
          effectiveConnectionSlug && this.options.externalConnectionResolver
            ? await this.options.externalConnectionResolver
                .resolve({
                  slug: effectiveConnectionSlug,
                  tenantId: context.tenantId,
                  environmentId: context.environment
                })
                .catch(() => undefined)
            : undefined;
        if (resolvedConn && context.principalAuthorize) {
          const allowed = context.principalAuthorize("connection:use", {
            tenantId: context.tenantId,
            environment: context.environment
          });
          if (!allowed) {
            throw new Error(
              `node ${node.id}: principal lacks connection:use for connection "${resolvedConn.slug}"`
            );
          }
        }
        const baseConfig = resolveNodeTemplateValues(node.config ?? {}, context);
        const effectiveConfig = applyDatasetShim(
          plugin.manifest.contract ?? 1,
          baseConfig,
          resolved
        );
        output = await withRetries(
          async () => {
            this.checkAborted(context);
            return executeRegisteredPlugin(plugin, {
              context,
              node: {
                id: node.id,
                plugin: node.plugin!,
                config: node.config,
                secrets: node.secrets,
                dataset: node.dataset as DatasetRef | undefined
              },
              inputs,
              config: effectiveConfig,
              secrets: await this.resolveNodeSecrets(
                node.secrets ?? {},
                context,
                resolved
              ),
              runSubgraph: (subSpec, subInput) =>
                this.runSubgraph({ spec: subSpec, context, input: subInput }),
              ingestStateStore,
              dataset:
                (plugin.manifest.contract ?? 1) === 2 ? resolved : undefined,
              connection:
                (plugin.manifest.contract ?? 1) === 2 ? resolvedConn : undefined,
              runPipelineByRef: this.options.runPipelineByRef,
              onToken: this.options.onToken
                ? (token) =>
                    this.options.onToken!({ nodeId: node.id, token })
                : undefined,
              // ADR-0037: let a plugin push intermediate results to the live
              // stream mid-run (e.g. stream the primary doc as soon as it's
              // found, before the node returns). Fire-and-forget — a plugin
              // must never await or be blocked by streaming.
              emit:
                this.options.onStep || this.options.store.recordStep
                  ? (channel, data) => {
                      void this.emitStep(context, {
                        nodeId: node.id,
                        channel,
                        source: "emit",
                        data: data ?? {}
                      });
                    }
                  : undefined
            });
          },
          this.options.maxRetries ?? 1,
          (error) => !isAbortError(error)
        );
      } else {
        throw new Error(`Node ${node.id} has no executable type or plugin`);
      }

      const latencyMs = performance.now() - started;
      span.setAttribute("node.latency_ms", latencyMs);
      pipelineNodeDuration?.record(latencyMs, {
        plugin_id: node.plugin?.id ?? node.type ?? "unknown",
        plugin_category: node.plugin?.category ?? "builtin",
        status: "succeeded"
      });
      await this.options.store.completeNode({
        executionId: context.executionId,
        nodeId: node.id,
        status: "succeeded",
        startedAt,
        completedAt: new Date().toISOString(),
        latencyMs,
        output: this.redact(output.outputs)
      });
      if (output.usage) {
        await this.options.store.recordUsage({
          tenantId: context.tenantId,
          pipelineId: context.pipelineId,
          executionId: context.executionId,
          provider: output.usage.provider,
          model: output.usage.model,
          inputTokens: output.usage.inputTokens,
          outputTokens: output.usage.outputTokens,
          embeddingTokens: output.usage.embeddingTokens,
          estimatedCostUsd: output.usage.estimatedCostUsd,
          latencyMs,
          success: true
        });
      }
      // ADR-0037: declarative streaming — a node marked `stream: true` pushes
      // its redacted output to the live execution stream the moment it
      // completes, tagged with `streamAs` (or the node id). This is the
      // "step 3 finds the primary doc → stream it now" path.
      const streamable = node as { stream?: boolean; streamAs?: string };
      if (streamable.stream) {
        await this.emitStep(context, {
          nodeId: node.id,
          channel: streamable.streamAs ?? node.id,
          source: "node_output",
          data: output.outputs
        });
      }
      return output;
    } catch (error) {
      span.recordException(error);
      span.setAttribute("error", true);
      span.setAttribute("error.message", error instanceof Error ? error.message : String(error));
      const latencyMs = performance.now() - started;
      const failureKind = isAbortError(error) ? "cancelled" : "failed";
      pipelineNodeDuration?.record(latencyMs, {
        plugin_id: node.plugin?.id ?? node.type ?? "unknown",
        plugin_category: node.plugin?.category ?? "builtin",
        status: failureKind
      });
      pipelineNodeFailures?.add(1, {
        plugin_id: node.plugin?.id ?? node.type ?? "unknown",
        plugin_category: node.plugin?.category ?? "builtin",
        error_type: error instanceof Error ? error.name : "Error"
      });
      await this.options.store.completeNode({
        executionId: context.executionId,
        nodeId: node.id,
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        latencyMs,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      span.end();
    }
  }

  private async resolveNodeSecrets(
    secrets: Record<string, SecretRef>,
    context: RuntimeContext,
    dataset?: ResolvedDataset
  ): Promise<Record<string, string>> {
    const resolved: Record<string, string> = {};
    for (const [name, ref] of Object.entries(secrets)) {
      resolved[name] = await this.options.secretProvider.get(ref, context.tenantId);
    }
    // Connection auto-resolve (ADR-0023): when a dataset binding's
    // resolved connection points at a secret via the unified registry,
    // the resolved secret gets spliced into the plugin's secrets map
    // under the well-known key `__connection_<bindingName>__`. Plugins
    // read it via input.secrets["__connection_vectors__"] (etc) without
    // duplicating the secret block in their pipeline spec. The binding
    // NAME is the key — same vocabulary the plugin declares in
    // `requires: [{binding, kind}]`.
    //
    // Existing keys are NOT overridden — a plugin that explicitly
    // declares a `secrets:` entry still wins.
    if (dataset?.bindings) {
      for (const [bindingName, binding] of Object.entries(dataset.bindings)) {
        const conn = binding.connection;
        if (!conn || conn.secret !== undefined) continue;
        // The ResolvedExternalConnection's id IS the secret key in the
        // tenant's secret store (the unified registry uses connection
        // id as the secret ref). Skip when no id — defensive.
        const key = `__connection_${bindingName}__`;
        if (key in resolved) continue;
        try {
          resolved[key] = await this.options.secretProvider.get(
            { scope: "tenant", tenantId: context.tenantId, key: conn.id },
            context.tenantId
          );
        } catch {
          // Don't fail the whole node because a connection secret
          // didn't resolve — the plugin may not need it. Plugins that
          // DO need it will throw on their own when the key is absent.
        }
      }
    }
    return resolved;
  }

  private redact(value: unknown): unknown {
    return this.options.redactNodePayloads === false ? value : redactValue(value);
  }
}

export function resolveNodeTemplateValues(config: Record<string, unknown>, context: RuntimeContext): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, resolveTemplate(value, context)]));
}

/**
 * v1↔v2 compatibility shim. v1 plugins read `config.collection` /
 * `config.index` directly. When a pipeline carries `node.dataset` AND
 * the resolver returns a ResolvedDataset, splice the binding's
 * collection name into the config under the legacy key the plugin
 * expects so it Just Works. A name already present in config is NEVER
 * overridden — explicit names win during a migration.
 *
 * ADR-0023: the shim now reads from `bindings` (the only shape
 * post-migration). The two well-known binding names "vectors" and
 * "text" feed the legacy `config.collection` and `config.index` slots
 * that every v1 storage plugin reads.
 *
 * v2 plugins ignore `config.collection` / `config.index`; they reach
 * for `input.dataset.bindings[<name>]` instead. They still receive
 * their original config for plugin-specific knobs.
 */
export function applyDatasetShim(
  contract: 1 | 2,
  config: Record<string, unknown>,
  resolved: ResolvedDataset | undefined
): Record<string, unknown> {
  if (!resolved) return config;
  if (contract === 2) return config;
  const next = { ...config };
  const vec =
    resolved.bindings?.vectors?.collection ??
    resolved.bindings?.vector?.collection;
  const kw =
    resolved.bindings?.text?.collection ??
    resolved.bindings?.keyword?.collection;
  if (vec && next.collection === undefined) next.collection = vec;
  if (kw && next.index === undefined) next.index = kw;
  return next;
}

function resolveTemplate(value: unknown, context: RuntimeContext): unknown {
  if (typeof value === "string") {
    const configMatch = value.match(/^\$\{config\.([^}]+)\}$/);
    if (configMatch) return context.resolvedConfig.values[configMatch[1]]?.value;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplate(item, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, resolveTemplate(nested, context)]));
  }
  return value;
}

async function withRetries<T>(
  operation: () => Promise<T>,
  retries: number,
  shouldRetry: (error: unknown) => boolean = () => true
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error)) throw error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

// Re-export the shared DatasetResolver builder so callers in apps/api
// + apps/worker don't each need to duplicate the slug / connection /
// binding cascade. See dataset-resolver.ts for the canonical impl.
export {
  buildDatasetResolver,
  DatasetNotBuiltError,
  type DatasetResolverDeps
} from "./dataset-resolver.ts";

// Namespace-policy helpers (PR6). The resolver applies the policy
// internally; the API validates write-time, so direct callers usually
// don't need these — they're exported for tests + plugin authors who
// want to display the effective collection name without re-resolving.
export {
  applyNamespacePolicy,
  validateNamespacePolicyForScope,
  sanitiseForCollectionSuffix,
  type DatasetScope,
  type ApplyNamespacePolicyArgs,
  type NamespaceValidationResult
} from "./dataset-namespace.ts";
