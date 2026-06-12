/**
 * Contextual chunker — implements Anthropic's "Contextual Retrieval"
 * pattern: for each chunk, generate a 1–2 sentence situating blurb
 * that describes how the chunk fits within the document, and prepend
 * that blurb to the chunk text before embedding.
 *
 * The contextual prefix dramatically improves retrieval recall when
 * chunks are short and the document provides ambient context the
 * chunk itself elides ("As mentioned above, …" / "The same applies
 * to V2 …"). Generic over document type: nothing here is email-
 * specific.
 *
 * Per-chunk LLM cost is intentionally bounded — one short call per
 * chunk, parallelised with a small concurrency budget so a large
 * document doesn't melt the provider. Cache + reuse is a downstream
 * concern (the ingest pipeline's `delta_filter` skips already-seen
 * documents at the doc level).
 */

import type { InProcessPlugin } from "../../../../packages/plugin-sdk/src/index.ts";
import { buildProviderRegistry, resolveChatModel } from "../helpers.ts";

interface IncomingChunk {
  text: string;
  index?: number;
  [field: string]: unknown;
}

interface OutgoingChunk extends IncomingChunk {
  context: string;
  contextualText: string;
}

const DEFAULT_PROMPT =
  "Here is the document the chunk is from:\n<document>\n{{document}}\n</document>\n\nAnd here is the chunk:\n<chunk>\n{{chunk}}\n</chunk>\n\nWrite ONE OR TWO short sentences that situate this chunk within the document so a retriever sees enough context to recall the chunk for relevant queries. Output the sentences directly with no preamble.";

/**
 * Replace the `{{document}}` and `{{chunk}}` markers in a template.
 * Pure string substitution — not a templating engine — so an
 * adversarial document containing literal `{{document}}` won't be
 * re-substituted on the second pass.
 */
function renderContextPrompt(template: string, document: string, chunk: string): string {
  return template.split("{{document}}").join(document).split("{{chunk}}").join(chunk);
}

/**
 * Run `tasks` with at most `concurrency` in flight at any time. Returns
 * results in input order. Used here because most providers tolerate
 * 4–8 concurrent short calls comfortably and going higher trips rate
 * limits.
 */
async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<U>
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

export const chunkContextualPlugin: InProcessPlugin = {
  manifest: {
    id: "chunk_contextual",
    name: "Contextual Chunker",
    version: "1.0.0",
    category: "chunker",
    description:
      "Anthropic Contextual Retrieval: for each chunk, generate a short situating blurb via the configured provider and prepend it before embedding. Generic over document type.",
    configSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["openai", "anthropic", "ollama"],
          default: "ollama",
          description: "Provider id used for the contextualising call."
        },
        model: {
          type: "string",
          default: "llama3.1",
          description:
            "Model id. Default is cheap and fast; override with a Haiku-class model for higher-quality contexts."
        },
        contextPromptTemplate: {
          type: "string",
          default: DEFAULT_PROMPT,
          description:
            "Prompt template. Placeholders: {{document}}, {{chunk}}. Plain string substitution; not a templating engine."
        },
        documentField: {
          type: "string",
          default: "document",
          description:
            "Name of the field on the input that holds the full document text. Used to provide context to each chunk."
        },
        chunksField: {
          type: "string",
          default: "chunks",
          description: "Name of the field on the input that holds the pre-chunked array."
        },
        maxConcurrency: {
          type: "integer",
          default: 4,
          description: "Maximum concurrent provider calls."
        },
        maxTokens: {
          type: "integer",
          default: 160,
          description: "Cap on the context blurb size — usually 1-2 sentences fits in 160 tokens."
        },
        joiner: {
          type: "string",
          default: "\n\n",
          description: "Separator inserted between the generated context and the chunk text."
        }
      },
      additionalProperties: false
    },
    secretsSchema: {
      type: "object",
      properties: {
        apiKey: { type: "string", format: "secret-ref", description: "Provider API key (when required)." }
      },
      additionalProperties: false
    },
    inputPorts: [
      { name: "document", required: true, description: "Full document text used as ambient context." },
      { name: "chunks", required: true, description: "Pre-chunked array; each item must have a `text` field." }
    ],
    outputPorts: [
      {
        name: "chunks",
        description:
          "Same chunks, augmented with `context` and `contextualText` fields. `contextualText` is the embedding-ready string."
      },
      { name: "skipped", description: "Number of chunks for which contextualising failed (preserved with empty context)." }
    ],
    capabilities: ["transform"],
    ui: {
      icon: "scissors",
      color: "#16a34a",
      formHints: {
        provider: { widget: "select" },
        contextPromptTemplate: { widget: "textarea", rows: 6 },
        maxConcurrency: { widget: "number", min: 1, step: 1 },
        maxTokens: { widget: "number", min: 32, step: 16 }
      }
    }
  },
  async execute(input) {
    const { inputs, config, secrets, context } = input;
    const documentField = String(config.documentField ?? "document");
    const chunksField = String(config.chunksField ?? "chunks");
    const documentRaw = inputs[documentField] ?? inputs.document ?? inputs.text;
    const chunksRaw = inputs[chunksField] ?? inputs.chunks;
    if (typeof documentRaw !== "string") {
      throw new Error(`chunk_contextual: expected a string on inputs.${documentField}`);
    }
    if (!Array.isArray(chunksRaw)) {
      throw new Error(`chunk_contextual: expected an array on inputs.${chunksField}`);
    }
    const chunks = chunksRaw as IncomingChunk[];
    const providers = buildProviderRegistry();
    const { providerId, model, baseUrl } = resolveChatModel({
      config,
      resolvedValues: context.resolvedConfig.values
    });
    const provider = providers.require(providerId);
    const template = String(config.contextPromptTemplate ?? DEFAULT_PROMPT);
    const joiner = String(config.joiner ?? "\n\n");
    const maxTokens = Math.max(32, Number(config.maxTokens ?? 160));
    const concurrency = Math.max(1, Math.floor(Number(config.maxConcurrency ?? 4)));

    let skipped = 0;
    const out = await mapWithConcurrency<IncomingChunk, OutgoingChunk>(
      chunks,
      concurrency,
      async (chunk) => {
        const chunkText = typeof chunk.text === "string" ? chunk.text : "";
        try {
          const response = await provider.chat({
            tenantId: context.tenantId,
            model,
            messages: [
              {
                role: "user",
                content: renderContextPrompt(template, documentRaw, chunkText)
              }
            ],
            temperature: 0.1,
            maxTokens,
            apiKey: secrets.apiKey,
            baseUrl
          });
          const blurb = (response.text ?? "").trim();
          if (!blurb) {
            skipped += 1;
            return { ...chunk, context: "", contextualText: chunkText };
          }
          return {
            ...chunk,
            context: blurb,
            contextualText: `${blurb}${joiner}${chunkText}`
          };
        } catch (err) {
          // A single-chunk failure shouldn't fail the whole document.
          // The chunk is preserved with empty context so the downstream
          // embedder sees a complete array.
          skipped += 1;
          return {
            ...chunk,
            context: "",
            contextualText: chunkText,
            contextError: err instanceof Error ? err.message : String(err)
          };
        }
      }
    );

    return {
      outputs: {
        chunks: out,
        skipped
      },
      usage: {
        provider: providerId,
        model
      }
    };
  }
};
