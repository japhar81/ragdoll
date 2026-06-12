/**
 * Schema-driven extraction and entity-resolution transformers. Both are
 * generic over the domain — the schema and canonical entity list live
 * in pipeline config, not in the plugin code.
 *
 *   - `extract_entities` runs one provider call per input record,
 *     asking the model to emit structured records matching a config-
 *     supplied JSON schema. Multiple records, bounded concurrency,
 *     graceful fallback on parse failure.
 *
 *   - `entity_resolve` normalises mentions (sender names, project
 *     codes, …) against an authoritative list. Exact + alias + fuzzy
 *     matching first; an optional LLM fallback handles the long tail.
 *     The canonical list can be supplied inline or fetched via the
 *     `postgres_query` plugin upstream.
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

// ---------------------------------------------------------------------------
// extract_entities
// ---------------------------------------------------------------------------

interface ExtractionRecord {
  [key: string]: unknown;
}

/** Bounded-concurrency mapper (same shape as the chunker's helper). */
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

export const extractEntitiesPlugin: InProcessPlugin = {
  manifest: {
    id: "extract_entities",
    name: "Extract Entities",
    version: "1.0.0",
    category: "transformer",
    description:
      "Runs one provider call per input record asking the model to emit structured records matching a config-supplied JSON schema. The schema is the contract; the plugin is domain-agnostic.",
    configSchema: {
      type: "object",
      required: ["extractionSchema"],
      properties: {
        provider: { type: "string", enum: PROVIDER_ENUM, default: "ollama" },
        model: { type: "string", default: "llama3.1" },
        baseUrl: { type: "string", description: "Optional provider base URL override." },
        systemPrompt: {
          type: "string",
          default:
            "You extract structured records from text. Be conservative — omit fields you cannot infer with high confidence rather than guessing.",
          description: "System prompt prefixed to every extraction call."
        },
        extractionSchema: {
          type: "object",
          description:
            "JSON-schema-like shape the model must emit. Surfaces in the prompt as the structural contract."
        },
        inputField: {
          type: "string",
          default: "text",
          description: "Field on each input record holding the text to extract from."
        },
        idField: {
          type: "string",
          description: "Optional field carried through onto each extracted record (e.g. source message id)."
        },
        maxConcurrency: { type: "integer", default: 4 },
        retry: { type: "integer", default: 1, description: "Re-ask attempts on JSON parse failure." },
        maxTokens: { type: "integer", default: 1024 }
      },
      additionalProperties: false
    },
    secretsSchema: PROVIDER_SECRETS_SCHEMA,
    inputPorts: [
      {
        name: "records",
        required: true,
        description: "Array of records to extract from. Each must carry the configured `inputField`."
      }
    ],
    outputPorts: [
      { name: "records", description: "Extracted structured records (each may be an object or an array of objects)." },
      { name: "failures", description: "Records the model couldn't produce valid JSON for; safe to retry separately." }
    ],
    capabilities: ["transform", "llm"],
    ui: {
      icon: "tag",
      color: "#a855f7",
      formHints: {
        provider: { widget: "select" },
        systemPrompt: { widget: "textarea", rows: 4 },
        extractionSchema: { widget: "json" },
        maxConcurrency: { widget: "number", min: 1, step: 1 },
        retry: { widget: "number", min: 0, step: 1 }
      }
    }
  },
  async execute(input) {
    const { inputs, config, secrets, context } = input;
    const records = inputs.records ?? inputs.documents ?? inputs.rows;
    if (!Array.isArray(records)) {
      throw new Error("extract_entities: `inputs.records` must be an array.");
    }
    const schema = config.extractionSchema;
    if (!schema || typeof schema !== "object") {
      throw new Error("extract_entities: `config.extractionSchema` is required.");
    }
    const inputField = String(config.inputField ?? "text");
    const idField = config.idField ? String(config.idField) : undefined;
    const concurrency = Math.max(1, Math.floor(Number(config.maxConcurrency ?? 4)));
    const retry = Math.max(0, Math.floor(Number(config.retry ?? 1)));
    const maxTokens = Math.max(64, Number(config.maxTokens ?? 1024));
    const providers = buildProviderRegistry();
    const { providerId, model, baseUrl } = resolveChatModel({
      config,
      resolvedValues: context.resolvedConfig.values
    });

    const out: ExtractionRecord[] = [];
    const failures: Array<{ sourceId?: unknown; error: string }> = [];

    await mapWithConcurrency(records as ExtractionRecord[], concurrency, async (record) => {
      const text = record[inputField];
      if (typeof text !== "string" || text.length === 0) return;
      const sourceId = idField ? record[idField] : undefined;
      try {
        const result = await chatStructured({
          providers,
          tenantId: context.tenantId,
          providerId,
          model,
          baseUrl: baseUrl ?? config.baseUrl ? String(baseUrl ?? config.baseUrl) : undefined,
          apiKey: secrets.apiKey,
          systemPrompt: String(config.systemPrompt ?? ""),
          userPrompt: text,
          schema: schema as Record<string, unknown>,
          maxTokens,
          retry
        });
        const parsed = result.parsed;
        const append = (rec: unknown) => {
          if (rec && typeof rec === "object" && !Array.isArray(rec)) {
            out.push({ ...(rec as ExtractionRecord), ...(idField && sourceId !== undefined ? { sourceId } : {}) });
          }
        };
        if (Array.isArray(parsed)) parsed.forEach(append);
        else append(parsed);
      } catch (err) {
        failures.push({
          sourceId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    });

    return {
      outputs: { records: out, failures },
      usage: { provider: providerId, model }
    };
  }
};

// ---------------------------------------------------------------------------
// entity_resolve
// ---------------------------------------------------------------------------

interface CanonicalEntity {
  id: string;
  name: string;
  aliases?: string[];
  [field: string]: unknown;
}

interface MentionRecord {
  [field: string]: unknown;
}

/**
 * Damerau-Levenshtein-ish distance, normalised to [0, 1] where 1 is
 * identical. Cheap enough to run against a few-thousand-row canonical
 * list per mention without hurting sync-pipeline latency. For larger
 * canonical sets the pipeline should pre-filter via `postgres_query`
 * (e.g. by first letter) before this plugin.
 */
export function fuzzySimilarity(a: string, b: string): number {
  const sa = a.toLowerCase();
  const sb = b.toLowerCase();
  if (sa === sb) return 1;
  if (sa.length === 0 || sb.length === 0) return 0;
  const m = sa.length;
  const n = sb.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = sa[i - 1] === sb[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
      if (
        i > 1 &&
        j > 1 &&
        sa[i - 1] === sb[j - 2] &&
        sa[i - 2] === sb[j - 1]
      ) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  const distance = dp[m][n];
  return 1 - distance / Math.max(m, n);
}

export function resolveMention(
  mention: string,
  canonical: CanonicalEntity[],
  matchFields: string[],
  fuzzyThreshold: number
): { entity: CanonicalEntity; score: number; matchedField: string; matchedValue: string } | undefined {
  const m = mention.trim();
  if (!m) return undefined;
  let best:
    | { entity: CanonicalEntity; score: number; matchedField: string; matchedValue: string }
    | undefined;
  for (const entity of canonical) {
    const candidates: Array<{ field: string; value: string }> = [];
    for (const field of matchFields) {
      const raw = entity[field];
      if (typeof raw === "string") candidates.push({ field, value: raw });
      else if (Array.isArray(raw)) {
        for (const v of raw) if (typeof v === "string") candidates.push({ field, value: v });
      }
    }
    for (const { field, value } of candidates) {
      // Exact-match short-circuit always wins.
      if (value.toLowerCase() === m.toLowerCase()) {
        return { entity, score: 1, matchedField: field, matchedValue: value };
      }
      const score = fuzzySimilarity(m, value);
      if (score >= fuzzyThreshold && (!best || score > best.score)) {
        best = { entity, score, matchedField: field, matchedValue: value };
      }
    }
  }
  return best;
}

export const entityResolvePlugin: InProcessPlugin = {
  manifest: {
    id: "entity_resolve",
    name: "Entity Resolve",
    version: "1.0.0",
    category: "transformer",
    description:
      "Normalises free-text mentions against an authoritative canonical list. Exact + alias + fuzzy matching; an optional LLM fallback handles ambiguous mentions.",
    configSchema: {
      type: "object",
      properties: {
        canonical: {
          type: "array",
          description:
            "Inline canonical list. Each entry must have `id` and `name`; `aliases` array optional."
        },
        canonicalField: {
          type: "string",
          default: "canonical",
          description:
            "Alternative: read the canonical list from this field on the input (so an upstream postgres_query can supply it)."
        },
        mentionField: {
          type: "string",
          default: "mention",
          description: "Field on each input record holding the mention to resolve."
        },
        matchFields: {
          type: "array",
          items: { type: "string" },
          default: ["name", "aliases"],
          description: "Canonical fields the matcher considers."
        },
        fuzzyThreshold: {
          type: "number",
          default: 0.85,
          description: "Minimum normalised similarity for a fuzzy match (0..1)."
        },
        useLlmFallback: {
          type: "boolean",
          default: false,
          description:
            "When true, the LLM is asked to pick from the candidate list for mentions that no fuzzy match cleared."
        },
        provider: { type: "string", enum: PROVIDER_ENUM, default: "ollama" },
        model: { type: "string", default: "llama3.1" }
      },
      additionalProperties: false
    },
    secretsSchema: PROVIDER_SECRETS_SCHEMA,
    inputPorts: [
      { name: "records", required: true, description: "Records with mentions to resolve." },
      { name: "canonical", description: "Optional canonical list (used when `config.canonical` is empty)." }
    ],
    outputPorts: [
      { name: "records", description: "Records with `entityId`, `entityName`, `matchScore`, `matchMethod` added." },
      { name: "unresolved", description: "Records whose mention couldn't be confidently resolved." }
    ],
    capabilities: ["transform"],
    ui: {
      icon: "link",
      color: "#a855f7",
      formHints: {
        provider: { widget: "select" },
        canonical: { widget: "json" },
        matchFields: { widget: "tags" },
        fuzzyThreshold: { widget: "range", min: 0, max: 1, step: 0.05 },
        useLlmFallback: { widget: "checkbox" }
      }
    }
  },
  async execute(input) {
    const { inputs, config, secrets, context } = input;
    const records = inputs.records ?? inputs.rows;
    if (!Array.isArray(records)) {
      throw new Error("entity_resolve: `inputs.records` must be an array.");
    }
    const inlineCanonical = Array.isArray(config.canonical) ? (config.canonical as CanonicalEntity[]) : undefined;
    const canonicalRaw =
      inlineCanonical ?? (inputs[String(config.canonicalField ?? "canonical")] as CanonicalEntity[] | undefined);
    if (!Array.isArray(canonicalRaw) || canonicalRaw.length === 0) {
      throw new Error(
        "entity_resolve: a canonical list is required (set config.canonical or wire an upstream node into inputs.canonical)."
      );
    }
    const matchFields = Array.isArray(config.matchFields) && config.matchFields.length > 0
      ? (config.matchFields as string[])
      : ["name", "aliases"];
    const mentionField = String(config.mentionField ?? "mention");
    const fuzzyThreshold = Math.max(0, Math.min(1, Number(config.fuzzyThreshold ?? 0.85)));
    const useLlm = config.useLlmFallback === true;

    const resolved: MentionRecord[] = [];
    const unresolved: MentionRecord[] = [];
    const llmCandidates: Array<{ record: MentionRecord; mention: string }> = [];

    for (const record of records as MentionRecord[]) {
      const mentionRaw = record[mentionField];
      const mention = typeof mentionRaw === "string" ? mentionRaw : "";
      if (!mention) {
        unresolved.push(record);
        continue;
      }
      const match = resolveMention(mention, canonicalRaw, matchFields, fuzzyThreshold);
      if (match) {
        resolved.push({
          ...record,
          entityId: match.entity.id,
          entityName: match.entity.name,
          matchScore: match.score,
          matchMethod: match.score === 1 ? "exact" : "fuzzy"
        });
      } else if (useLlm) {
        llmCandidates.push({ record, mention });
      } else {
        unresolved.push(record);
      }
    }

    // LLM fallback: one call per unresolved mention. Bounded by
    // `llmCandidates.length`, which is already the long-tail size.
    if (llmCandidates.length > 0) {
      const providers = buildProviderRegistry();
      const { providerId, model, baseUrl } = resolveChatModel({
        config,
        resolvedValues: context.resolvedConfig.values
      });
      // Compact catalog the model can pick from. Big catalogs should
      // be pre-filtered upstream (this plugin doesn't try to index).
      const catalog = canonicalRaw.slice(0, 200).map((e) => ({ id: e.id, name: e.name, aliases: e.aliases }));
      await mapWithConcurrency(llmCandidates, 4, async ({ record, mention }) => {
        try {
          const result = await chatStructured({
            providers,
            tenantId: context.tenantId,
            providerId,
            model,
            baseUrl,
            apiKey: secrets.apiKey,
            systemPrompt:
              "You match a user-supplied mention to an entry in a catalog. Return ONLY the id of the matching entry, or null if no entry fits.",
            userPrompt:
              `Mention: ${JSON.stringify(mention)}\n\nCatalog (id + name + aliases):\n${JSON.stringify(catalog, null, 2)}`,
            schema: { type: "object", properties: { id: { type: ["string", "null"] } } },
            maxTokens: 64,
            retry: 1
          });
          const id = (result.parsed as { id?: string | null } | null)?.id ?? null;
          const matched = id ? canonicalRaw.find((e) => e.id === id) : undefined;
          if (matched) {
            resolved.push({
              ...record,
              entityId: matched.id,
              entityName: matched.name,
              matchScore: 0.5,
              matchMethod: "llm"
            });
          } else {
            unresolved.push(record);
          }
        } catch {
          unresolved.push(record);
        }
      });
    }

    return { outputs: { records: resolved, unresolved } };
  }
};
