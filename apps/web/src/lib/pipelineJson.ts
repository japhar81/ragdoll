/**
 * Pure helpers for the Builder's JSON view. DOM-free / editor-free so the web
 * test runner (node:test, no jsdom) can exercise them directly — the CodeMirror
 * component that consumes them can't be loaded under the runner.
 *
 * Three jobs:
 *   - (de)serialise a pipeline spec ↔ pretty JSON text;
 *   - locate a validator issue's node in the raw text, so the same
 *     `validatePipelineSpec` errors/warnings the visual builder shows can be
 *     painted as INLINE markers on the JSON (the validator keys issues by
 *     nodeId / edge, not by text offset);
 *   - detect what the caret is completing (a connection slug or a plugin id),
 *     so autocomplete can offer the right list.
 */
import type { PipelineSpec } from "./types.ts";
import type { ValidationIssue } from "../../../../packages/pipeline-spec/src/index.ts";

/** Canonical pretty-print used everywhere the spec is shown as JSON. */
export function specToPrettyJson(spec: unknown): string {
  return JSON.stringify(spec, null, 2);
}

export type ParsePipelineResult =
  | { ok: true; spec: PipelineSpec }
  | { ok: false; error: string };

/**
 * Parse editor text into a pipeline spec. Only guarantees valid JSON of the
 * right SHAPE (an object with a `spec` block) — semantic validation is the
 * caller's job via `validatePipelineSpec`, exactly as the visual builder does.
 */
export function parsePipelineJson(text: string): ParsePipelineResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "pipeline must be a JSON object" };
  }
  if (!("spec" in parsed) || typeof (parsed as { spec?: unknown }).spec !== "object") {
    return { ok: false, error: 'missing a "spec" object (expected { metadata?, spec: { nodes, edges } })' };
  }
  return { ok: true, spec: parsed as PipelineSpec };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface IssueRange {
  /** Absolute char offset of the start of the anchored line. */
  from: number;
  /** Absolute char offset of the end of the anchored line. */
  to: number;
  severity: "error" | "warning";
  message: string;
  code: string;
}

/**
 * Anchor each validator issue to a line range in `text`.
 *
 * Node ids are unique, so we find the node's `"id": "<nodeId>"` declaration and
 * mark that whole line. Edge issues anchor to their `from` endpoint's node.
 * Anything we can't locate (or issues with neither) anchors to line 1 so it is
 * never silently dropped.
 */
export function issuesToRanges(text: string, issues: ValidationIssue[]): IssueRange[] {
  const firstLineEnd = text.indexOf("\n");
  const wholeFirstLine = { from: 0, to: firstLineEnd === -1 ? text.length : firstLineEnd };
  return issues.map((issue) => {
    const anchorId = issue.nodeId ?? issue.edge?.from;
    const range = anchorId ? findNodeIdLine(text, anchorId) : null;
    const { from, to } = range ?? wholeFirstLine;
    return {
      from,
      to,
      severity: issue.level,
      message: issue.message,
      code: issue.code
    };
  });
}

/** Line range of a node's `"id": "<nodeId>"` declaration, or null if absent. */
export function findNodeIdLine(text: string, nodeId: string): { from: number; to: number } | null {
  const re = new RegExp(`"id"\\s*:\\s*"${escapeRegExp(nodeId)}"`);
  const m = re.exec(text);
  if (!m) return null;
  const from = text.lastIndexOf("\n", m.index) + 1; // 0 when on the first line
  const nl = text.indexOf("\n", m.index);
  return { from, to: nl === -1 ? text.length : nl };
}

export type CompletionKind = "connection" | "pluginId";

export interface CompletionTarget {
  kind: CompletionKind;
  /** Absolute offset where the value being completed starts (after the `"`). */
  from: number;
}

/**
 * Given the document text UP TO the caret, decide whether the caret sits inside
 * a value we can complete:
 *   - inside a `"slug": "…"` value → connection slugs (the add-a-connection
 *     patch flow);
 *   - inside a `"id": "…"` value that follows a `"plugin"` key → plugin ids.
 * Returns null otherwise. `from` is where the already-typed partial value began.
 */
export function detectCompletion(prefix: string): CompletionTarget | null {
  const slug = /"slug"\s*:\s*"([^"\n]*)$/.exec(prefix);
  if (slug) {
    return { kind: "connection", from: prefix.length - slug[1].length };
  }
  const id = /"id"\s*:\s*"([^"\n]*)$/.exec(prefix);
  if (id) {
    // Only a plugin id, not a node id: require a nearby preceding `"plugin"`
    // key (the block is `"plugin": { "id": "…" }`, usually within ~200 chars).
    const window = prefix.slice(Math.max(0, id.index - 200), id.index);
    if (/"plugin"\s*:\s*\{[^}]*$/.test(window + prefix.slice(id.index, id.index + 1))) {
      return { kind: "pluginId", from: prefix.length - id[1].length };
    }
    if (/"plugin"\s*:/.test(window)) {
      return { kind: "pluginId", from: prefix.length - id[1].length };
    }
  }
  return null;
}
