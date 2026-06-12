/**
 * Sync-pipeline LLM glue: three short, bounded provider calls that
 * compose the chat-style retrieval pipelines from natural-language
 * input to formatted answer.
 *
 *   - `query_classify` maps a free-form question to structured args
 *     (often the `params` array a `postgres_query` node will bind),
 *     plus a confidence score so the pipeline can branch to a
 *     vector-search fallback when the classifier isn't sure.
 *
 *   - `summarize_event` takes a set of structured rows + their source
 *     documents and produces a formatted structured summary (e.g.
 *     cause / timeline / resolution) via one provider call. Generic
 *     over summary schema.
 *
 *   - `action_status_refresh` looks at each candidate action item,
 *     pulls its surrounding thread (via a lookup the operator wires
 *     in), and asks the model whether a later message resolved it.
 *     Bounded concurrency so a flurry of items doesn't melt the
 *     provider on the hot path.
 *
 * All three are designed for synchronous pipelines: single bounded
 * call (or N bounded calls with concurrency caps) per invocation,
 * cheap default models. Ollama cold-start can be slow — pipelines
 * that need predictable hot-path latency should rely on the existing
 * warm-model heartbeat.
 */

import type { InProcessPlugin } from "../../../../packages/plugin-sdk/src/index.ts";
import { buildProviderRegistry, chatStructured, resolveChatModel } from "../helpers.ts";

const PROVIDER_ENUM = ["openai", "anthropic", "ollama"];
const PROVIDER_SECRETS_SCHEMA = {
  type: "object",
  properties: {
    apiKey: { type: "string", format: "secret-ref", description: "Provider API key (when required)." }
  },
  additionalProperties: false
};

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<U>
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) || 1 }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// query_classify
// ---------------------------------------------------------------------------

export const queryClassifyPlugin: InProcessPlugin = {
  manifest: {
    id: "query_classify",
    name: "Query Classify",
    version: "1.0.0",
    category: "transformer",
    description:
      "Maps a natural-language question to structured args matching a config-supplied schema, plus a confidence score. Emits a `lowConfidence` flag so the pipeline can branch to a fallback retrieval path.",
    configSchema: {
      type: "object",
      required: ["targetSchema"],
      properties: {
        provider: { type: "string", enum: PROVIDER_ENUM, default: "ollama" },
        model: { type: "string", default: "llama3.1" },
        targetSchema: {
          type: "object",
          description:
            "JSON-schema-like shape the model must emit for `args`. The plugin wraps it as `{ args, confidence }`."
        },
        systemPrompt: {
          type: "string",
          default:
            "You classify a user question into structured arguments for a downstream tool. Be conservative: when in doubt, lower the confidence score.",
          description: "System prompt prefixed to the classification call."
        },
        confidenceThreshold: {
          type: "number",
          default: 0.6,
          description: "Below this, `lowConfidence` is set true so the pipeline can branch."
        },
        questionField: {
          type: "string",
          default: "question",
          description: "Name of the input field holding the user question."
        },
        maxTokens: { type: "integer", default: 512 }
      },
      additionalProperties: false
    },
    secretsSchema: PROVIDER_SECRETS_SCHEMA,
    inputPorts: [
      { name: "question", required: true, description: "Free-text user question." }
    ],
    outputPorts: [
      { name: "args", description: "Structured arguments matching `config.targetSchema`." },
      { name: "confidence", description: "Model-reported confidence score in [0, 1]." },
      { name: "lowConfidence", description: "True when confidence < `confidenceThreshold`." },
      { name: "raw", description: "Raw model response text (useful for debugging the prompt)." }
    ],
    capabilities: ["transform", "llm", "synchronous"],
    ui: {
      icon: "compass",
      color: "#f97316",
      formHints: {
        provider: { widget: "select" },
        systemPrompt: { widget: "textarea", rows: 4 },
        targetSchema: { widget: "json" },
        confidenceThreshold: { widget: "range", min: 0, max: 1, step: 0.05 }
      }
    }
  },
  async execute(input) {
    const { inputs, config, secrets, context } = input;
    const questionField = String(config.questionField ?? "question");
    const question = String(inputs[questionField] ?? inputs.question ?? inputs.text ?? "");
    if (!question) throw new Error("query_classify: empty question on input.");
    const schema = config.targetSchema;
    if (!schema || typeof schema !== "object") {
      throw new Error("query_classify: `config.targetSchema` is required.");
    }
    const providers = buildProviderRegistry();
    const { providerId, model, baseUrl } = resolveChatModel({
      config,
      resolvedValues: context.resolvedConfig.values
    });
    const wrappedSchema = {
      type: "object",
      required: ["args", "confidence"],
      properties: {
        args: schema,
        confidence: { type: "number", description: "0 = not sure at all, 1 = certain." }
      }
    };
    const threshold = Number(config.confidenceThreshold ?? 0.6);
    const result = await chatStructured({
      providers,
      tenantId: context.tenantId,
      providerId,
      model,
      baseUrl,
      apiKey: secrets.apiKey,
      systemPrompt: String(config.systemPrompt ?? ""),
      userPrompt: question,
      schema: wrappedSchema,
      maxTokens: Number(config.maxTokens ?? 512),
      temperature: 0.1,
      retry: 1
    });
    const parsed = (result.parsed ?? {}) as { args?: unknown; confidence?: unknown };
    const args = parsed.args ?? {};
    const confidence = clamp01(Number(parsed.confidence ?? 0));
    return {
      outputs: {
        args,
        confidence,
        lowConfidence: confidence < threshold,
        raw: result.raw
      },
      usage: { provider: providerId, model }
    };
  }
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ---------------------------------------------------------------------------
// summarize_event
// ---------------------------------------------------------------------------

export const summarizeEventPlugin: InProcessPlugin = {
  manifest: {
    id: "summarize_event",
    name: "Summarize Event",
    version: "1.0.0",
    category: "transformer",
    description:
      "Given structured rows + their source documents, produces a formatted structured summary (e.g. cause / timeline / resolution) via one provider call. Generic over the summary schema.",
    configSchema: {
      type: "object",
      required: ["summarySchema"],
      properties: {
        provider: { type: "string", enum: PROVIDER_ENUM, default: "ollama" },
        model: { type: "string", default: "llama3.1" },
        summarySchema: {
          type: "object",
          description: "JSON-schema-like shape the model must emit for each summary."
        },
        promptTemplate: {
          type: "string",
          default:
            "Summarise the event below. Use the provided rows as structured facts and the documents as supporting context. Return ONE JSON object matching the supplied schema.\n\nRows:\n{{rows}}\n\nDocuments:\n{{documents}}",
          description: "Template with {{rows}} / {{documents}} placeholders."
        },
        systemPrompt: {
          type: "string",
          default:
            "You produce concise structured summaries of operational events. Cite only what's in the provided rows + documents; do not speculate."
        },
        groupByField: {
          type: "string",
          description:
            "When set, rows are grouped by this field and the plugin emits one summary per group (still bounded by maxConcurrency)."
        },
        maxConcurrency: { type: "integer", default: 2 },
        maxTokens: { type: "integer", default: 1024 }
      },
      additionalProperties: false
    },
    secretsSchema: PROVIDER_SECRETS_SCHEMA,
    inputPorts: [
      { name: "rows", required: true, description: "Structured fact rows (e.g. from a postgres_query)." },
      { name: "documents", description: "Optional supporting documents to include in the prompt." }
    ],
    outputPorts: [
      { name: "summaries", description: "Array of structured summaries (one if no groupByField, N if grouped)." }
    ],
    capabilities: ["transform", "llm", "synchronous"],
    ui: {
      icon: "file-text",
      color: "#f97316",
      formHints: {
        provider: { widget: "select" },
        systemPrompt: { widget: "textarea", rows: 4 },
        promptTemplate: { widget: "textarea", rows: 6 },
        summarySchema: { widget: "json" },
        maxConcurrency: { widget: "number", min: 1, step: 1 }
      }
    }
  },
  async execute(input) {
    const { inputs, config, secrets, context } = input;
    const rows = inputs.rows;
    if (!Array.isArray(rows)) throw new Error("summarize_event: `inputs.rows` must be an array.");
    const documents = Array.isArray(inputs.documents) ? inputs.documents : [];
    const schema = config.summarySchema;
    if (!schema || typeof schema !== "object") {
      throw new Error("summarize_event: `config.summarySchema` is required.");
    }
    const template = String(config.promptTemplate ?? "");
    const groupBy = config.groupByField ? String(config.groupByField) : undefined;
    const providers = buildProviderRegistry();
    const { providerId, model, baseUrl } = resolveChatModel({
      config,
      resolvedValues: context.resolvedConfig.values
    });

    const groups: Array<{ key: string; rows: Array<Record<string, unknown>> }> = groupBy
      ? groupRowsBy(rows as Array<Record<string, unknown>>, groupBy)
      : [{ key: "all", rows: rows as Array<Record<string, unknown>> }];

    const summaries = await mapWithConcurrency(
      groups,
      Math.max(1, Number(config.maxConcurrency ?? 2)),
      async (group) => {
        const userPrompt = template
          .split("{{rows}}")
          .join(JSON.stringify(group.rows, null, 2))
          .split("{{documents}}")
          .join(JSON.stringify(documents, null, 2));
        const result = await chatStructured({
          providers,
          tenantId: context.tenantId,
          providerId,
          model,
          baseUrl,
          apiKey: secrets.apiKey,
          systemPrompt: String(config.systemPrompt ?? ""),
          userPrompt,
          schema: schema as Record<string, unknown>,
          maxTokens: Number(config.maxTokens ?? 1024),
          temperature: 0.2,
          retry: 1
        });
        return groupBy ? { groupKey: group.key, ...((result.parsed ?? {}) as object) } : result.parsed;
      }
    );

    return {
      outputs: { summaries },
      usage: { provider: providerId, model }
    };
  }
};

function groupRowsBy(rows: Array<Record<string, unknown>>, field: string): Array<{ key: string; rows: Array<Record<string, unknown>> }> {
  const buckets = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const k = String(row[field] ?? "");
    const arr = buckets.get(k) ?? [];
    arr.push(row);
    buckets.set(k, arr);
  }
  return [...buckets.entries()].map(([key, rows]) => ({ key, rows }));
}

// ---------------------------------------------------------------------------
// action_status_refresh
// ---------------------------------------------------------------------------

export const actionStatusRefreshPlugin: InProcessPlugin = {
  manifest: {
    id: "action_status_refresh",
    name: "Action Status Refresh",
    version: "1.0.0",
    category: "transformer",
    description:
      "For each candidate action item, retrieves the surrounding thread (via the configured `threadField` on the input) and asks the model whether a later message resolved it. Bounded concurrency so a flurry of items doesn't melt the provider.",
    configSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: PROVIDER_ENUM, default: "ollama" },
        model: { type: "string", default: "llama3.1" },
        itemField: {
          type: "string",
          default: "item",
          description: "Field on each input record holding the action-item text."
        },
        threadField: {
          type: "string",
          default: "thread",
          description: "Field on each input record holding the subsequent thread text (already retrieved upstream)."
        },
        statusField: {
          type: "string",
          default: "status",
          description: "Field name written onto each output record carrying the resolved status."
        },
        systemPrompt: {
          type: "string",
          default:
            "You read an action item and the subsequent thread, and decide whether the item has been resolved, is still open, was cancelled, or is blocked. Return only the JSON the schema specifies."
        },
        maxConcurrency: { type: "integer", default: 4 },
        maxTokens: { type: "integer", default: 256 }
      },
      additionalProperties: false
    },
    secretsSchema: PROVIDER_SECRETS_SCHEMA,
    inputPorts: [
      {
        name: "records",
        required: true,
        description: "Candidate action-item records. Each must carry the configured `itemField` + `threadField`."
      }
    ],
    outputPorts: [
      { name: "records", description: "Same records with the configured `statusField` populated." },
      { name: "updated", description: "Count of records whose status changed from their original value." }
    ],
    capabilities: ["transform", "llm", "synchronous"],
    ui: {
      icon: "check-circle",
      color: "#f97316",
      formHints: {
        provider: { widget: "select" },
        systemPrompt: { widget: "textarea", rows: 4 },
        maxConcurrency: { widget: "number", min: 1, step: 1 }
      }
    }
  },
  async execute(input) {
    const { inputs, config, secrets, context } = input;
    const records = inputs.records ?? inputs.rows;
    if (!Array.isArray(records)) {
      throw new Error("action_status_refresh: `inputs.records` must be an array.");
    }
    const itemField = String(config.itemField ?? "item");
    const threadField = String(config.threadField ?? "thread");
    const statusField = String(config.statusField ?? "status");
    const providers = buildProviderRegistry();
    const { providerId, model, baseUrl } = resolveChatModel({
      config,
      resolvedValues: context.resolvedConfig.values
    });
    const concurrency = Math.max(1, Number(config.maxConcurrency ?? 4));
    const schema = {
      type: "object",
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["open", "resolved", "cancelled", "blocked"] },
        evidence: { type: "string", description: "Short quote or paraphrase from the thread supporting the verdict." }
      }
    };

    let updated = 0;
    const out = await mapWithConcurrency(records as Array<Record<string, unknown>>, concurrency, async (record) => {
      const item = String(record[itemField] ?? "");
      const thread = String(record[threadField] ?? "");
      if (!item || !thread) return { ...record };
      try {
        const result = await chatStructured({
          providers,
          tenantId: context.tenantId,
          providerId,
          model,
          baseUrl,
          apiKey: secrets.apiKey,
          systemPrompt: String(config.systemPrompt ?? ""),
          userPrompt: `Action item:\n${item}\n\nSubsequent thread:\n${thread}`,
          schema,
          maxTokens: Number(config.maxTokens ?? 256),
          temperature: 0.1,
          retry: 1
        });
        const parsed = (result.parsed ?? {}) as { status?: string; evidence?: string };
        const newStatus = parsed.status ?? "open";
        if (record[statusField] !== newStatus) updated += 1;
        return { ...record, [statusField]: newStatus, statusEvidence: parsed.evidence };
      } catch {
        // Preserve the original record on failure; downstream can retry.
        return { ...record };
      }
    });

    return {
      outputs: { records: out, updated },
      usage: { provider: providerId, model }
    };
  }
};
