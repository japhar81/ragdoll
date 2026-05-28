/**
 * Unit tests for the email-RAG plugin family: email_preprocess,
 * thread_aggregate, chunk_contextual, extract_entities, entity_resolve,
 * query_classify, summarize_event, action_status_refresh,
 * tone_profile_build, compose_with_style.
 *
 * Pure-text helpers (preprocessEmailBody, aggregateThreads,
 * fuzzySimilarity, resolveMention, curateExemplars, parseJsonFromModelOutput)
 * are tested directly. LLM-calling plugins are tested with a fetch stub
 * that simulates the provider's wire response — no live API calls.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  // pure helpers
  preprocessEmailBody,
  aggregateThreads,
  detectLanguage,
  fuzzySimilarity,
  resolveMention,
  curateExemplars,
  // LLM-calling plugins
  chunkContextualPlugin,
  extractEntitiesPlugin,
  entityResolvePlugin,
  queryClassifyPlugin,
  summarizeEventPlugin,
  actionStatusRefreshPlugin,
  toneProfileBuildPlugin,
  composeWithStylePlugin,
  // simple plugins
  emailPreprocessPlugin,
  threadAggregatePlugin
} from "../src/index.ts";
import { parseJsonFromModelOutput } from "../src/helpers.ts";
import type { RuntimeContext } from "../../../packages/core/src/index.ts";

function ctx(tenantId = "t1"): RuntimeContext {
  return {
    requestId: "req-1",
    executionId: "exec-1",
    tenantId,
    pipelineId: "pipe-1",
    pipelineVersionId: "v1",
    environment: "test",
    resolvedConfig: {
      pipelineId: "pipe-1",
      pipelineVersionId: "v1",
      tenantId,
      environment: "test",
      values: {},
      violations: []
    }
  };
}

function pluginInput(overrides: {
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
  inputs?: Record<string, unknown>;
}) {
  return {
    context: ctx(),
    node: { id: "n1", plugin: { category: "transformer" as const, id: "x", version: "1.0.0" } },
    inputs: overrides.inputs ?? {},
    config: overrides.config ?? {},
    secrets: overrides.secrets ?? {}
  };
}

/**
 * Multi-shape fetch stub for provider calls. Returns ONE wire body that
 * satisfies OpenAI, Anthropic, and Ollama response parsers
 * simultaneously, so the tests don't care which provider the plugin
 * resolved.
 *
 * NOTE: this only intercepts `globalThis.fetch`. The Ollama adapter
 * uses a separately-imported undici fetch with a custom dispatcher to
 * survive cold-model loads — that import captures a reference at
 * module-load time and bypasses our stub. So the tests force
 * `provider: "openai"` in plugin config; OpenAI's adapter uses the
 * global fetch path and our stub catches it cleanly.
 */
interface StubbedFetch {
  texts: string[];
  calls: Array<{ url: string; body: unknown }>;
}
function stubProviderFetch(t: { after(fn: () => void): void }, texts: string[]): StubbedFetch {
  const state: StubbedFetch = { texts: [...texts], calls: [] };
  const prev = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (
    url: string,
    init?: { method?: string; body?: string }
  ) => {
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(init.body) : undefined;
    } catch {
      body = init?.body;
    }
    state.calls.push({ url, body });
    const text = state.texts.shift() ?? "{}";
    const responseBody = {
      // OpenAI chat-completions shape.
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
      // Anthropic messages shape.
      content: [{ text }],
      // Ollama (even though we don't catch ollama via the global stub,
      // including the field keeps the body shape inert if a test ever
      // does hit a global-fetch-based ollama path).
      message: { content: text },
      model: "stub-model"
    };
    return {
      ok: true,
      status: 200,
      async json() {
        return responseBody;
      },
      async text() {
        return JSON.stringify(responseBody);
      }
    } as unknown as Response;
  };
  t.after(() => {
    (globalThis as { fetch: unknown }).fetch = prev;
  });
  return state;
}

/** Shorthand: build plugin config with provider forced to OpenAI. */
function withOpenAI(config: Record<string, unknown>): Record<string, unknown> {
  return { provider: "openai", model: "gpt-4o-mini", ...config };
}

// ===========================================================================
// email_preprocess + pure helpers
// ===========================================================================

test("preprocessEmailBody: strips quoted reply chain", () => {
  const body = [
    "Yes, that works.",
    "Thanks!",
    "",
    "On Mon, Jan 5, 2026 at 10:00 AM Alice <alice@x.com> wrote:",
    "> Are you free at 2pm?",
    "> > Let's reschedule."
  ].join("\n");
  const result = preprocessEmailBody(body, {});
  assert.equal(result.text.includes("On Mon"), false);
  assert.equal(result.text.includes("Are you free"), false);
  assert.equal(result.isReply, true);
});

test("preprocessEmailBody: strips signatures", () => {
  const body = [
    "Looks good — proceeding tomorrow.",
    "",
    "Best,",
    "Henry",
    "VP Engineering"
  ].join("\n");
  const result = preprocessEmailBody(body, {});
  assert.equal(result.text.includes("Best,"), false);
  assert.equal(result.text.includes("VP Engineering"), false);
  assert.match(result.text, /Looks good/);
});

test("preprocessEmailBody: strips legal disclaimers", () => {
  const body = [
    "Hi team — agreed.",
    "",
    "CONFIDENTIALITY NOTICE: This email contains confidential ..."
  ].join("\n");
  const result = preprocessEmailBody(body, {});
  assert.equal(result.text.includes("CONFIDENTIALITY"), false);
});

test("preprocessEmailBody: keepOriginal passthrough on the plugin", async () => {
  const result = await emailPreprocessPlugin.execute(
    pluginInput({
      inputs: { text: "Hello\n\nOn X wrote:\n> noise" },
      config: { keepOriginal: true }
    })
  );
  assert.equal((result.outputs.text as string).includes("On X"), false);
  assert.equal(result.outputs.originalText, "Hello\n\nOn X wrote:\n> noise");
});

test("preprocessEmailBody: error on non-string input", async () => {
  await assert.rejects(
    emailPreprocessPlugin.execute(pluginInput({ inputs: { text: 42 } })),
    /expected a string/
  );
});

test("detectLanguage: distinguishes English from Spanish", () => {
  assert.equal(detectLanguage("the cat and the dog have a great time with this"), "en");
  assert.equal(detectLanguage("el perro y los gatos que para con por que las"), "es");
  assert.equal(detectLanguage("xyz"), undefined);
});

// ===========================================================================
// thread_aggregate
// ===========================================================================

test("aggregateThreads: groups, orders, emits per-thread + per-message", () => {
  const rows = [
    { id: "m3", convo: "T1", at: "2026-01-01T03:00Z", body: "third", from: "a@x" },
    { id: "m1", convo: "T1", at: "2026-01-01T01:00Z", body: "first", from: "b@x" },
    { id: "m2", convo: "T1", at: "2026-01-01T02:00Z", body: "second", from: "a@x" },
    { id: "n1", convo: "T2", at: "2026-01-02T00:00Z", body: "alpha", from: "c@x" }
  ];
  const { threads, messages } = aggregateThreads({
    rows,
    threadKeyField: "convo",
    orderByField: "at",
    textField: "body",
    participantField: "from"
  });
  assert.equal(threads.length, 2);
  const t1 = threads.find((t) => t.threadKey === "T1");
  assert.ok(t1);
  assert.equal(t1.messageCount, 3);
  assert.match(t1.text, /first[\s\S]*second[\s\S]*third/);
  assert.deepEqual(t1.participants.sort(), ["a@x", "b@x"]);
  // messages are tagged with orderInThread
  const tagged = messages.filter((m) => m.convo === "T1");
  assert.deepEqual(
    tagged.map((m) => [m.id, m.orderInThread]),
    [["m1", 0], ["m2", 1], ["m3", 2]]
  );
});

test("threadAggregatePlugin: requires threadKeyField and orderByField", async () => {
  await assert.rejects(
    threadAggregatePlugin.execute(
      pluginInput({ inputs: { rows: [] }, config: {} })
    ),
    /threadKeyField/
  );
});

test("threadAggregatePlugin: honours emitThreads/emitMessages toggles", async () => {
  const result = await threadAggregatePlugin.execute(
    pluginInput({
      inputs: { rows: [{ k: "x", t: "2026-01-01T00:00Z", text: "y" }] },
      config: { threadKeyField: "k", orderByField: "t", emitMessages: false }
    })
  );
  assert.ok(Array.isArray(result.outputs.threads));
  assert.equal(result.outputs.messages, undefined);
});

// ===========================================================================
// helpers: parseJsonFromModelOutput
// ===========================================================================

test("parseJsonFromModelOutput: bare JSON", () => {
  assert.deepEqual(parseJsonFromModelOutput('{"a":1}'), { a: 1 });
});

test("parseJsonFromModelOutput: fenced code block", () => {
  const raw = "Here you go:\n```json\n{\"answer\":42}\n```\nThanks.";
  assert.deepEqual(parseJsonFromModelOutput(raw), { answer: 42 });
});

test("parseJsonFromModelOutput: balanced object embedded in prose", () => {
  const raw = "Sure — {\"x\": 1, \"y\": {\"z\": 2}} — done.";
  assert.deepEqual(parseJsonFromModelOutput(raw), { x: 1, y: { z: 2 } });
});

test("parseJsonFromModelOutput: throws on unrecoverable junk", () => {
  assert.throws(() => parseJsonFromModelOutput("totally not json"));
});

// ===========================================================================
// chunk_contextual
// ===========================================================================

test("chunk_contextual: prepends generated context to each chunk", async (t) => {
  const stub = stubProviderFetch(t, ["Outage on 2026-01-01 affecting API.", "Recovery during rollback at 02:00."]);
  const result = await chunkContextualPlugin.execute(
    pluginInput({
      inputs: {
        document: "Full incident report …",
        chunks: [{ text: "API returned 500s for ~30 min." }, { text: "Rollback restored normal traffic." }]
      },
      config: withOpenAI({ maxConcurrency: 1 })
    })
  );
  const chunks = result.outputs.chunks as Array<{ contextualText: string; context: string }>;
  assert.equal(chunks.length, 2);
  assert.match(chunks[0].contextualText, /Outage on 2026-01-01/);
  assert.match(chunks[0].contextualText, /API returned 500s/);
  assert.equal(stub.calls.length, 2);
});

test("chunk_contextual: a single failure increments skipped, preserves the chunk", async (t) => {
  // First call returns empty string (treated as skipped); second succeeds.
  stubProviderFetch(t, ["", "ok-context"]);
  const result = await chunkContextualPlugin.execute(
    pluginInput({
      inputs: {
        document: "doc",
        chunks: [{ text: "a" }, { text: "b" }]
      },
      config: withOpenAI({ maxConcurrency: 1 })
    })
  );
  assert.equal(result.outputs.skipped, 1);
  const chunks = result.outputs.chunks as Array<{ contextualText: string }>;
  assert.equal(chunks[0].contextualText, "a");
  assert.match(chunks[1].contextualText, /ok-context/);
});

// ===========================================================================
// extract_entities
// ===========================================================================

test("extract_entities: produces structured records from text", async (t) => {
  stubProviderFetch(t, [
    JSON.stringify({ project: "Atlas", severity: "high" })
  ]);
  const result = await extractEntitiesPlugin.execute(
    pluginInput({
      inputs: { records: [{ id: "m1", text: "Atlas project went down at 3am, sev1." }] },
      config: withOpenAI({
        extractionSchema: { type: "object", properties: { project: {}, severity: {} } },
        idField: "id"
      })
    })
  );
  const records = result.outputs.records as Array<{ project: string; sourceId: unknown }>;
  assert.equal(records.length, 1);
  assert.equal(records[0].project, "Atlas");
  assert.equal(records[0].sourceId, "m1");
});

test("extract_entities: parse failure ends up in failures array, not records", async (t) => {
  // All four attempts (1 + 3 retries-by-default-1 = 2; we set retry:0) return garbage.
  stubProviderFetch(t, ["totally not json", "still garbage"]);
  const result = await extractEntitiesPlugin.execute(
    pluginInput({
      inputs: { records: [{ text: "abc" }] },
      config: withOpenAI({
        extractionSchema: { type: "object" },
        retry: 0
      })
    })
  );
  assert.equal((result.outputs.records as unknown[]).length, 0);
  assert.equal((result.outputs.failures as unknown[]).length, 1);
});

// ===========================================================================
// entity_resolve
// ===========================================================================

test("fuzzySimilarity: identical strings score 1", () => {
  assert.equal(fuzzySimilarity("Atlas", "Atlas"), 1);
});

test("fuzzySimilarity: typo scores high", () => {
  assert.ok(fuzzySimilarity("Atlas", "Altas") > 0.7);
});

test("fuzzySimilarity: disjoint strings score low", () => {
  assert.ok(fuzzySimilarity("Atlas", "Zephyr") < 0.4);
});

test("resolveMention: exact match wins over fuzzy", () => {
  const match = resolveMention(
    "Atlas",
    [
      { id: "1", name: "Atlas", aliases: ["atlas-prod"] },
      { id: "2", name: "Atlass" }
    ],
    ["name", "aliases"],
    0.7
  );
  assert.equal(match?.entity.id, "1");
  assert.equal(match?.score, 1);
});

test("resolveMention: returns undefined when below threshold", () => {
  const match = resolveMention("ZZZ", [{ id: "1", name: "Atlas" }], ["name"], 0.9);
  assert.equal(match, undefined);
});

test("entity_resolve: exact + fuzzy paths populate entityId; unmatched go to unresolved", async (t) => {
  stubProviderFetch(t, []);
  const result = await entityResolvePlugin.execute(
    pluginInput({
      inputs: {
        records: [
          { mention: "Atlas" },
          { mention: "Altas" }, // typo, fuzzy should hit
          { mention: "Quasar" } // not in catalog
        ]
      },
      config: {
        canonical: [{ id: "p1", name: "Atlas" }],
        fuzzyThreshold: 0.7
      }
    })
  );
  const resolved = result.outputs.records as Array<{ entityId: string; matchMethod: string }>;
  const unresolved = result.outputs.unresolved as Array<{ mention: string }>;
  assert.equal(resolved.length, 2);
  assert.deepEqual(
    resolved.map((r) => r.matchMethod),
    ["exact", "fuzzy"]
  );
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].mention, "Quasar");
});

// ===========================================================================
// query_classify
// ===========================================================================

test("query_classify: emits args + confidence + lowConfidence flag", async (t) => {
  stubProviderFetch(t, [
    JSON.stringify({ args: { project: "Atlas", n: 3 }, confidence: 0.9 })
  ]);
  const result = await queryClassifyPlugin.execute(
    pluginInput({
      inputs: { question: "Last 3 outages for Atlas" },
      config: withOpenAI({
        targetSchema: { type: "object", properties: { project: {}, n: {} } },
        confidenceThreshold: 0.7
      })
    })
  );
  assert.deepEqual(result.outputs.args, { project: "Atlas", n: 3 });
  assert.equal(result.outputs.confidence, 0.9);
  assert.equal(result.outputs.lowConfidence, false);
});

test("query_classify: lowConfidence true when confidence < threshold", async (t) => {
  stubProviderFetch(t, [JSON.stringify({ args: {}, confidence: 0.3 })]);
  const result = await queryClassifyPlugin.execute(
    pluginInput({
      inputs: { question: "garbled" },
      config: withOpenAI({ targetSchema: { type: "object" }, confidenceThreshold: 0.6 })
    })
  );
  assert.equal(result.outputs.lowConfidence, true);
});

// ===========================================================================
// summarize_event
// ===========================================================================

test("summarize_event: ungrouped emits a single summary", async (t) => {
  stubProviderFetch(t, [
    JSON.stringify({ cause: "deploy bug", timeline: "30 min" })
  ]);
  const result = await summarizeEventPlugin.execute(
    pluginInput({
      inputs: { rows: [{ id: 1, project: "Atlas" }] },
      config: withOpenAI({ summarySchema: { type: "object" } })
    })
  );
  const summaries = result.outputs.summaries as unknown[];
  assert.equal(summaries.length, 1);
});

test("summarize_event: groupByField emits N summaries tagged with the key", async (t) => {
  stubProviderFetch(t, [
    JSON.stringify({ what: "A summary" }),
    JSON.stringify({ what: "B summary" })
  ]);
  const result = await summarizeEventPlugin.execute(
    pluginInput({
      inputs: {
        rows: [
          { project: "A", x: 1 },
          { project: "A", x: 2 },
          { project: "B", x: 3 }
        ]
      },
      config: withOpenAI({ summarySchema: { type: "object" }, groupByField: "project", maxConcurrency: 1 })
    })
  );
  const summaries = result.outputs.summaries as Array<{ groupKey: string; what: string }>;
  assert.equal(summaries.length, 2);
  assert.deepEqual(summaries.map((s) => s.groupKey).sort(), ["A", "B"]);
});

// ===========================================================================
// action_status_refresh
// ===========================================================================

test("action_status_refresh: updates status from the thread", async (t) => {
  stubProviderFetch(t, [JSON.stringify({ status: "resolved", evidence: "shipped it" })]);
  const result = await actionStatusRefreshPlugin.execute(
    pluginInput({
      inputs: {
        records: [{ id: "r1", item: "Ship the docs", thread: "Done — merged.", status: "open" }]
      },
      config: withOpenAI({ maxConcurrency: 1 })
    })
  );
  const records = result.outputs.records as Array<{ status: string; statusEvidence: string }>;
  assert.equal(records[0].status, "resolved");
  assert.equal(records[0].statusEvidence, "shipped it");
  assert.equal(result.outputs.updated, 1);
});

test("action_status_refresh: parse failure preserves the original record", async (t) => {
  stubProviderFetch(t, ["junk", "still junk"]);
  const result = await actionStatusRefreshPlugin.execute(
    pluginInput({
      inputs: { records: [{ id: "r1", item: "x", thread: "y", status: "open" }] },
      config: withOpenAI({ maxConcurrency: 1 })
    })
  );
  const records = result.outputs.records as Array<{ status: string }>;
  assert.equal(records[0].status, "open");
  assert.equal(result.outputs.updated, 0);
});

// ===========================================================================
// tone_profile_build + curateExemplars
// ===========================================================================

test("curateExemplars: filters by length, dedupes, picks top sampleSize", () => {
  const messages = [
    { text: "x" }, // too short
    { text: "y".repeat(2000) }, // too long
    { text: "A reasonable-length message with some variety in punctuation. Indeed!" },
    { text: "Another reasonably-sized note, with varied diction and tone. Right?" },
    { text: "A reasonable-length message with some variety in punctuation. Indeed!" } // dupe
  ];
  const out = curateExemplars({
    messages,
    textField: "text",
    sampleSize: 3,
    minChars: 30,
    maxChars: 200
  });
  assert.equal(out.length, 2);
});

test("tone_profile_build: builds exemplars + style guide via one provider call", async (t) => {
  const stub = stubProviderFetch(t, ["Style: warm, concise, ends with a question."]);
  const result = await toneProfileBuildPlugin.execute(
    pluginInput({
      inputs: {
        messages: [
          { text: "A reasonably-long sample message with varied punctuation. Right?" },
          { text: "Another reasonably-sized one with different diction! Indeed." },
          { text: "Third sample carrying enough length to pass the curator gate." }
        ]
      },
      config: withOpenAI({ sampleSize: 3 })
    })
  );
  assert.equal((result.outputs.exemplars as unknown[]).length, 3);
  assert.equal(result.outputs.styleGuide, "Style: warm, concise, ends with a question.");
  // Exactly one chat call regardless of exemplar count.
  assert.equal(stub.calls.length, 1);
});

test("tone_profile_build: empty input is a no-op (no provider call)", async (t) => {
  const stub = stubProviderFetch(t, []);
  const result = await toneProfileBuildPlugin.execute(
    pluginInput({ inputs: { messages: [{ text: "x" }] }, config: withOpenAI({ minChars: 30 }) })
  );
  assert.equal(result.outputs.sampleCount, 0);
  assert.equal(stub.calls.length, 0);
});

// ===========================================================================
// compose_with_style
// ===========================================================================

test("compose_with_style: composes a draft from style guide + thread; flags uncertain on small exemplar set", async (t) => {
  stubProviderFetch(t, ["Sure, that works for me — talk later."]);
  const result = await composeWithStylePlugin.execute(
    pluginInput({
      inputs: {
        styleGuide: "Warm, concise, casual punctuation.",
        exemplars: [{ text: "Sounds good!" }],
        thread: "Can you make the 3pm sync?"
      },
      config: withOpenAI({})
    })
  );
  assert.match(result.outputs.draft as string, /low-confidence draft/);
  assert.match(result.outputs.draft as string, /Sure, that works/);
  assert.equal(result.outputs.uncertain, true);
});

test("compose_with_style: requires styleGuide and thread", async (t) => {
  stubProviderFetch(t, []);
  await assert.rejects(
    composeWithStylePlugin.execute(
      pluginInput({ inputs: { styleGuide: "x" }, config: withOpenAI({}) })
    ),
    /styleGuide.*thread.*required|thread.*required/i
  );
});

// ===========================================================================
// Manifest categorisation — guards against accidental contract drift.
// ===========================================================================

test("manifest categorisation: every new plugin slots into the correct category", () => {
  const cases: Array<[string, string]> = [
    [emailPreprocessPlugin.manifest.id, emailPreprocessPlugin.manifest.category],
    [threadAggregatePlugin.manifest.id, threadAggregatePlugin.manifest.category],
    [chunkContextualPlugin.manifest.id, chunkContextualPlugin.manifest.category],
    [extractEntitiesPlugin.manifest.id, extractEntitiesPlugin.manifest.category],
    [entityResolvePlugin.manifest.id, entityResolvePlugin.manifest.category],
    [queryClassifyPlugin.manifest.id, queryClassifyPlugin.manifest.category],
    [summarizeEventPlugin.manifest.id, summarizeEventPlugin.manifest.category],
    [actionStatusRefreshPlugin.manifest.id, actionStatusRefreshPlugin.manifest.category],
    [toneProfileBuildPlugin.manifest.id, toneProfileBuildPlugin.manifest.category],
    [composeWithStylePlugin.manifest.id, composeWithStylePlugin.manifest.category]
  ];
  const expected: Record<string, string> = {
    email_preprocess: "transformer",
    thread_aggregate: "transformer",
    chunk_contextual: "chunker",
    extract_entities: "transformer",
    entity_resolve: "transformer",
    query_classify: "transformer",
    summarize_event: "transformer",
    action_status_refresh: "transformer",
    tone_profile_build: "transformer",
    compose_with_style: "llm"
  };
  for (const [id, category] of cases) {
    assert.equal(category, expected[id], `${id} should be ${expected[id]}, got ${category}`);
  }
});

test("manifest categorisation: sync-capable plugins advertise the `synchronous` capability", () => {
  for (const p of [queryClassifyPlugin, summarizeEventPlugin, actionStatusRefreshPlugin, composeWithStylePlugin]) {
    assert.ok(
      p.manifest.capabilities?.includes("synchronous"),
      `${p.manifest.id} should advertise synchronous capability`
    );
  }
});
