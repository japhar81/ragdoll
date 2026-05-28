/**
 * Email pre-processing transformers. Pure text — no LLM, no I/O — so
 * they're safe in both batch ingest and synchronous pipelines.
 *
 * Generic over message shape: nothing here hardcodes a specific email
 * provider's field names. The pipeline author maps their source schema
 * onto the small generic shape these plugins consume (`text`,
 * `threadKey`, `timestamp`, …) via a preceding `transform` node, then
 * these plugins do the work.
 *
 *   - `email_preprocess` strips quoted-reply chains, signatures, legal
 *     disclaimers, and mobile-client boilerplate from one message's
 *     body; classifies the message as a thread root vs reply; emits
 *     metadata alongside the cleaned text.
 *
 *   - `thread_aggregate` groups a flat list of messages by a thread key,
 *     orders them by timestamp, and emits per-thread documents
 *     suitable for embedding at the thread level (so a retriever can
 *     return whole conversations, not single noisy replies).
 */

import type { InProcessPlugin, JsonSchemaLike } from "../../../../packages/plugin-sdk/src/index.ts";

// ---------------------------------------------------------------------------
// email_preprocess
// ---------------------------------------------------------------------------

/**
 * Lines that begin a quoted-reply block. We're conservative — only the
 * shapes we've actually seen come back from Outlook / Gmail / Apple Mail
 * / Yahoo. Adding too many heuristics here would chew real prose; the
 * downside of a missed boundary is a slightly noisier embedding, the
 * downside of a false positive is dropped content.
 */
const QUOTE_BOUNDARIES: RegExp[] = [
  /^On\s.+?wrote:\s*$/i,
  /^On\s.+?,\s.+?wrote:\s*$/i,
  /^-{2,}\s*Original\s+Message\s*-{2,}/i,
  /^-{2,}\s*Forwarded\s+message\s*-{2,}/i,
  /^From:\s.+/i,
  /^Sent from my (iPhone|iPad|Android|BlackBerry|mobile device)/i,
  /^Get Outlook for (iOS|Android)/i
];

/**
 * Signature heuristics. We strip from the first matching line to the
 * end of the body. Common shapes:
 *   - "--" on its own line (RFC 3676 signature delimiter)
 *   - "Best, <Name>" / "Thanks, <Name>" / "Regards, <Name>"
 *   - "Sent from my iPhone" (also caught above)
 */
const DEFAULT_SIGNATURE_LINES: RegExp[] = [
  /^--\s*$/,
  /^(Best|Thanks|Thank you|Regards|Kind regards|Best regards|Cheers|Sincerely|Warm regards)[,!]?\s*$/i,
  /^(Best|Thanks|Thank you|Regards|Kind regards|Best regards|Cheers|Sincerely),\s.+/i
];

/**
 * Legal-disclaimer markers. Most corporate disclaimers start with a
 * recognisable phrase; we strip from there to the end. Patterns are
 * deliberately narrow — we'd rather miss a disclaimer than truncate
 * real content.
 */
const LEGAL_DISCLAIMERS: RegExp[] = [
  /^CONFIDENTIALITY\s+(NOTICE|NOTE)/i,
  /^This e-?mail (and any attachments )?(is|are) (intended|confidential)/i,
  /^The information contained in this e-?mail/i,
  /^DISCLAIMER:/i,
  /^IMPORTANT:\s+This (e-?mail|message) (is|may contain)/i
];

interface PreprocessResult {
  text: string;
  isReply: boolean;
  language?: string;
  removedLines: number;
}

export function preprocessEmailBody(body: string, opts: {
  stripQuotes?: boolean;
  stripSignatures?: boolean;
  stripDisclaimers?: boolean;
  signatureHeuristics?: RegExp[];
}): PreprocessResult {
  const stripQuotes = opts.stripQuotes !== false;
  const stripSignatures = opts.stripSignatures !== false;
  const stripDisclaimers = opts.stripDisclaimers !== false;
  const signatureLines = opts.signatureHeuristics ?? DEFAULT_SIGNATURE_LINES;

  const sourceLines = body.split(/\r?\n/);
  const totalIn = sourceLines.length;

  let cutoff = sourceLines.length;
  let isReply = false;

  if (stripQuotes) {
    for (let i = 0; i < cutoff; i++) {
      const line = sourceLines[i].trim();
      if (QUOTE_BOUNDARIES.some((re) => re.test(line))) {
        cutoff = i;
        isReply = true;
        break;
      }
    }
  }

  if (stripSignatures) {
    for (let i = 0; i < cutoff; i++) {
      if (signatureLines.some((re) => re.test(sourceLines[i]))) {
        cutoff = i;
        break;
      }
    }
  }

  if (stripDisclaimers) {
    for (let i = 0; i < cutoff; i++) {
      if (LEGAL_DISCLAIMERS.some((re) => re.test(sourceLines[i].trim()))) {
        cutoff = i;
        break;
      }
    }
  }

  let kept = sourceLines.slice(0, cutoff);

  // Strip `>`-prefixed blocks anywhere in the kept body. Some clients
  // (Gmail mobile) inline quoted text without a "On X wrote:" header.
  if (stripQuotes) {
    kept = kept.filter((line) => !/^\s*>+/.test(line));
    // Detect inline-quote markers like ">>" runs as evidence of a reply
    // even when the explicit boundary was absent.
    if (!isReply && sourceLines.some((line) => /^\s*>+/.test(line))) {
      isReply = true;
    }
  }

  // Trim trailing blank lines that often remain after cutoff.
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();

  const text = kept.join("\n");
  return {
    text,
    isReply,
    language: detectLanguage(text),
    removedLines: totalIn - kept.length
  };
}

/**
 * Embarrassingly simple language detector — we look at a handful of
 * high-frequency stopwords in a few languages and return the best
 * match (or undefined when none of them appear). Plenty good for
 * "should we send this to the English-only summariser?". Anything
 * fancier belongs in a dedicated language plugin.
 */
const LANGUAGE_STOPWORDS: Record<string, string[]> = {
  en: ["the", "and", "for", "with", "this", "that", "have", "from"],
  es: ["el", "la", "los", "las", "que", "para", "con", "por"],
  fr: ["le", "la", "les", "que", "pour", "avec", "dans", "est"],
  de: ["der", "die", "das", "und", "für", "mit", "ist", "nicht"],
  pt: ["o", "a", "os", "as", "que", "para", "com", "não"]
};

export function detectLanguage(text: string): string | undefined {
  const words = text.toLowerCase().match(/[a-zA-ZáéíóúñàâçéèêëîïôûüäöüßãõàèìòùÁÉÍÓÚÑ]+/g);
  if (!words || words.length < 5) return undefined;
  let best: { lang: string; hits: number } | undefined;
  for (const [lang, stopwords] of Object.entries(LANGUAGE_STOPWORDS)) {
    let hits = 0;
    for (const word of words) {
      if (stopwords.includes(word)) hits += 1;
    }
    if (!best || hits > best.hits) best = { lang, hits };
  }
  return best && best.hits >= 2 ? best.lang : undefined;
}

const PREPROCESS_INPUT_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    text: { type: "string", description: "The message body to clean." }
  }
};

export const emailPreprocessPlugin: InProcessPlugin = {
  manifest: {
    id: "email_preprocess",
    name: "Email Preprocess",
    version: "1.0.0",
    category: "transformer",
    description:
      "Cleans one message body: strips quoted replies, signatures, legal disclaimers, mobile-client boilerplate. Classifies thread-root vs reply. No LLM — pure text transform.",
    configSchema: {
      type: "object",
      properties: {
        stripQuotes: { type: "boolean", default: true, description: "Strip quoted-reply chains." },
        stripSignatures: { type: "boolean", default: true, description: "Strip trailing signatures." },
        stripDisclaimers: {
          type: "boolean",
          default: true,
          description: "Strip corporate legal disclaimers."
        },
        keepOriginal: {
          type: "boolean",
          default: true,
          description: "When true, the original text is passed through as `originalText`."
        },
        inputField: {
          type: "string",
          default: "text",
          description: "Name of the field on the incoming record holding the body."
        }
      },
      additionalProperties: false
    },
    inputSchema: PREPROCESS_INPUT_SCHEMA,
    inputPorts: [
      {
        name: "text",
        required: true,
        description: "The raw message body (or pass an object with the configured `inputField`)."
      }
    ],
    outputPorts: [
      { name: "text", description: "Cleaned message body." },
      { name: "originalText", description: "The pre-clean body, when keepOriginal is true." },
      { name: "isReply", description: "True when the message looked like a reply." },
      { name: "language", description: "Best-guess language code (en/es/fr/de/pt) or undefined." },
      { name: "removedLines", description: "Number of source lines removed during cleaning." }
    ],
    capabilities: ["transform"],
    ui: {
      icon: "mail",
      color: "#0ea5e9",
      paletteGroup: "Email",
      formHints: {
        stripQuotes: { widget: "checkbox" },
        stripSignatures: { widget: "checkbox" },
        stripDisclaimers: { widget: "checkbox" },
        keepOriginal: { widget: "checkbox" }
      }
    }
  },
  async execute(input) {
    const { inputs, config } = input;
    const inputField = String(config.inputField ?? "text");
    const raw = inputs[inputField] ?? inputs.text;
    if (typeof raw !== "string") {
      throw new Error(`email_preprocess: expected a string on inputs.${inputField}`);
    }
    const result = preprocessEmailBody(raw, {
      stripQuotes: config.stripQuotes !== false,
      stripSignatures: config.stripSignatures !== false,
      stripDisclaimers: config.stripDisclaimers !== false
    });
    const outputs: Record<string, unknown> = {
      text: result.text,
      isReply: result.isReply,
      language: result.language,
      removedLines: result.removedLines
    };
    if (config.keepOriginal !== false) outputs.originalText = raw;
    return { outputs };
  }
};

// ---------------------------------------------------------------------------
// thread_aggregate
// ---------------------------------------------------------------------------

interface MessageRecord {
  [field: string]: unknown;
}

/**
 * Group flat messages into thread-level documents. The pipeline author
 * controls the grouping key and the ordering field via config — we
 * don't hardcode "conversation_id" / "received_at" because not every
 * email source uses those names.
 *
 * Output shape:
 *   - `threads`: array of `{ threadKey, messageCount, firstAt, lastAt,
 *     participants, text, messages }` — one per group.
 *   - `messages`: the original messages, re-tagged with `threadKey`
 *     and `orderInThread` so downstream nodes can keep per-message
 *     processing in addition to per-thread embedding.
 */
export function aggregateThreads(args: {
  rows: MessageRecord[];
  threadKeyField: string;
  orderByField: string;
  textField: string;
  participantField?: string;
  threadJoiner?: string;
}): {
  threads: Array<{
    threadKey: string;
    messageCount: number;
    firstAt?: unknown;
    lastAt?: unknown;
    participants: string[];
    text: string;
    messages: MessageRecord[];
  }>;
  messages: MessageRecord[];
} {
  const joiner = args.threadJoiner ?? "\n\n---\n\n";
  const buckets = new Map<string, MessageRecord[]>();
  for (const row of args.rows) {
    const key = row[args.threadKeyField];
    if (key === undefined || key === null) continue;
    const k = String(key);
    const arr = buckets.get(k) ?? [];
    arr.push(row);
    buckets.set(k, arr);
  }

  const threads: Array<{
    threadKey: string;
    messageCount: number;
    firstAt?: unknown;
    lastAt?: unknown;
    participants: string[];
    text: string;
    messages: MessageRecord[];
  }> = [];
  const taggedMessages: MessageRecord[] = [];

  for (const [threadKey, rows] of buckets.entries()) {
    rows.sort((a, b) => compareOrdering(a[args.orderByField], b[args.orderByField]));
    const messages: MessageRecord[] = rows.map((row, i) => ({
      ...row,
      threadKey,
      orderInThread: i
    }));
    taggedMessages.push(...messages);

    const participants = args.participantField
      ? Array.from(
          new Set(
            messages
              .map((m) => m[args.participantField as string])
              .filter((v): v is string => typeof v === "string" && v.length > 0)
          )
        )
      : [];

    const text = messages
      .map((m) => (typeof m[args.textField] === "string" ? (m[args.textField] as string) : ""))
      .filter((t) => t.length > 0)
      .join(joiner);

    threads.push({
      threadKey,
      messageCount: messages.length,
      firstAt: messages[0]?.[args.orderByField],
      lastAt: messages[messages.length - 1]?.[args.orderByField],
      participants,
      text,
      messages
    });
  }

  // Deterministic order for downstream consumers / tests.
  threads.sort((a, b) => a.threadKey.localeCompare(b.threadKey));
  return { threads, messages: taggedMessages };
}

function compareOrdering(a: unknown, b: unknown): number {
  if (a === undefined || a === null) return 1;
  if (b === undefined || b === null) return -1;
  const ad = typeof a === "string" || typeof a === "number" ? new Date(a as string | number) : (a as Date);
  const bd = typeof b === "string" || typeof b === "number" ? new Date(b as string | number) : (b as Date);
  const at = ad instanceof Date ? ad.getTime() : NaN;
  const bt = bd instanceof Date ? bd.getTime() : NaN;
  if (!Number.isNaN(at) && !Number.isNaN(bt)) return at - bt;
  return String(a).localeCompare(String(b));
}

export const threadAggregatePlugin: InProcessPlugin = {
  manifest: {
    id: "thread_aggregate",
    name: "Thread Aggregate",
    version: "1.0.0",
    category: "transformer",
    description:
      "Groups a flat list of messages by a configurable thread key, orders by a configurable timestamp, and emits thread-level documents alongside per-message records.",
    configSchema: {
      type: "object",
      required: ["threadKeyField", "orderByField"],
      properties: {
        threadKeyField: {
          type: "string",
          description: "Field on each input row holding the thread / conversation id."
        },
        orderByField: {
          type: "string",
          description: "Field on each input row holding the timestamp used for in-thread ordering."
        },
        textField: {
          type: "string",
          default: "text",
          description: "Field holding the per-message body that aggregates into the thread document."
        },
        participantField: {
          type: "string",
          description: "Optional field holding a participant identifier (e.g. sender email)."
        },
        threadJoiner: {
          type: "string",
          default: "\n\n---\n\n",
          description: "Separator inserted between message bodies in the thread document."
        },
        emitThreads: { type: "boolean", default: true, description: "Emit the `threads` output port." },
        emitMessages: { type: "boolean", default: true, description: "Emit the tagged `messages` output port." }
      },
      additionalProperties: false
    },
    inputPorts: [
      {
        name: "rows",
        required: true,
        description: "Flat array of message records to group."
      }
    ],
    outputPorts: [
      { name: "threads", description: "Per-thread documents." },
      { name: "messages", description: "Original messages re-tagged with threadKey + orderInThread." }
    ],
    capabilities: ["transform"],
    ui: {
      icon: "list",
      color: "#0ea5e9",
      paletteGroup: "Email",
      formHints: {
        threadJoiner: { widget: "textarea", rows: 2 },
        emitThreads: { widget: "checkbox" },
        emitMessages: { widget: "checkbox" }
      }
    }
  },
  async execute(input) {
    const { inputs, config } = input;
    const rows = inputs.rows ?? inputs.messages ?? inputs.documents;
    if (!Array.isArray(rows)) {
      throw new Error("thread_aggregate: requires `inputs.rows` to be an array of message records.");
    }
    const threadKeyField = String(config.threadKeyField ?? "");
    const orderByField = String(config.orderByField ?? "");
    if (!threadKeyField || !orderByField) {
      throw new Error(
        "thread_aggregate: `config.threadKeyField` and `config.orderByField` are required."
      );
    }
    const result = aggregateThreads({
      rows: rows as MessageRecord[],
      threadKeyField,
      orderByField,
      textField: String(config.textField ?? "text"),
      participantField: config.participantField ? String(config.participantField) : undefined,
      threadJoiner: config.threadJoiner ? String(config.threadJoiner) : undefined
    });
    const outputs: Record<string, unknown> = {};
    if (config.emitThreads !== false) outputs.threads = result.threads;
    if (config.emitMessages !== false) outputs.messages = result.messages;
    return { outputs };
  }
};
