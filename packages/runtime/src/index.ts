import { performance } from "node:perf_hooks";
import type { PipelineEdge, PipelineNode, PipelineSpec, RuntimeContext, SecretRef, UsageRecord } from "../../core/src/index.ts";
import { redactValue } from "../../core/src/index.ts";
import type { SecretProvider } from "../../secrets/src/index.ts";
import {
  executeRegisteredPlugin,
  type PluginExecutionOutput,
  type PluginRegistry
} from "../../plugin-sdk/src/index.ts";
import { validatePipelineSpec } from "../../pipeline-spec/src/index.ts";
import type { Tracer } from "../../observability/src/index.ts";
import { NoopTracer, runtimeAttributes } from "../../observability/src/index.ts";

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
  status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
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

export interface ExecutionStore {
  start(record: ExecutionRecord): Promise<void>;
  complete(record: ExecutionRecord): Promise<void>;
  startNode(record: ExecutionNodeRecord): Promise<void>;
  completeNode(record: ExecutionNodeRecord): Promise<void>;
  recordUsage(record: UsageRecord): Promise<void>;
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
}

export interface DagExecutorOptions {
  pluginRegistry: PluginRegistry;
  secretProvider: SecretProvider;
  store: ExecutionStore;
  maxRetries?: number;
  redactNodePayloads?: boolean;
  tracer?: Tracer;
}

export class DagExecutor {
  private options: DagExecutorOptions;
  private tracer: Tracer;

  constructor(options: DagExecutorOptions) {
    this.options = options;
    this.tracer = options.tracer ?? new NoopTracer();
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
      status: "running",
      startedAt,
      input: this.redact(args.input)
    };
    await this.options.store.start(execution);

    const span = this.tracer.startSpan("pipeline.execute", runtimeAttributes(args.context));
    try {
      this.checkAborted(args.context);
      const output = await this.runDag(args.spec, args.context, args.input);
      await this.options.store.complete({
        ...execution,
        status: "succeeded",
        completedAt: new Date().toISOString(),
        output: this.redact(output)
      });
      return output;
    } catch (error) {
      span.recordException(error);
      span.setAttribute("error", true);
      span.setAttribute("error.message", error instanceof Error ? error.message : String(error));
      await this.options.store.complete({
        ...execution,
        status: isAbortError(error) ? "cancelled" : "failed",
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      span.end();
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
    return this.runDag(args.spec, args.context, args.input);
  }

  private async runDag(spec: PipelineSpec, context: RuntimeContext, initialInput: Record<string, unknown>): Promise<Record<string, unknown>> {
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

    while (ready.length > 0) {
      const nodeId = ready.shift()!;
      const node = nodes.get(nodeId)!;
      const incomingEdges = incoming.get(nodeId) ?? [];

      // Skip decision: a node skips if every upstream source is skipped, OR
      // every incoming edge with a declared fromPort received undefined on that
      // port. Root nodes (no incoming) always run.
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

      for (const edge of outgoing.get(nodeId) ?? []) {
        const next = edge.to;
        if ((incoming.get(next) ?? []).every((upstream) => resolved(upstream.from))) {
          if (!ready.includes(next) && !resolved(next)) ready.push(next);
        }
      }
    }

    // Pick terminal output: explicit `output` node wins; otherwise fall back to
    // the last declared node. Both paths defer to the sole live upstream when
    // present, so an `if_then` that picked the `then` branch returns that
    // branch's terminal payload (the `else` upstream is skipped and ignored).
    const outputNode = spec.spec.nodes.find((node) => node.type === "output");
    if (outputNode) {
      if (skipped.has(outputNode.id)) return {};
      const liveIncoming = (incoming.get(outputNode.id) ?? []).filter((edge) => this.isEdgeLive(edge, outputs, skipped));
      if (liveIncoming.length > 0) return outputs.get(liveIncoming[0].from) ?? {};
      return outputs.get(outputNode.id) ?? {};
    }
    for (let i = spec.spec.nodes.length - 1; i >= 0; i -= 1) {
      const candidate = spec.spec.nodes[i];
      if (completed.has(candidate.id)) return outputs.get(candidate.id) ?? {};
    }
    return {};
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
        output = { outputs: inputs };
      } else if (node.type === "output") {
        output = { outputs: inputs };
      } else if (node.plugin) {
        const plugin = this.options.pluginRegistry.require(node.plugin);
        output = await withRetries(
          async () => {
            this.checkAborted(context);
            return executeRegisteredPlugin(plugin, {
              context,
              node: { id: node.id, plugin: node.plugin!, config: node.config, secrets: node.secrets },
              inputs,
              config: resolveNodeTemplateValues(node.config ?? {}, context),
              secrets: await this.resolveNodeSecrets(node.secrets ?? {}, context),
              runSubgraph: (subSpec, subInput) =>
                this.runSubgraph({ spec: subSpec, context, input: subInput })
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
      return output;
    } catch (error) {
      span.recordException(error);
      span.setAttribute("error", true);
      span.setAttribute("error.message", error instanceof Error ? error.message : String(error));
      await this.options.store.completeNode({
        executionId: context.executionId,
        nodeId: node.id,
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        latencyMs: performance.now() - started,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      span.end();
    }
  }

  private async resolveNodeSecrets(secrets: Record<string, SecretRef>, context: RuntimeContext): Promise<Record<string, string>> {
    const resolved: Record<string, string> = {};
    for (const [name, ref] of Object.entries(secrets)) {
      resolved[name] = await this.options.secretProvider.get(ref, context.tenantId);
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
