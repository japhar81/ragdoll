import { createHash } from "node:crypto";
import type { InProcessPlugin } from "../../../packages/plugin-sdk/src/index.ts";
import {
  pickBackendName,
  pickBackendUrl,
  requireBackendConnection
} from "./dataset-binding.ts";
import type { PipelineSpec } from "../../../packages/core/src/index.ts";
import { OpenAIProvider, AnthropicProvider, OllamaCompatibleProvider, ProviderRegistry } from "../../../packages/providers/src/index.ts";

/**
 * Derive a deterministic v5-style UUID from an arbitrary key. Qdrant point
 * ids are valid only as UUIDs or unsigned 64-bit ints — chunk fallbacks
 * like `${executionId}_${index}` (with embedded dashes followed by
 * non-hex tails) fail validation with `Bad Request`. Hashing the natural
 * key `${docId}::${chunkIndex}` keeps incremental upserts replacing the
 * same point instead of creating new ones on every run.
 */
function deterministicUuid(key: string): string {
  const hex = createHash("sha1").update(key).digest("hex");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20, 32)
  );
}

// Codebase + docs ingest plugins live in their own module to keep this file
// from sprawling further. Re-exported so the plugin-loader's namespace scan
// picks them up alongside everything else.
export {
  filesystemSourcePlugin,
  jsonlSourcePlugin,
  deltaFilterPlugin,
  codeChunkerPlugin,
  qdrantDeletePlugin,
  opensearchDeletePlugin,
  pathClassifierPlugin,
  enrichQdrantError
} from "./ingest.ts";
import { enrichQdrantError } from "./ingest.ts";
import { validateAgainstSchema } from "./schema-validate.ts";
// GitHub datasource — emits one document per file in a repo tree at a
// given ref. Mirrors filesystem_source's output shape so the rest of
// the ingest path (delta_filter, code_chunker, …) works unchanged.
export { githubSourcePlugin } from "./github.ts";
// Dgraph plugins for the `graph` modality. Sink + retriever, both
// contract: 2 and declare datasetModalities: ["graph"] so the
// Builder picker filters to graph-enabled datasets.
export { dgraphUpsertPlugin, dgraphQueryPlugin, dgraphDeletePlugin } from "./dgraph.ts";
// Neo4j family (ADR-0025) — sibling to dgraph, fills the "graph" binding
// for property-graph use cases. `neo4jConnectionDriver` is the ADR-0024
// connection-driver plugin the loader scan picks up; `neo4j_query` +
// `neo4j_write` consume it via the dataset's `graph` binding.
export {
  neo4jConnectionDriver,
  neo4jQueryPlugin,
  neo4jWritePlugin
} from "./neo4j.ts";
// cartography_crawl (ADR-0025) — third crawler block beside crawl4ai +
// scrapy. The handler runs in the python-plugins sidecar (where the
// `cartography` Python dep is installed); this file only exports the
// manifest so the plugin-loader's registerExternalPlugins() pass can
// wire it to `process.env.PYTHON_PLUGIN_URL`.
export { cartographyCrawlManifest, CARTOGRAPHY_MODULES } from "./cartography.ts";
export type { CartographyModule } from "./cartography.ts";
// Wazuh (Phase 2b) — connection driver + host/agent layer pull blocks.
// Driver owns JWT auth + refresh + verifyTls; the two pull plugins
// (registry + per-agent syscollector) are leaf record-sources bulwark
// composes around. NO mapping / observation / OCSF concepts here.
export {
  wazuhConnectionDriver,
  wazuhAgentsPullPlugin,
  wazuhSyscollectorPullPlugin,
  // Phase C1 (ADR-0031): per-agent CVE evidence + the Phase 5.2
  // wazuh-freshness provenance contract (pullId/pulledAt) bulwark gates
  // windowed close-by-absence on.
  wazuhVulnsPullPlugin,
  // Posture READ — agent → group memberships + active-response section
  // + group config + manager-wide rule-group inventory. Promotes
  // bulwark's Wazuh control from inferred-from-enrollment ("agent
  // exists, therefore covered") to read-from-config (detect vs block
  // visible; fidelity reported honestly per agent).
  wazuhRulesetPullPlugin
} from "./wazuh.ts";
// http_source (Phase C1 / ADR-0032) — generic URL → document fetch.
// The cleaner primitive when github_source's repo-tree shape is overkill;
// powers the ATT&CK / D3FEND reference-ETL pattern (compose with
// transform + delta_filter + neo4j_write to import versioned ontologies
// on a slow cron).
export { httpSourcePlugin } from "./http-source.ts";

// k8s (Phase 3b) — connection driver + completeness-aware list-pull.
// The `scan.complete` flag emitted per resource kind is the headline
// signal — bulwark's append-only diff keys off it to decide whether
// absences may close edges. RAGdoll does NO diff / resolution /
// retention here.
export { k8sConnectionDriver, k8sListPullPlugin } from "./k8s.ts";
// Data-shaping plugins (JSONata/JMESPath transform + XML codec) live in their
// own module; re-exported so the plugin-loader's namespace scan registers
// them alongside the rest.
export { transformPlugin, xmlCodecPlugin } from "./transform.ts";
// Phase 9 retrieval plugin set. v2-native, dataset-aware.
export {
  datasetSearchPlugin,
  datasetUpsertPlugin,
  datasetDeletePlugin,
  queryHydePlugin,
  queryFanoutPlugin,
  mergeRrfPlugin,
  rerankLlmPlugin,
  rerankBgePlugin,
  pipelineCallPlugin,
  conversationRewritePlugin,
  topicShiftDetectPlugin
} from "./retrieval-v2.ts";
import { createVectorStore } from "../../../packages/vector/src/index.ts";
import type { DistanceMetric, VectorPoint } from "../../../packages/vector/src/index.ts";
// OpenSearch wiring + the 5 OpenSearch plugins live in ./plugins/opensearch.ts now.
// Provider-registry + embed-texts helpers live in ./helpers.ts so
// sibling plugin modules can reuse the same wiring.
import { buildProviderRegistry, embedTexts } from "./helpers.ts";

export const manualTextInputPlugin: InProcessPlugin = {
  manifest: {
    id: "manual_text_input",
    name: "Manual Text Input",
    version: "1.0.0",
    category: "datasource",
    description: "Passes runtime text input into the pipeline.",
    configSchema: {
      type: "object",
      description: "Manual input has no configuration; text is supplied at runtime.",
      properties: {},
      additionalProperties: false
    },
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    outputPorts: [
      { name: "text", description: "Raw text supplied at execution time." },
      { name: "question", description: "Question payload, when the runtime input set one." }
    ],
    capabilities: ["query", "ingestion"],
    ui: { icon: "keyboard" }
  },
  async execute({ inputs }) {
    // Emit on named ports AND preserve flat spread so legacy unported edges
    // (which use the flatten-at-root fallback) keep working unchanged.
    return { outputs: { ...inputs, text: inputs.text ?? inputs.input, question: inputs.question } };
  }
};

export const basicTextChunkerPlugin: InProcessPlugin = {
  manifest: {
    id: "basic_text_chunker",
    name: "Basic Text Chunker",
    version: "1.0.0",
    category: "chunker",
    description: "Splits text into overlapping character chunks.",
    configSchema: {
      type: "object",
      properties: {
        chunkSize: {
          type: "integer",
          default: 1000,
          description: "Maximum characters per chunk."
        },
        overlap: {
          type: "integer",
          default: 100,
          description: "Characters of overlap shared between adjacent chunks."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "documents", description: "Array of { content, path, docId? } documents to chunk individually." },
      { name: "text", description: "Single string to chunk; used when `documents` is unset (legacy)." }
    ],
    outputPorts: [
      { name: "chunks", description: "Array of { text, index, docId?, path? } chunks. When `documents` was the input, each chunk carries its source doc's docId/path so a downstream sink can keep provenance." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "scissors",
      formHints: {
        chunkSize: { widget: "number", min: 1, step: 50 },
        overlap: { widget: "number", min: 0, step: 10 }
      }
    }
  },
  async execute({ inputs, config }) {
    const chunkSize = Number(config.chunkSize ?? 1000);
    const overlap = Number(config.overlap ?? 100);
    const step = Math.max(1, chunkSize - overlap);

    /** Split one text string; tag each chunk with its source ids when given. */
    const chunkOne = (
      text: string,
      meta: { docId?: string; path?: string }
    ): Array<{ text: string; index: number; docId?: string; path?: string }> => {
      const out: Array<{ text: string; index: number; docId?: string; path?: string }> = [];
      for (let start = 0; start < text.length; start += step) {
        const chunk: { text: string; index: number; docId?: string; path?: string } = {
          text: text.slice(start, start + chunkSize),
          index: out.length
        };
        if (meta.docId !== undefined) chunk.docId = meta.docId;
        if (meta.path !== undefined) chunk.path = meta.path;
        out.push(chunk);
      }
      return out;
    };

    // Prefer the documents array (the `filesystem_source → delta_filter →
    // basic_text_chunker` path); fall back to a single-string `text` /
    // `input` for legacy callers.
    const documents = inputs.documents as
      | Array<{ content?: unknown; text?: unknown; path?: unknown; docId?: unknown }>
      | undefined;
    if (Array.isArray(documents) && documents.length > 0) {
      const chunks = documents.flatMap((doc) => {
        const text = String(doc.content ?? doc.text ?? "");
        const docId = typeof doc.docId === "string" ? doc.docId : typeof doc.path === "string" ? doc.path : undefined;
        const path = typeof doc.path === "string" ? doc.path : undefined;
        return chunkOne(text, { docId, path });
      });
      // Re-index across the flattened array so downstream nodes get a
      // single contiguous chunk stream.
      chunks.forEach((c, i) => (c.index = i));
      return { outputs: { chunks } };
    }

    const text = String(inputs.text ?? inputs.input ?? "");
    return { outputs: { chunks: chunkOne(text, {}) } };
  }
};

export const basicPromptTemplatePlugin: InProcessPlugin = {
  manifest: {
    id: "basic_rag_prompt",
    name: "Basic RAG Prompt",
    version: "1.0.0",
    category: "prompt_template",
    description: "Builds a compact RAG prompt from question and context.",
    configSchema: {
      type: "object",
      properties: {
        template: {
          type: "string",
          default: "Answer using only the context.\n\nContext:\n{{context}}\n\nQuestion: {{question}}",
          description:
            "Prompt template. {{context}} and {{question}} are substituted before sending to the model."
        },
        documentFields: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional whitelist of fields to keep on each document before it is stringified into {{context}}. Use to drop large fields the LLM doesn't need (e.g. embeddings or full bodies)."
        },
        documentBodyMaxChars: {
          type: "integer",
          description:
            "If set (and >0), truncate any string-typed field on each document to this many characters before stringification. Targets long-form fields like `body_text` to keep prompt size under the model's context window."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "question", required: true, description: "User question text the template substitutes into {{question}}." },
      { name: "documents", description: "Retrieved documents the template stringifies into {{context}}." }
    ],
    outputPorts: [
      { name: "messages", description: "Chat-style message array ready for an LLM plugin." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "file-text",
      formHints: { template: { widget: "textarea", rows: 6 } }
    }
  },
  async execute({ inputs, config }) {
    const question = String((inputs.input as any)?.question ?? inputs.question ?? "");
    const rawDocs = (inputs.documents ?? (inputs.retrieve as any)?.documents ?? []) as unknown;
    const fieldWhitelist = Array.isArray(config.documentFields)
      ? (config.documentFields as string[])
      : null;
    const bodyMax =
      typeof config.documentBodyMaxChars === "number" && config.documentBodyMaxChars > 0
        ? Math.floor(config.documentBodyMaxChars)
        : 0;
    const projected = Array.isArray(rawDocs)
      ? (rawDocs as Array<Record<string, unknown>>).map((doc) => {
          if (!doc || typeof doc !== "object") return doc;
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(doc)) {
            if (fieldWhitelist && !fieldWhitelist.includes(k)) continue;
            if (bodyMax > 0 && typeof v === "string" && v.length > bodyMax) {
              out[k] = v.slice(0, bodyMax) + "…";
            } else {
              out[k] = v;
            }
          }
          return out;
        })
      : rawDocs;
    const context = JSON.stringify(projected);
    const template = String(config.template ?? "Answer using only the context.\n\nContext:\n{{context}}\n\nQuestion: {{question}}");
    return {
      outputs: {
        messages: [
          { role: "system", content: "You are a careful RAG assistant. Cite sources when available." },
          { role: "user", content: template.replace("{{context}}", context).replace("{{question}}", question) }
        ]
      }
    };
  }
};

export const providerChatPlugin: InProcessPlugin = {
  manifest: {
    id: "provider_chat",
    name: "Provider Chat",
    version: "1.0.0",
    category: "llm",
    description: "Calls OpenAI, Anthropic, or Ollama-compatible chat provider.",
    configSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["openai", "anthropic", "ollama"],
          default: "ollama",
          description: "Chat provider adapter to call."
        },
        model: {
          type: "string",
          default: "llama3.1",
          description: "Model id passed to the provider."
        },
        temperature: {
          type: "number",
          default: 0.2,
          description: "Sampling temperature."
        },
        maxTokens: {
          type: "integer",
          default: 1024,
          description: "Maximum tokens to generate."
        },
        baseUrl: {
          type: "string",
          description: "Override the provider base URL (e.g. self-hosted Ollama)."
        }
      },
      additionalProperties: false
    },
    secretsSchema: {
      type: "object",
      properties: {
        apiKey: {
          type: "string",
          format: "secret-ref",
          description:
            "Reference to the provider API key secret. Required for hosted providers (OpenAI/Anthropic)."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "messages", required: true, description: "Chat messages array from a prompt template." }
    ],
    outputPorts: [
      { name: "text", description: "Generated response text." },
      { name: "provider", description: "Provider id that handled the call." },
      { name: "model", description: "Model id that produced the text." }
    ],
    capabilities: ["query", "streaming"],
    ui: {
      icon: "message-square",
      color: "#7c3aed",
      formHints: {
        provider: { widget: "select" },
        temperature: { widget: "range", min: 0, max: 2, step: 0.1 },
        maxTokens: { widget: "number", min: 1, step: 64 },
        apiKey: { widget: "secret" }
      }
    }
  },
  async execute(input) {
    const { inputs, config, secrets, context, onToken } = input;
    const providers = new ProviderRegistry();
    providers.register(new OpenAIProvider());
    providers.register(new AnthropicProvider());
    providers.register(new OllamaCompatibleProvider());
    const providerId = String(config.provider ?? context.resolvedConfig.values["llm.provider"]?.value ?? "ollama");
    const provider = providers.require(providerId);
    const chatArgs = {
      tenantId: context.tenantId,
      model: String(config.model ?? context.resolvedConfig.values["llm.model"]?.value ?? "llama3.1"),
      messages: (inputs.messages ?? (inputs.prompt as any)?.messages ?? []) as any,
      temperature: Number(config.temperature ?? context.resolvedConfig.values["llm.temperature"]?.value ?? 0.2),
      maxTokens: Number(config.maxTokens ?? context.resolvedConfig.values["llm.max_tokens"]?.value ?? 1024),
      apiKey: secrets.apiKey,
      baseUrl: config.baseUrl ? String(config.baseUrl) : undefined
    };
    // Phase 13 follow-up: token-by-token streaming. When the executor
    // wired an `onToken` callback (i.e. this run is happening behind
    // /stream) AND the provider supports streamChat, we stream tokens
    // out as they arrive while still returning the full text in the
    // outputs at the end. Providers without streamChat silently fall
    // through to the synchronous chat call below.
    if (onToken && provider.streamChat) {
      let collected = "";
      for await (const event of provider.streamChat(chatArgs)) {
        if (event.type === "token" && event.token) {
          collected += event.token;
          onToken(event.token);
        } else if (event.type === "error" && event.error) {
          throw new Error(event.error);
        } else if (event.type === "done") {
          break;
        }
      }
      return {
        outputs: { text: collected, provider: provider.id, model: chatArgs.model }
      };
    }
    const response = await provider.chat({
      tenantId: context.tenantId,
      model: chatArgs.model,
      messages: chatArgs.messages,
      temperature: Number(config.temperature ?? context.resolvedConfig.values["llm.temperature"]?.value ?? 0.2),
      maxTokens: Number(config.maxTokens ?? context.resolvedConfig.values["llm.max_tokens"]?.value ?? 1024),
      apiKey: secrets.apiKey,
      baseUrl: config.baseUrl ? String(config.baseUrl) : undefined
    });
    return {
      outputs: { text: response.text, provider: response.provider, model: response.model },
      usage: { provider: response.provider, model: response.model, ...response.usage }
    };
  }
};

export const jsonOutputParserPlugin: InProcessPlugin = {
  manifest: {
    id: "json_output_parser",
    name: "JSON Output Parser",
    version: "1.0.0",
    category: "output_parser",
    description: "Attempts to parse model text as JSON.",
    configSchema: {
      type: "object",
      description: "No configuration; parses upstream model text as JSON.",
      properties: {},
      additionalProperties: false
    },
    inputPorts: [
      { name: "text", required: true, description: "Model text to parse as JSON." }
    ],
    outputPorts: [
      { name: "json", description: "Parsed JSON value, or null when parsing fails." },
      { name: "raw", description: "Original text string." }
    ],
    capabilities: ["query"],
    ui: { icon: "braces" }
  },
  async execute({ inputs }) {
    const text = String((inputs.llm as any)?.text ?? inputs.text ?? "");
    try {
      return { outputs: { json: JSON.parse(text), raw: text } };
    } catch {
      return { outputs: { json: null, raw: text, parseError: true } };
    }
  }
};

export const keywordGuardrailPlugin: InProcessPlugin = {
  manifest: {
    id: "simple_keyword_guardrail",
    name: "Simple Keyword Guardrail",
    version: "1.0.0",
    category: "guardrail",
    description: "Blocks configured keywords.",
    configSchema: {
      type: "object",
      properties: {
        blockedKeywords: {
          type: "array",
          items: { type: "string" },
          default: [],
          description: "Case-insensitive keywords that cause the request to be blocked."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "text", description: "Text or message payload to scan." },
      { name: "messages", description: "Chat messages to scan (any field is stringified before scanning)." }
    ],
    outputPorts: [
      { name: "messages", description: "Original messages, forwarded when no blocked keyword fires." },
      { name: "text", description: "Original text, forwarded when no blocked keyword fires." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "shield",
      formHints: { blockedKeywords: { widget: "tags" } }
    }
  },
  async execute({ inputs, config }) {
    const text = JSON.stringify(inputs);
    const blocked = (config.blockedKeywords as string[] | undefined ?? []).find((keyword) => text.toLowerCase().includes(keyword.toLowerCase()));
    if (blocked) throw new Error(`Guardrail blocked keyword: ${blocked}`);
    // Emit the spread + named slots so both port-based and flatten-fallback
    // edges resolve correctly (downstream sees `messages`/`text` at root).
    return { outputs: { ...inputs } };
  }
};

/**
 * Real evaluator plugin (`simple_evaluator`).
 *
 * Replaces the previous `simple_evaluator_stub` that always returned
 * `{ score: 1, passed: true }` regardless of input. The new version runs
 * a configurable list of declarative assertions over the upstream output
 * and returns:
 *   - score: (passed assertions) / (total assertions), in [0..1]
 *   - passed: true iff every assertion passed (logical AND)
 *   - notes: per-assertion result list, useful in the execution viewer
 *
 * Assertion kinds:
 *   - length_min / length_max — length of the resolved field
 *   - contains / not_contains — substring match (case-insensitive)
 *   - matches               — JS regex (string `pattern`, optional `flags`)
 *   - equals / not_equals   — exact value equality (deep for objects)
 *   - has_keys              — object has all listed keys
 *
 * Field resolution: each assertion specifies `field` as a dotted path
 * (e.g. `answer.text`). Default is `answer` if unset.
 *
 * Worth shipping because the previous stub was the only "evaluator"
 * category plugin and was useless for actual scoring; downstream pipelines
 * had to drop in a custom plugin instead of using anything off-the-shelf.
 */

type EvalAssertion =
  | { kind: "length_min"; value: number; field?: string }
  | { kind: "length_max"; value: number; field?: string }
  | { kind: "contains"; value: string; field?: string; caseInsensitive?: boolean }
  | { kind: "not_contains"; value: string; field?: string; caseInsensitive?: boolean }
  | { kind: "matches"; pattern: string; flags?: string; field?: string }
  | { kind: "equals"; value: unknown; field?: string }
  | { kind: "not_equals"; value: unknown; field?: string }
  | { kind: "has_keys"; keys: string[]; field?: string };

function lookupField(bag: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".").filter(Boolean);
  let cur: unknown = bag;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (!a || !b || typeof a !== "object") return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k]
    )
  );
}

function evaluateAssertion(
  assertion: EvalAssertion,
  inputs: Record<string, unknown>
): { passed: boolean; note: string } {
  const field = assertion.field ?? "answer";
  const value = lookupField(inputs, field);
  switch (assertion.kind) {
    case "length_min": {
      const len = typeof value === "string" || Array.isArray(value) ? value.length : 0;
      return {
        passed: len >= assertion.value,
        note: `length_min(${field}): ${len} >= ${assertion.value}`
      };
    }
    case "length_max": {
      const len = typeof value === "string" || Array.isArray(value) ? value.length : 0;
      return {
        passed: len <= assertion.value,
        note: `length_max(${field}): ${len} <= ${assertion.value}`
      };
    }
    case "contains": {
      const haystack = String(value ?? "");
      const needle = assertion.caseInsensitive
        ? assertion.value.toLowerCase()
        : assertion.value;
      const hay = assertion.caseInsensitive ? haystack.toLowerCase() : haystack;
      return {
        passed: hay.includes(needle),
        note: `contains(${field}, "${assertion.value}")`
      };
    }
    case "not_contains": {
      const haystack = String(value ?? "");
      const needle = assertion.caseInsensitive
        ? assertion.value.toLowerCase()
        : assertion.value;
      const hay = assertion.caseInsensitive ? haystack.toLowerCase() : haystack;
      return {
        passed: !hay.includes(needle),
        note: `not_contains(${field}, "${assertion.value}")`
      };
    }
    case "matches": {
      try {
        const re = new RegExp(assertion.pattern, assertion.flags ?? "");
        return {
          passed: re.test(String(value ?? "")),
          note: `matches(${field}, /${assertion.pattern}/${assertion.flags ?? ""})`
        };
      } catch (e) {
        return { passed: false, note: `matches(${field}): bad regex — ${(e as Error).message}` };
      }
    }
    case "equals":
      return {
        passed: deepEqual(value, assertion.value),
        note: `equals(${field}, ${JSON.stringify(assertion.value)})`
      };
    case "not_equals":
      return {
        passed: !deepEqual(value, assertion.value),
        note: `not_equals(${field}, ${JSON.stringify(assertion.value)})`
      };
    case "has_keys": {
      if (!value || typeof value !== "object") {
        return { passed: false, note: `has_keys(${field}): not an object` };
      }
      const present = assertion.keys.every((k) => k in (value as object));
      return {
        passed: present,
        note: `has_keys(${field}, ${JSON.stringify(assertion.keys)})`
      };
    }
  }
}

export const simpleEvaluatorPlugin: InProcessPlugin = {
  manifest: {
    id: "simple_evaluator",
    name: "Simple Evaluator",
    version: "1.0.0",
    category: "evaluator",
    description:
      "Runs declarative assertions over upstream output and emits a score in [0..1]. Useful for regression-style smoke tests and golden-answer checks.",
    configSchema: {
      type: "object",
      properties: {
        assertions: {
          type: "array",
          description:
            "List of assertions to evaluate. Score = passed / total; `passed` is true iff every assertion holds.",
          items: { type: "object" }
        }
      },
      required: ["assertions"],
      additionalProperties: false
    },
    inputPorts: [
      { name: "answer", description: "Primary value to assert on (string, object, or array)." }
    ],
    outputPorts: [
      { name: "score", description: "Fraction of assertions that passed, 0..1." },
      { name: "passed", description: "True iff every assertion passed." },
      { name: "notes", description: "Per-assertion results, one string per assertion." }
    ],
    capabilities: ["evaluation"],
    ui: {
      icon: "check-circle",
      // The assertions config is a free-form JSON array; the form
      // renderer should show a JSON textarea rather than try to build a
      // dynamic per-row UI. A specialized editor can replace this later.
      formHints: { assertions: { widget: "textarea" } }
    }
  },
  async execute(input) {
    const assertions = (input.config.assertions as EvalAssertion[] | undefined) ?? [];
    if (assertions.length === 0) {
      return {
        outputs: {
          score: 1,
          passed: true,
          notes: ["no assertions configured"]
        }
      };
    }
    const results = assertions.map((a) => evaluateAssertion(a, input.inputs));
    const passedCount = results.filter((r) => r.passed).length;
    return {
      outputs: {
        score: passedCount / results.length,
        passed: passedCount === results.length,
        notes: results.map((r) => `${r.passed ? "[ok]" : "[fail]"} ${r.note}`)
      }
    };
  }
};

// Back-compat alias so existing pipelines referencing `simple_evaluator_stub`
// keep loading. The stub manifest is preserved verbatim (no behavior change
// for in-flight references); new pipelines should use `simple_evaluator`.
export const evaluatorStubPlugin: InProcessPlugin = {
  manifest: {
    id: "simple_evaluator_stub",
    name: "Simple Evaluator (deprecated alias)",
    version: "1.0.0",
    category: "evaluator",
    description:
      "DEPRECATED — kept as an alias for `simple_evaluator`. Switch new pipelines to `simple_evaluator` for declarative assertions.",
    configSchema: simpleEvaluatorPlugin.manifest.configSchema,
    inputPorts: simpleEvaluatorPlugin.manifest.inputPorts,
    outputPorts: simpleEvaluatorPlugin.manifest.outputPorts,
    capabilities: ["evaluation"],
    ui: simpleEvaluatorPlugin.manifest.ui
  },
  execute: simpleEvaluatorPlugin.execute
};

export const providerEmbeddingsPlugin: InProcessPlugin = {
  manifest: {
    id: "provider_embeddings",
    name: "Provider Embeddings",
    version: "1.0.0",
    category: "embedder",
    description: "Embeds input texts using OpenAI or Ollama-compatible embedding provider.",
    configSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["openai", "anthropic", "ollama"],
          default: "ollama",
          description: "Embedding provider adapter to call."
        },
        model: {
          type: "string",
          default: "nomic-embed-text",
          description: "Embedding model id passed to the provider."
        },
        baseUrl: {
          type: "string",
          description: "Override the provider base URL (e.g. self-hosted Ollama)."
        }
      },
      additionalProperties: false
    },
    secretsSchema: {
      type: "object",
      properties: {
        apiKey: {
          type: "string",
          format: "secret-ref",
          description:
            "Reference to the provider API key secret. Required for hosted providers."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "texts", description: "Array of strings to embed. Takes priority over `text` and `chunks`." },
      { name: "text", description: "Single string to embed when `texts` is unset." },
      { name: "chunks", description: "Array of `{ text }` chunks; their texts are embedded." }
    ],
    outputPorts: [
      { name: "vectors", description: "Embeddings, one per input text." },
      { name: "dimensions", description: "Vector dimensionality." }
    ],
    capabilities: ["ingestion", "query"],
    ui: {
      icon: "vector",
      color: "#0ea5e9",
      formHints: {
        provider: { widget: "select" },
        apiKey: { widget: "secret" }
      }
    }
  },
  async execute({ inputs, config, secrets, context }) {
    const rawTexts =
      (inputs.texts as unknown[] | undefined) ??
      (inputs.chunks as Array<{ text?: string }> | undefined)?.map((chunk) => chunk?.text ?? "") ??
      (inputs.text !== undefined ? [inputs.text] : []);
    const texts = (rawTexts as unknown[]).map((value) => String(value ?? ""));
    if (texts.length === 0) {
      return { outputs: { vectors: [], dimensions: 0 } };
    }
    const embedded = await embedTexts({
      texts,
      config,
      secrets,
      tenantId: context.tenantId,
      resolvedValues: context.resolvedConfig.values
    });
    return {
      outputs: { vectors: embedded.vectors, dimensions: embedded.dimensions },
      usage: { provider: embedded.provider, model: embedded.model, embeddingTokens: embedded.embeddingTokens }
    };
  }
};

export const qdrantRetrieverPlugin: InProcessPlugin = {
  manifest: {
    id: "qdrant_retriever",
    name: "Qdrant Retriever",
    version: "1.0.0",
    category: "retriever",
    contract: 2,
    // ADR-0023: `requires` pins binding NAME + connection KIND. The
    // Builder hides datasets without a matching binding, the spec
    // validator surfaces mismatches at edit time, and the runtime
    // hard-fails any node whose dataset doesn't resolve a `vectors`
    // binding backed by a `qdrant` connection.
    requires: [{ binding: "vectors", kind: "qdrant" }],
    description: "Queries a Qdrant vector store for the top-K most similar documents.",
    configSchema: {
      // PR1 of the requires roll-out: DSN fields (url/apiKey for cluster
      // auth) are gone — the dataset's resolved connection is the only
      // place those live now. What stays here is per-call behaviour
      // (collection name fallback, topK, filter, query embedder choice).
      type: "object",
      properties: {
        collection: {
          type: "string",
          default: "default",
          description: "Collection to query. Override per node when the dataset version's backend_collections mapping doesn't fit."
        },
        topK: {
          type: "integer",
          default: 5,
          description: "Number of nearest documents to return."
        },
        filter: {
          type: "object",
          additionalProperties: true,
          description: "Optional payload filter applied to the query."
        },
        provider: {
          type: "string",
          enum: ["openai", "anthropic", "ollama"],
          default: "ollama",
          description: "Embedding provider used to embed the query when no queryVector is supplied."
        },
        model: {
          type: "string",
          default: "nomic-embed-text",
          description: "Embedding model used to embed the query."
        }
      },
      additionalProperties: false
    },
    secretsSchema: {
      type: "object",
      properties: {
        apiKey: {
          type: "string",
          format: "secret-ref",
          description: "Reference to the embedding provider API key secret (used for query embedding)."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "question", description: "Natural-language question. Embedded on the fly when no queryVector is supplied." },
      { name: "queryVector", description: "Pre-computed embedding for the query. Skips on-the-fly embedding when present." }
    ],
    outputPorts: [
      { name: "documents", description: "Top-K nearest documents with score + payload fields." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "search",
      color: "#16a34a",
      formHints: {
        provider: { widget: "select" },
        topK: { widget: "number", min: 1, step: 1 },
        filter: { widget: "json" }
      }
    }
  },
  async execute(input) {
    const { inputs, config, secrets, context } = input;
    const { url } = requireBackendConnection(input, "vector", {
      pluginId: "qdrant_retriever",
      defaultPort: 6333
    });
    const store = createVectorStore({
      url,
      apiKey: secrets.apiKey ? String(secrets.apiKey) : undefined
    });
    const collection = String(
      pickBackendName(input, "vector") ??
        context.resolvedConfig.values["vector.collection"]?.value ??
        "default"
    );
    const topK = Number(config.topK ?? context.resolvedConfig.values["retriever.top_k"]?.value ?? 5);

    let queryVector = inputs.queryVector as number[] | undefined;
    let usage: { provider?: string; model?: string; embeddingTokens?: number } | undefined;
    if (!queryVector || queryVector.length === 0) {
      const question = String(inputs.question ?? (inputs.input as any)?.question ?? "");
      const embedded = await embedTexts({
        texts: [question],
        config,
        secrets,
        tenantId: context.tenantId,
        resolvedValues: context.resolvedConfig.values
      });
      queryVector = embedded.vectors[0] ?? [];
      usage = { provider: embedded.provider, model: embedded.model, embeddingTokens: embedded.embeddingTokens };
    }

    const results = await store.query(collection, {
      vector: queryVector,
      topK,
      filter: (config.filter as Record<string, unknown> | undefined) ?? undefined,
      tenantId: context.tenantId
    });
    const documents = results.map((result) => ({
      id: result.id,
      score: result.score,
      ...(result.payload ?? {})
    }));
    return { outputs: { documents }, ...(usage ? { usage } : {}) };
  }
};

// vector_upsert is the qdrant-specific upsert. The name is historical —
// it WOULD ideally be `qdrant_upsert` to match `qdrant_delete` /
// `qdrant_retriever`, but renaming would break every existing pipeline
// referencing it. Authors should treat `vector_upsert` as a qdrant alias.
// The opensearch equivalent is `opensearch_output`. There is no single
// modality-agnostic "vector_delete" — see the note above qdrant_delete
// in ingest.ts for why that asymmetry is intentional (deletes operate on
// different modalities, not interchangeable backends).
export const vectorUpsertPlugin: InProcessPlugin = {
  manifest: {
    id: "vector_upsert",
    name: "Vector Upsert (qdrant)",
    version: "1.0.0",
    category: "sink",
    contract: 2,
    // ADR-0023: needs a `vectors` binding backed by a qdrant connection.
    requires: [{ binding: "vectors", kind: "qdrant" }],
    description:
      "Ensures a Qdrant collection exists and upserts embedded chunks into it. Qdrant-specific despite the name; see opensearch_output for the OpenSearch sibling.",
    configSchema: {
      // PR1 of the requires roll-out: DSN fields (url/apiKey) are gone.
      // The dataset's resolved connection provides them. What stays is
      // per-call behaviour (collection name, distance metric, dim, id prefix).
      type: "object",
      properties: {
        collection: {
          type: "string",
          default: "default",
          description: "Target collection name."
        },
        distance: {
          type: "string",
          enum: ["cosine", "dot", "euclidean"],
          default: "cosine",
          description: "Distance metric used when the collection is created."
        },
        dimensions: {
          type: "integer",
          description: "Vector dimensionality. Inferred from the first vector when unset."
        },
        idPrefix: {
          type: "string",
          description: "Prefix for generated point ids. Defaults to the execution id."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "chunks", required: true, description: "Chunks whose text + metadata is stored alongside each vector." },
      { name: "vectors", required: true, description: "Embedding vectors aligned with `chunks`." }
    ],
    outputPorts: [
      { name: "upserted", description: "Count of points written to the vector store." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "database",
      color: "#16a34a",
      formHints: {
        distance: { widget: "select" },
        dimensions: { widget: "number", min: 1, step: 1 }
      }
    }
  },
  async execute(input) {
    const { inputs, config, context } = input;
    const { url } = requireBackendConnection(input, "vector", {
      pluginId: "vector_upsert",
      defaultPort: 6333
    });
    const store = createVectorStore({ url });
    const collection = String(
      pickBackendName(input, "vector") ??
        context.resolvedConfig.values["vector.collection"]?.value ??
        "default"
    );
    const distance = String(
      config.distance ?? context.resolvedConfig.values["vector.distance"]?.value ?? "cosine"
    ) as DistanceMetric;

    const chunks = (inputs.chunks as Array<{ text?: string; index?: number } & Record<string, unknown>> | undefined) ?? [];
    const vectors = (inputs.vectors as number[][] | undefined) ?? [];
    if (vectors.length === 0) {
      return { outputs: { upserted: 0 } };
    }
    // Mirror qdrant_vector_store's dim guards: surface mismatches as
    // explicit messages instead of letting the backend 400 with no detail.
    const firstDim = vectors[0]?.length ?? 0;
    if (firstDim === 0) {
      throw new Error(
        `vector_upsert: first vector has length 0 — upstream embedder produced empty vectors`
      );
    }
    const ragged = vectors.findIndex(
      (v) => !Array.isArray(v) || v.length !== firstDim
    );
    if (ragged >= 0) {
      throw new Error(
        `vector_upsert: vectors[${ragged}] has length ${vectors[ragged]?.length ?? 0} but vectors[0] has length ${firstDim} — embedder output is ragged`
      );
    }
    const configuredDim = Number(config.dimensions ?? firstDim);
    if (configuredDim !== firstDim) {
      throw new Error(
        `vector_upsert: config.dimensions=${configuredDim} but vectors carry ${firstDim} — re-embed or update the dimension`
      );
    }
    const dimensions = configuredDim;
    await store.ensureCollection(collection, { dimensions, distance });

    const idPrefix = String(config.idPrefix ?? context.executionId ?? "doc");
    // ADR-0016 follow-through: enforce the dataset's chunk_schema at the
    // vector_upsert write path too (dataset_upsert already does this).
    // Empty / no-schema datasets pass every record (back-compat); errors
    // are aggregated across the whole batch so the caller sees every
    // offending record at once, not just the first.
    const chunkSchema = input.dataset?.chunkSchema as unknown;
    const schemaErrors: string[] = [];
    const points: VectorPoint[] = vectors.map((vector, index) => {
      const chunk = chunks[index] ?? {};
      const { text, index: chunkIndex, ...rest } = chunk;
      const payload = { text: text ?? "", chunkIndex: chunkIndex ?? index, ...rest };
      if (chunkSchema) {
        const errs = validateAgainstSchema(payload, chunkSchema);
        for (const e of errs) {
          schemaErrors.push(`chunks[${index}]${e.path}: ${e.message}`);
        }
      }
      return {
        id: String(chunk.id ?? `${idPrefix}_${index}`),
        vector,
        tenantId: context.tenantId,
        payload
      };
    });
    if (schemaErrors.length > 0) {
      throw new Error(
        `vector_upsert: chunk_schema validation failed for ${schemaErrors.length} field(s):\n` +
          schemaErrors.slice(0, 20).join("\n") +
          (schemaErrors.length > 20 ? `\n…and ${schemaErrors.length - 20} more` : "")
      );
    }
    await store.upsert(collection, points);
    return { outputs: { upserted: points.length } };
  }
};

export const textDocumentLoaderPlugin: InProcessPlugin = {
  manifest: {
    id: "text_document_loader",
    name: "Text Document Loader",
    version: "1.0.0",
    category: "loader",
    description:
      "Normalizes raw text, a uri reference, or a documents array into a uniform { documents:[{text,metadata}] } shape.",
    configSchema: {
      type: "object",
      properties: {
        trim: {
          type: "boolean",
          default: true,
          description: "Trim leading/trailing whitespace from each document's text."
        },
        splitOnBlankLines: {
          type: "boolean",
          default: false,
          description: "Split a single text input into multiple documents on blank lines."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "documents", description: "Existing documents array to normalize (passed through with cleaning applied)." },
      { name: "text", description: "Raw text to wrap as a document. Used when `documents` is absent." },
      { name: "uri", description: "Optional source URI added to document metadata." }
    ],
    outputPorts: [
      { name: "documents", description: "Normalized { text, metadata } array." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "file-input",
      formHints: {
        trim: { widget: "checkbox" },
        splitOnBlankLines: { widget: "checkbox" }
      }
    }
  },
  async execute({ inputs, config }) {
    const trim = config.trim !== false;
    const splitOnBlankLines = config.splitOnBlankLines === true;
    const normalize = (value: string): string => (trim ? value.trim() : value);

    const documents: Array<{ text: string; metadata: Record<string, unknown> }> = [];

    const existing = inputs.documents as Array<unknown> | undefined;
    if (Array.isArray(existing) && existing.length > 0) {
      for (const entry of existing) {
        if (typeof entry === "string") {
          documents.push({ text: normalize(entry), metadata: {} });
        } else if (entry && typeof entry === "object") {
          const record = entry as Record<string, unknown>;
          const text = normalize(String(record.text ?? record.content ?? ""));
          const metadata = (record.metadata as Record<string, unknown> | undefined) ?? {};
          documents.push({ text, metadata });
        }
      }
    }

    if (documents.length === 0) {
      const uri = inputs.uri !== undefined ? String(inputs.uri) : undefined;
      const rawText =
        inputs.text !== undefined
          ? String(inputs.text)
          : inputs.input !== undefined
            ? String(inputs.input)
            : "";
      if (rawText.length > 0) {
        const pieces = splitOnBlankLines
          ? rawText.split(/\n\s*\n/).map(normalize).filter((piece) => piece.length > 0)
          : [normalize(rawText)];
        for (const piece of pieces) {
          documents.push({ text: piece, metadata: uri ? { uri } : {} });
        }
      } else if (uri) {
        documents.push({ text: "", metadata: { uri } });
      }
    }

    return { outputs: { documents } };
  }
};

export const textParserPlugin: InProcessPlugin = {
  manifest: {
    id: "text_parser",
    name: "Text Parser",
    version: "1.0.0",
    category: "parser",
    description:
      "Extracts and cleans plain text from common input shapes (text, documents, chunks) into a single { text } string.",
    configSchema: {
      type: "object",
      properties: {
        stripHtml: {
          type: "boolean",
          default: false,
          description: "Remove HTML tags from the extracted text."
        },
        collapseWhitespace: {
          type: "boolean",
          default: true,
          description: "Collapse runs of whitespace into single spaces and trim."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "text", description: "Single string to clean." },
      { name: "documents", description: "Array of { text } documents to concatenate then clean." },
      { name: "chunks", description: "Array of { text } chunks to concatenate then clean." }
    ],
    outputPorts: [
      { name: "text", description: "Final cleaned string." }
    ],
    capabilities: ["ingestion", "query"],
    ui: {
      icon: "file-text",
      formHints: {
        stripHtml: { widget: "checkbox" },
        collapseWhitespace: { widget: "checkbox" }
      }
    }
  },
  async execute({ inputs, config }) {
    const stripHtml = config.stripHtml === true;
    const collapseWhitespace = config.collapseWhitespace !== false;

    const collect = (value: unknown): string => {
      if (typeof value === "string") return value;
      if (Array.isArray(value)) {
        return value
          .map((entry) => {
            if (typeof entry === "string") return entry;
            if (entry && typeof entry === "object") {
              const record = entry as Record<string, unknown>;
              return String(record.text ?? record.content ?? "");
            }
            return "";
          })
          .join("\n\n");
      }
      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return String(record.text ?? record.content ?? "");
      }
      return value === undefined || value === null ? "" : String(value);
    };

    let text =
      inputs.text !== undefined
        ? collect(inputs.text)
        : inputs.documents !== undefined
          ? collect(inputs.documents)
          : inputs.chunks !== undefined
            ? collect(inputs.chunks)
            : collect(inputs.input);

    if (stripHtml) {
      text = text.replace(/<[^>]*>/g, " ");
    }
    if (collapseWhitespace) {
      text = text.replace(/\s+/g, " ").trim();
    }

    return { outputs: { text } };
  }
};

export const qdrantVectorStorePlugin: InProcessPlugin = {
  manifest: {
    id: "qdrant_vector_store",
    name: "Qdrant Vector Store",
    version: "1.0.0",
    category: "vector_store",
    contract: 2,
    // ADR-0023: needs a `vectors` binding backed by a qdrant connection.
    requires: [{ binding: "vectors", kind: "qdrant" }],
    description:
      "Ensures a Qdrant collection exists and upserts embedded chunks/vectors into it.",
    configSchema: {
      // PR1 of the requires roll-out: DSN fields (url) are gone. The
      // dataset's resolved connection provides them. What stays is
      // per-call behaviour (collection, distance metric, dimensions).
      type: "object",
      properties: {
        collection: {
          type: "string",
          default: "default",
          description: "Target collection name."
        },
        distance: {
          type: "string",
          enum: ["cosine", "dot", "euclidean"],
          default: "cosine",
          description: "Distance metric used when the collection is created."
        },
        dimensions: {
          type: "integer",
          description: "Vector dimensionality. Inferred from the first vector when unset."
        }
      },
      additionalProperties: false
    },
    secretsSchema: {
      type: "object",
      properties: {
        apiKey: {
          type: "string",
          format: "secret-ref",
          description: "Reference to the Qdrant API key secret (passed to the vector store client)."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "chunks", required: true, description: "Chunks whose text + metadata is stored alongside each vector." },
      { name: "vectors", required: true, description: "Embedding vectors aligned with `chunks`." }
    ],
    outputPorts: [
      { name: "upserted", description: "Count of points written to the collection." },
      { name: "collection", description: "Name of the collection the points were written to." }
    ],
    capabilities: ["ingestion"],
    ui: {
      icon: "database",
      color: "#16a34a",
      formHints: {
        distance: { widget: "select" },
        dimensions: { widget: "number", min: 1, step: 1 },
        apiKey: { widget: "secret" }
      }
    }
  },
  async execute(input) {
    const { inputs, config, secrets, context } = input;
    const { url } = requireBackendConnection(input, "vector", {
      pluginId: "qdrant_vector_store",
      defaultPort: 6333
    });
    const store = createVectorStore({
      url,
      apiKey: secrets.apiKey ? String(secrets.apiKey) : undefined
    });
    const collection = String(
      pickBackendName(input, "vector") ??
        context.resolvedConfig.values["vector.collection"]?.value ??
        "default"
    );
    const distance = String(
      config.distance ?? context.resolvedConfig.values["vector.distance"]?.value ?? "cosine"
    ) as DistanceMetric;

    const chunks =
      (inputs.chunks as Array<{ text?: string; index?: number } & Record<string, unknown>> | undefined) ?? [];
    const vectors = (inputs.vectors as number[][] | undefined) ?? [];
    if (vectors.length === 0) {
      return { outputs: { upserted: 0, collection } };
    }
    // Dimensions guard. Qdrant returns "Bad Request" (no detail) when a
    // batch's vectors have mismatched lengths or differ from the
    // collection's configured dim. Catch both upfront so the error is
    // diagnosable instead of a wall of 400s.
    const firstDim = vectors[0]?.length ?? 0;
    if (firstDim === 0) {
      throw new Error(
        `qdrant_vector_store: first vector has length 0 — upstream embedder produced empty vectors`
      );
    }
    const ragged = vectors.findIndex(
      (v) => !Array.isArray(v) || v.length !== firstDim
    );
    if (ragged >= 0) {
      throw new Error(
        `qdrant_vector_store: vectors[${ragged}] has length ${vectors[ragged]?.length ?? 0} but vectors[0] has length ${firstDim} — embedder output is ragged`
      );
    }
    const configuredDim = Number(config.dimensions ?? firstDim);
    if (configuredDim !== firstDim) {
      throw new Error(
        `qdrant_vector_store: config.dimensions=${configuredDim} but vectors carry ${firstDim} — re-embed or update the dimension`
      );
    }
    const dimensions = configuredDim;
    await store.ensureCollection(collection, { dimensions, distance });

    const points: VectorPoint[] = vectors.map((vector, index) => {
      const chunk = chunks[index] ?? {};
      const { text, index: chunkIndex, ...rest } = chunk;
      // Qdrant accepts UUIDs or unsigned ints only. Use the chunk's own id
      // when present, otherwise hash the natural key so re-running on the
      // same source replaces rather than duplicates.
      const docId = String(
        (chunk as Record<string, unknown>).docId ?? (chunk as Record<string, unknown>).path ?? ""
      );
      const idx = typeof chunkIndex === "number" ? chunkIndex : index;
      const pointId =
        typeof chunk.id === "string" && chunk.id.length > 0
          ? chunk.id
          : deterministicUuid(`${context.tenantId}::${collection}::${docId}::${idx}`);
      return {
        id: pointId,
        vector,
        tenantId: context.tenantId,
        payload: { text: text ?? "", chunkIndex: chunkIndex ?? index, ...rest }
      };
    });
    try {
      await store.upsert(collection, points);
    } catch (err) {
      // Same shape as qdrant_delete: enrich the bare client error with
      // operation + collection + dim + count so the trace is
      // diagnosable. Without this, a dim/distance/payload mismatch
      // looks like a generic 400 in the UI.
      throw enrichQdrantError(err, {
        operation: "upsert",
        collection,
        dim: dimensions,
        count: points.length
      });
    }
    return { outputs: { upserted: points.length, collection } };
  }
};

export const scoreRerankerPlugin: InProcessPlugin = {
  manifest: {
    id: "score_reranker",
    name: "Score Reranker",
    version: "1.0.0",
    category: "reranker",
    description:
      "Reorders documents by a provided numeric score (desc), falling back to lexical overlap with the question, truncated to topK.",
    configSchema: {
      type: "object",
      properties: {
        topK: {
          type: "integer",
          default: 5,
          description: "Maximum number of documents to keep after reranking."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "documents", required: true, description: "Documents to rerank, each with optional `score` and `text`." },
      { name: "question", description: "Used to compute lexical overlap when documents lack numeric scores." }
    ],
    outputPorts: [
      { name: "documents", description: "Reranked, truncated documents array." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "arrow-up-down",
      formHints: { topK: { widget: "number", min: 1, step: 1 } }
    }
  },
  async execute({ inputs, config }) {
    const topK = Number(config.topK ?? 5);
    const documents =
      (inputs.documents as Array<{ text?: string; score?: number } & Record<string, unknown>> | undefined) ?? [];
    const question = String(inputs.question ?? (inputs.input as any)?.question ?? "");

    const tokenize = (value: string): string[] =>
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 0);
    const questionTokens = new Set(tokenize(question));

    const overlap = (text: string): number => {
      if (questionTokens.size === 0) return 0;
      let hits = 0;
      for (const token of new Set(tokenize(text))) {
        if (questionTokens.has(token)) hits += 1;
      }
      return hits;
    };

    const ranked = documents
      .map((doc, index) => {
        const numericScore = typeof doc.score === "number" ? doc.score : undefined;
        return {
          doc,
          index,
          rank: numericScore !== undefined ? numericScore : overlap(String(doc.text ?? ""))
        };
      })
      .sort((left, right) => {
        if (right.rank !== left.rank) return right.rank - left.rank;
        return left.index - right.index;
      })
      .slice(0, Math.max(0, topK))
      .map((entry) => entry.doc);

    return { outputs: { documents: ranked } };
  }
};

export const staticValueToolPlugin: InProcessPlugin = {
  manifest: {
    id: "static_value_tool",
    name: "Static Value Tool",
    version: "1.0.0",
    category: "tool",
    description:
      "Returns a configured constant value. Performs no network or filesystem access (avoids SSRF).",
    configSchema: {
      type: "object",
      properties: {
        value: {
          type: "object",
          default: {},
          additionalProperties: true,
          description: "The constant value to return. May be an object or a string."
        }
      },
      additionalProperties: false
    },
    outputPorts: [
      { name: "result", description: "The configured constant value." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "box",
      formHints: { value: { widget: "json" } }
    }
  },
  async execute({ config }) {
    const value = config.value ?? {};
    return { outputs: { result: value } };
  }
};

export const fieldRouterPlugin: InProcessPlugin = {
  manifest: {
    id: "field_router",
    name: "Field Router",
    version: "1.0.0",
    category: "router",
    description:
      "Reads an input field and maps its value to a route label via a configured routes map, passing inputs through.",
    configSchema: {
      type: "object",
      properties: {
        field: {
          type: "string",
          default: "intent",
          description: "Name of the input field whose value selects the route."
        },
        routes: {
          type: "object",
          default: {},
          additionalProperties: true,
          description: "Map of input value -> route label."
        },
        defaultRoute: {
          type: "string",
          default: "default",
          description: "Route label used when the input value does not match any route."
        }
      },
      additionalProperties: false
    },
    outputPorts: [
      { name: "route", description: "Selected route label (the mapped value or `defaultRoute`)." },
      { name: "value", description: "Original input field value the route was selected from." },
      { name: "passthrough", description: "Original inputs object, forwarded unchanged for downstream nodes." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "git-branch",
      formHints: {
        field: { widget: "text" },
        routes: { widget: "json" },
        defaultRoute: { widget: "text" }
      }
    }
  },
  async execute({ inputs, config }) {
    const field = String(config.field ?? "intent");
    const routes = (config.routes as Record<string, unknown> | undefined) ?? {};
    const defaultRoute = String(config.defaultRoute ?? "default");
    const value = inputs[field];
    const key = value === undefined || value === null ? "" : String(value);
    const route = key in routes ? String(routes[key]) : defaultRoute;
    return { outputs: { route, value, passthrough: inputs } };
  }
};

export const bufferMemoryPlugin: InProcessPlugin = {
  manifest: {
    id: "buffer_memory",
    name: "Buffer Memory",
    version: "1.0.0",
    category: "memory",
    description:
      "Appends the current turn to a conversation history array, trimming to the last N messages.",
    configSchema: {
      type: "object",
      properties: {
        maxMessages: {
          type: "integer",
          default: 20,
          description: "Maximum number of history entries to retain (most recent kept)."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "history", description: "Existing conversation history array. New entries are appended." },
      { name: "message", description: "Single new turn to append. Defaults to the inputs object minus `history`." }
    ],
    outputPorts: [
      { name: "history", description: "Updated history array, trimmed to the configured maxMessages." }
    ],
    capabilities: ["query"],
    ui: {
      icon: "history",
      formHints: { maxMessages: { widget: "number", min: 1, step: 1 } }
    }
  },
  async execute({ inputs, config }) {
    const maxMessages = Math.max(1, Number(config.maxMessages ?? 20));
    const history = Array.isArray(inputs.history) ? [...(inputs.history as unknown[])] : [];
    const turn =
      inputs.message !== undefined
        ? inputs.message
        : Object.fromEntries(Object.entries(inputs).filter(([key]) => key !== "history"));
    history.push(turn);
    const trimmed = history.slice(Math.max(0, history.length - maxMessages));
    return { outputs: { history: trimmed } };
  }
};

// ---------------------------------------------------------------------------
// OpenSearch plugins
//
// Five in-process plugins built on the dependency-free @ragdoll/opensearch
// client: a document source, a document/vector sink, and three retrievers
// (BM25 lexical, kNN vector, and a hybrid that fuses the two). All retrievers
// isolate by tenant the same way the Qdrant retriever does.
// ---------------------------------------------------------------------------

/**
 * Webhook trigger source: emits the run's input payload as its output, so a
 * pipeline started by `POST /api/triggers/webhook/<token>` flows the request
 * body straight into the DAG. The trigger token is minted out-of-band
 * (`POST /api/pipelines/:id/triggers`); this plugin only declares the intent
 * on the canvas so authors can see / wire which node a webhook drives.
 */
export const webhookTriggerPlugin: InProcessPlugin = {
  manifest: {
    id: "webhook_trigger",
    name: "Webhook Trigger",
    version: "1.0.0",
    category: "datasource",
    description:
      "Starts the pipeline when an external system POSTs to its webhook URL. " +
      "Mint a URL with POST /api/pipelines/:id/triggers; the POST body becomes the input.",
    configSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Free-text notes about what this webhook accepts."
        }
      },
      additionalProperties: false
    },
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    outputPorts: [
      { name: "body", description: "Parsed POST body delivered to the trigger URL." },
      { name: "headers", description: "Request headers, when forwarded by the trigger endpoint." },
      { name: "query", description: "Query string parameters, when present on the trigger URL." }
    ],
    capabilities: ["query", "ingestion"],
    ui: {
      icon: "webhook",
      formHints: { description: { widget: "textarea" } }
    }
  },
  async execute({ inputs }) {
    // Emit on named output ports while keeping a flat spread of the original
    // payload so legacy unported edges (which use the flatten-at-root
    // fallback) keep seeing the same shape they always did.
    const body = (inputs as Record<string, unknown>).body;
    const headers = (inputs as Record<string, unknown>).headers;
    const query = (inputs as Record<string, unknown>).query;
    return { outputs: { ...inputs, body, headers, query } };
  }
};

/**
 * Webhook output sink: POSTs the node's inputs (typically the pipeline's
 * final answer) to a configured URL when the DAG reaches it. The optional
 * authorization header is templated from a secret reference so credentials
 * never live in the pipeline spec; non-2xx responses fail the node so the
 * execution is marked failed and retried per the pipeline's policy.
 */
export const webhookOutputPlugin: InProcessPlugin = {
  manifest: {
    id: "webhook_output",
    name: "Webhook Output",
    version: "1.0.0",
    category: "sink",
    description:
      "POSTs the pipeline result to a configured URL when this node runs.",
    configSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description: "Absolute URL to POST the JSON result to."
        },
        method: {
          type: "string",
          enum: ["POST", "PUT", "PATCH"],
          default: "POST"
        },
        headers: {
          type: "object",
          description:
            "Extra static headers (e.g. `{ \"x-source\": \"ragdoll\" }`).",
          additionalProperties: { type: "string" }
        },
        timeoutMs: {
          type: "integer",
          default: 10000,
          description: "Request timeout in milliseconds."
        }
      },
      additionalProperties: false
    },
    secretsSchema: {
      type: "object",
      properties: {
        authorization: {
          type: "string",
          description:
            "Optional `Authorization` header value (e.g. `Bearer <secret>`)."
        }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "payload", description: "Object that becomes the JSON body of the outbound request. Defaults to the entire inputs bag." }
    ],
    outputPorts: [
      { name: "delivered", description: "Delivery receipt: { url, status, response }." }
    ],
    capabilities: ["query", "ingestion"],
    ui: {
      icon: "send",
      formHints: {
        url: { widget: "text" },
        method: { widget: "select" },
        headers: { widget: "json" }
      }
    }
  },
  async execute({ inputs, config, secrets }) {
    const url = String(config.url ?? "");
    if (!url) throw new Error("webhook_output: `url` is required");
    const method = String(config.method ?? "POST").toUpperCase();
    const timeoutMs = Number(config.timeoutMs ?? 10000);
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    const extra = (config.headers ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === "string") headers[k] = v;
    }
    if (secrets.authorization) headers.authorization = secrets.authorization;

    // Prefer the named `payload` port when wired explicitly; otherwise fall
    // back to the full inputs bag (legacy behaviour).
    const body = inputs.payload !== undefined ? inputs.payload : inputs;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `webhook_output: ${method} ${url} -> ${response.status} ${text.slice(0, 200)}`
      );
    }
    let responseBody: unknown = undefined;
    const ct = response.headers.get("content-type") ?? "";
    const text = await response.text();
    if (text && ct.includes("application/json")) {
      try {
        responseBody = JSON.parse(text);
      } catch {
        responseBody = text;
      }
    } else if (text) {
      responseBody = text;
    }
    return {
      outputs: {
        delivered: { url, status: response.status, response: responseBody },
        ...inputs
      }
    };
  }
};

// ---------------------------------------------------------------------------
// Control-flow plugins (declared input/output ports + subgraph execution).
//
// These plugins rely on the runtime's port-aware wiring (see packages/runtime).
// `if_then` uses skip-cascading on its unselected branch; `for`/`foreach`/
// `while` call `input.runSubgraph()` to evaluate a body PipelineSpec stored in
// their config. Body specs are wrapped to the standard envelope before being
// handed to the runtime.
// ---------------------------------------------------------------------------


// Control-flow plugins live in their own module. Re-exported so the
// plugin-loader's namespace scan registers them alongside everything else.
export {
  ifThenPlugin,
  forLoopPlugin,
  forEachPlugin,
  whileLoopPlugin
} from "./plugins/control-flow.ts";

// OpenSearch plugin family lives in its own module. Re-exported so the
// plugin-loader's namespace scan picks them up alongside everything else.
// fuseHybridResults is re-exported too because the unit tests reference
// it as the canonical fusion math.
export {
  openSearchInputPlugin,
  openSearchOutputPlugin,
  openSearchBm25RetrieverPlugin,
  openSearchVectorRetrieverPlugin,
  openSearchHybridRetrieverPlugin,
  fuseHybridResults,
  looksLikeMissingVectorField
} from "./plugins/opensearch.ts";

// External-database (Postgres) plugin family. The three plugins share a
// pooled-connection core in `./postgres-core.ts`; see ADR 0020 (superseded
// by ADR 0023) for the SQL-as-config / params-as-data / connections-as-
// secrets architectural rules. `buildBatchUpsert` is re-exported so the
// unit tests can assert the generated SQL shape without standing up a
// database. The `postgresConnectionDriver` export is the ADR-0024
// connection-driver plugin the loader discovers via module scan.
export {
  postgresQueryPlugin,
  postgresUpsertPlugin,
  postgresDeletePlugin,
  postgresExecPlugin,
  buildBatchUpsert,
  buildBatchDelete
} from "./plugins/postgres.ts";
// `postgresConnectionDriver` is exported from the pooled-core module
// (`./postgres-core.ts`) where the driver factory + pool live.
export { postgresConnectionDriver } from "./postgres-core.ts";

// MongoDB plugin family (ADR-0021, superseded by ADR-0023). Consumes the
// unified Connections registry; the `mongodbConnectionDriver` export is
// the ADR-0024 connection-driver plugin the loader picks up by category.
export {
  mongoFindPlugin,
  mongoInsertPlugin,
  mongoDeletePlugin,
  mongoAggregatePlugin,
  mongodbConnectionDriver
} from "./plugins/mongo.ts";

// ClickHouse plugin family (ADR-0021, superseded by ADR-0023). Same
// connection-registry pattern as MongoDB; the `clickhouseConnectionDriver`
// export is the ADR-0024 connection-driver plugin. Designed for analytics-
// shaped workloads: parameterized SELECT, bulk INSERT, ALTER…DELETE WHERE
// with tenant-id guard.
export {
  clickhouseQueryPlugin,
  clickhouseInsertPlugin,
  clickhouseDeletePlugin,
  clickhouseConnectionDriver
} from "./plugins/clickhouse.ts";

// Storage-backend connection drivers (qdrant / opensearch / dgraph). Each
// exports a ConnectionDriverPlugin (ADR-0024) that the platform loader
// discovers via module scan, routes into the imperative driver map, and
// surfaces under /api/plugins + /api/connection-kinds. Without these
// exports the Connections screen + periodic probe report "no driver
// registered" for those kinds.
export {
  qdrantConnectionDriver,
  opensearchConnectionDriver,
  dgraphConnectionDriver
} from "./plugins/storage-drivers.ts";

// Email pre-processing family — pure text, no LLM, no I/O.
// `preprocessEmailBody` and `aggregateThreads` are pure helpers re-
// exported for unit tests.
export {
  emailPreprocessPlugin,
  threadAggregatePlugin,
  preprocessEmailBody,
  aggregateThreads,
  detectLanguage
} from "./plugins/email-preprocess.ts";

// Anthropic Contextual Retrieval chunker — generic over document type.
export { chunkContextualPlugin } from "./plugins/contextual-chunker.ts";

// Schema-driven extraction + entity resolution. `fuzzySimilarity` and
// `resolveMention` are exported as pure helpers for unit tests.
export {
  extractEntitiesPlugin,
  entityResolvePlugin,
  fuzzySimilarity,
  resolveMention
} from "./plugins/extraction.ts";

// Synchronous-pipeline LLM glue: NL→args classifier, structured event
// summariser, action-item status refresher.
export {
  queryClassifyPlugin,
  summarizeEventPlugin,
  actionStatusRefreshPlugin
} from "./plugins/sync-llm.ts";

// Tone profile + composition. `curateExemplars` is exported as a pure
// helper for unit tests.
export {
  toneProfileBuildPlugin,
  composeWithStylePlugin,
  curateExemplars
} from "./plugins/tone.ts";
