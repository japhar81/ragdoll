/**
 * Control-flow plugins: branching (`if_then`) and three loop shapes
 * (`for_loop`, `for_each`, `while_loop`). Each plugin invokes the
 * runtime-provided `runSubgraph` callback, so they're not usable in
 * the external-plugin transport — only in-process executors.
 */
import type { InProcessPlugin } from "../../../../packages/plugin-sdk/src/index.ts";
import type { PipelineSpec } from "../../../../packages/core/src/index.ts";

/**
 * Wrap a raw loop-body input (either a `{ nodes, edges }` bag or a
 * complete `PipelineSpec`) in a uniform PipelineSpec the runtime can
 * validate + execute. Used by every loop plugin in this file.
 */
function normaliseBodySpec(raw: unknown, label: string): PipelineSpec {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const inner = (body.spec && typeof body.spec === "object" ? body.spec : body) as Record<string, unknown>;
  const nodes = Array.isArray(inner.nodes) ? inner.nodes : [];
  const edges = Array.isArray(inner.edges) ? inner.edges : [];
  const parameters = Array.isArray(inner.parameters) ? inner.parameters : undefined;
  return {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: label, description: `Iteration body for ${label}` },
    spec: {
      nodes: nodes as PipelineSpec["spec"]["nodes"],
      edges: edges as PipelineSpec["spec"]["edges"],
      ...(parameters ? { parameters: parameters as PipelineSpec["spec"]["parameters"] } : {})
    }
  };
}

/**
 * Evaluate an if_then predicate over `inputs.value`. `mode = "truthy"` (the
 * default) treats any non-empty / non-zero / non-false value as the `then`
 * branch. `mode = "equals"` compares `inputs.value` to `config.equals` via
 * `===` (with simple JSON-equality for arrays/objects). `mode = "defined"`
 * fires `then` when `inputs.value !== undefined`.
 */
function evaluateIfPredicate(inputs: Record<string, unknown>, config: Record<string, unknown>): boolean {
  const mode = String(config.mode ?? "truthy");
  const value = inputs.value;
  if (mode === "defined") return value !== undefined && value !== null;
  if (mode === "equals") {
    const target = (config as { equals?: unknown }).equals;
    if (value === target) return true;
    try {
      return JSON.stringify(value) === JSON.stringify(target);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

export const ifThenPlugin: InProcessPlugin = {
  manifest: {
    id: "if_then",
    name: "If / Then",
    version: "1.0.0",
    category: "control",
    description:
      "Routes the input payload to either the `then` or `else` output port based on a predicate. Downstream nodes wired to the unselected port are skipped by the runtime.",
    configSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["truthy", "equals", "defined"],
          default: "truthy",
          description:
            "Predicate mode. `truthy` (default) tests Boolean(inputs.value); `equals` compares against config.equals; `defined` checks for non-null/undefined."
        },
        equals: {
          description: "When mode = equals, the value to compare inputs.value against."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "value", required: true, description: "Value the predicate is evaluated against." },
      { name: "payload", description: "Optional payload to forward on the selected branch. Defaults to inputs.value." }
    ],
    outputPorts: [
      { name: "then", description: "Live when the predicate is true; carries the payload." },
      { name: "else", description: "Live when the predicate is false; carries the payload." }
    ],
    capabilities: ["query", "ingestion"],
    ui: {
      icon: "git-branch",
      formHints: {
        mode: { widget: "select" },
        equals: { widget: "json" }
      }
    }
  },
  async execute({ inputs, config }) {
    const branch = evaluateIfPredicate(inputs, config);
    const payload = inputs.payload !== undefined ? inputs.payload : inputs.value;
    return {
      outputs: branch ? { then: payload } : { else: payload },
      metadata: { branch: branch ? "then" : "else", mode: String(config.mode ?? "truthy") }
    };
  }
};

export const forLoopPlugin: InProcessPlugin = {
  manifest: {
    id: "for_loop",
    name: "For Loop",
    version: "1.0.0",
    category: "control",
    description:
      "Runs the configured body subgraph N times. Each iteration receives `{ index, total }` plus the upstream inputs, and the body's terminal output is collected into the `results` port.",
    configSchema: {
      type: "object",
      required: ["body"],
      properties: {
        count: {
          type: "integer",
          default: 1,
          description: "Number of iterations. Falls back to `inputs.count` when unset."
        },
        body: {
          type: "object",
          description: "Pipeline body executed each iteration. Stored as { nodes, edges }."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "count", description: "Override iteration count from upstream." }
    ],
    outputPorts: [
      { name: "results", description: "Array of body outputs, one per iteration." },
      { name: "final", description: "Final iteration's output (same as results[results.length - 1])." }
    ],
    capabilities: ["query", "ingestion"],
    ui: { icon: "repeat", formHints: { body: { widget: "json" } } }
  },
  async execute({ inputs, config, runSubgraph }) {
    if (!runSubgraph) throw new Error("for_loop: runtime did not provide runSubgraph (external plugin transport not supported)");
    const total = Number(inputs.count ?? config.count ?? 1) | 0;
    if (total < 0) throw new Error(`for_loop: count must be >= 0, got ${total}`);
    const body = normaliseBodySpec(config.body, "for_loop body");
    const results: unknown[] = [];
    for (let index = 0; index < total; index += 1) {
      const result = await runSubgraph(body, { ...inputs, index, total });
      results.push(result);
    }
    return { outputs: { results, final: results.at(-1) } };
  }
};

export const forEachPlugin: InProcessPlugin = {
  manifest: {
    id: "foreach",
    name: "ForEach",
    version: "1.0.0",
    category: "control",
    description:
      "Runs the configured body subgraph once per item in `inputs.items`. Each iteration receives `{ item, index, total }` plus upstream inputs; outputs are gathered into `results`.",
    configSchema: {
      type: "object",
      required: ["body"],
      properties: {
        body: {
          type: "object",
          description: "Pipeline body executed for each item. Stored as { nodes, edges }."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "items", required: true, description: "Array to iterate. Each element becomes the body's `item` input." }
    ],
    outputPorts: [
      { name: "results", description: "Array of body outputs in input order." }
    ],
    capabilities: ["query", "ingestion"],
    ui: { icon: "list", formHints: { body: { widget: "json" } } }
  },
  async execute({ inputs, config, runSubgraph }) {
    if (!runSubgraph) throw new Error("foreach: runtime did not provide runSubgraph");
    const items = (inputs.items as unknown[] | undefined) ?? [];
    if (!Array.isArray(items)) throw new Error(`foreach: inputs.items must be an array, got ${typeof items}`);
    const body = normaliseBodySpec(config.body, "foreach body");
    const results: unknown[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const result = await runSubgraph(body, { ...inputs, item: items[index], index, total: items.length });
      results.push(result);
    }
    return { outputs: { results } };
  }
};

export const whileLoopPlugin: InProcessPlugin = {
  manifest: {
    id: "while_loop",
    name: "While Loop",
    version: "1.0.0",
    category: "control",
    description:
      "Runs the configured body subgraph until the predicate is false. The body's output is fed back as the next iteration's state under `state`. Bounded by `maxIterations` to prevent runaway loops.",
    configSchema: {
      type: "object",
      required: ["body"],
      properties: {
        mode: {
          type: "string",
          enum: ["truthy", "defined"],
          default: "truthy",
          description: "Predicate mode applied to the body's `continue` output (or `state` when absent)."
        },
        maxIterations: {
          type: "integer",
          default: 100,
          description: "Hard ceiling on iterations regardless of predicate."
        },
        body: {
          type: "object",
          description: "Pipeline body executed each iteration. Should emit `state` and optionally `continue`."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "state", description: "Initial state passed to the first iteration as `state`." }
    ],
    outputPorts: [
      { name: "final", description: "Final body output when the predicate ends the loop." },
      { name: "iterations", description: "Number of body iterations executed." }
    ],
    capabilities: ["query", "ingestion"],
    ui: { icon: "rotate-cw", formHints: { body: { widget: "json" } } }
  },
  async execute({ inputs, config, runSubgraph }) {
    if (!runSubgraph) throw new Error("while_loop: runtime did not provide runSubgraph");
    const maxIterations = Number(config.maxIterations ?? 100) | 0;
    if (maxIterations <= 0) throw new Error("while_loop: maxIterations must be > 0");
    const mode = String(config.mode ?? "truthy");
    const body = normaliseBodySpec(config.body, "while_loop body");
    let state: unknown = inputs.state;
    let last: Record<string, unknown> = {};
    let iterations = 0;
    while (iterations < maxIterations) {
      last = await runSubgraph(body, { ...inputs, state, iteration: iterations });
      iterations += 1;
      const cont = last.continue !== undefined ? last.continue : last.state;
      const keepGoing = mode === "defined" ? cont !== undefined && cont !== null : Boolean(cont);
      state = last.state !== undefined ? last.state : last;
      if (!keepGoing) break;
    }
    return { outputs: { final: last, iterations } };
  }
};
