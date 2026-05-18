import { performance } from "node:perf_hooks";
import type { PipelineNode, PipelineSpec, RuntimeContext, SecretRef, UsageRecord } from "../../core/src/index.ts";
import { redactValue } from "../../core/src/index.ts";
import type { SecretProvider } from "../../secrets/src/index.ts";
import {
  executeRegisteredPlugin,
  type PluginExecutionOutput,
  type PluginRegistry
} from "../../plugin-sdk/src/index.ts";
import { validatePipelineSpec } from "../../pipeline-spec/src/index.ts";
import type { SpanHandle, Tracer } from "../../observability/src/index.ts";
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

  private async runDag(spec: PipelineSpec, context: RuntimeContext, initialInput: Record<string, unknown>): Promise<Record<string, unknown>> {
    const nodes = new Map(spec.spec.nodes.map((node) => [node.id, node]));
    const incoming = new Map<string, string[]>();
    const outgoing = new Map<string, string[]>();
    for (const edge of spec.spec.edges) {
      incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
      outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    }

    const ready = spec.spec.nodes.filter((node) => (incoming.get(node.id) ?? []).length === 0).map((node) => node.id);
    const completed = new Set<string>();
    const outputs = new Map<string, Record<string, unknown>>();

    while (ready.length > 0) {
      const nodeId = ready.shift()!;
      const node = nodes.get(nodeId)!;
      const nodeInputs = Object.fromEntries((incoming.get(nodeId) ?? []).map((source) => [source, outputs.get(source)]));
      const effectiveInput = Object.keys(nodeInputs).length === 0 ? initialInput : nodeInputs;
      this.checkAborted(context);
      const nodeOutput = await this.executeNode(context, node, effectiveInput);
      outputs.set(nodeId, nodeOutput.outputs);
      completed.add(nodeId);
      for (const next of outgoing.get(nodeId) ?? []) {
        if ((incoming.get(next) ?? []).every((source) => completed.has(source))) {
          ready.push(next);
        }
      }
    }

    if (completed.size !== spec.spec.nodes.length) {
      throw new Error("Pipeline execution did not complete all nodes");
    }

    const outputNode = spec.spec.nodes.find((node) => node.type === "output");
    if (outputNode) {
      const source = incoming.get(outputNode.id)?.[0];
      return source ? outputs.get(source) ?? {} : outputs.get(outputNode.id) ?? {};
    }
    const last = spec.spec.nodes.at(-1);
    return last ? outputs.get(last.id) ?? {} : {};
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
              secrets: await this.resolveNodeSecrets(node.secrets ?? {}, context)
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
