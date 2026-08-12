/**
 * SSE consumer for POST /api/pipelines/:id/stream.
 *
 * EventSource doesn't support POST (only GET), so we fall back to fetch +
 * a ReadableStream + a tiny SSE parser. The server emits one frame per
 * server-side event with the shape:
 *
 *   event: <name>
 *   data: <json>
 *   (blank line)
 *
 * Frames the server produces today (see app/routes/pipeline-runs.ts):
 *   execution.started  { pipelineId, pipelineVersionId }
 *   token              { nodeId, token }     -- one per provider chunk
 *   execution.completed { executionId, status }
 *   output             { output }
 *   done               { executionId, pipelineId, pipelineVersionId }
 *   execution.failed   { error }
 *   error              { message }
 *
 * Callers pass an `onEvent` listener; the function resolves when the stream
 * closes (server's `done` frame or network drop). To cancel early, wrap the
 * caller in an AbortController and pass `signal`.
 *
 * Why not EventSource:
 *   - EventSource is GET-only and we need a JSON body.
 *   - EventSource auto-reconnects, which we DO NOT want for a one-shot
 *     pipeline run; a second connection would re-trigger the run.
 */

import { buildAuthHeaders } from "./tenantContext.ts";
import { getAuth } from "./api.ts";

export interface StreamEvent {
  event: string;
  data: unknown;
}

export interface StreamRunOptions {
  pipelineId: string;
  body: { input?: unknown; environment?: string; deadlineMs?: number };
  onEvent: (event: StreamEvent) => void;
  signal?: AbortSignal;
}

/**
 * Splits an SSE buffer into frames on the double-newline boundary.
 * Returns the parsed frames + the remainder buffer for the next chunk.
 *
 * Exported for unit testing the parser in isolation; UI code should use
 * `streamRun` below.
 */
export function parseSseFrames(buffer: string): {
  frames: StreamEvent[];
  remainder: string;
} {
  const frames: StreamEvent[] = [];
  let rest = buffer;
  // SSE frame boundary is "\n\n" (CRLF stacks vary, normalize first).
  rest = rest.replace(/\r\n/g, "\n");
  while (true) {
    const idx = rest.indexOf("\n\n");
    if (idx === -1) break;
    const block = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue; // comment
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      // id: / retry: ignored — we don't reconnect
    }
    if (dataLines.length === 0) continue;
    const raw = dataLines.join("\n");
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      // Some events legitimately carry strings; keep the raw text.
    }
    frames.push({ event, data });
  }
  return { frames, remainder: rest };
}

/** Drain an SSE `Response` body, parsing frames and delivering each to
 *  `onEvent`. Shared by every SSE consumer here. Resolves when the stream
 *  closes (server `done` frame or network drop). */
async function consumeSse(
  response: Response,
  onEvent: (event: StreamEvent) => void
): Promise<void> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`stream HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  if (!response.body) {
    throw new Error("stream response has no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, remainder } = parseSseFrames(buffer);
      buffer = remainder;
      for (const frame of frames) onEvent(frame);
    }
    // Flush any trailing decoded text.
    buffer += decoder.decode();
    const { frames } = parseSseFrames(buffer + "\n\n");
    for (const frame of frames) onEvent(frame);
  } finally {
    reader.releaseLock();
  }
}

export async function streamRun(opts: StreamRunOptions): Promise<void> {
  const headers: Record<string, string> = {
    ...buildAuthHeaders(getAuth()),
    "content-type": "application/json",
    accept: "text/event-stream"
  };
  const response = await fetch(
    `/api/pipelines/${encodeURIComponent(opts.pipelineId)}/stream`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body),
      signal: opts.signal
    }
  );
  await consumeSse(response, opts.onEvent);
}

// --- Per-execution result stream (ADR-0037) --------------------------------

/** One streamed step frame as it arrives on the wire. `data` is present for
 *  small bodies; a large body arrives `truncated` (preview + `bytes`) and the
 *  full payload is fetched with {@link fetchStepBody} using `frameId`. */
export interface StepFrame {
  frameId: string;
  nodeId: string;
  channel: string;
  source: "node_output" | "emit";
  seq: number;
  at: string;
  data?: Record<string, unknown>;
  truncated?: boolean;
  bytes?: number;
  preview?: string;
  /** True when delivered from the replay of already-recorded frames. */
  replayed?: boolean;
}

export interface StreamExecutionOptions {
  executionId: string;
  onEvent: (event: StreamEvent) => void;
  signal?: AbortSignal;
}

/**
 * Subscribe to a single execution's live result stream
 * (`GET /api/executions/:id/stream`, ADR-0037). Replays step frames already
 * recorded, then tails live until the run reaches a terminal status. Unlike
 * {@link streamRun} this does NOT start a run — it observes one already
 * enqueued (e.g. via `POST /api/pipelines/:id/run`), so it's safe to
 * reconnect. Resolves when the server sends `done` or the stream drops.
 */
export async function streamExecution(
  opts: StreamExecutionOptions
): Promise<void> {
  const headers: Record<string, string> = {
    ...buildAuthHeaders(getAuth()),
    accept: "text/event-stream"
  };
  const response = await fetch(
    `/api/executions/${encodeURIComponent(opts.executionId)}/stream`,
    { method: "GET", headers, signal: opts.signal }
  );
  await consumeSse(response, opts.onEvent);
}

/**
 * Fetch the full (redacted) body of a streamed step that arrived truncated.
 * Returns the step's `data` object, or throws on a non-2xx / missing frame.
 */
export async function fetchStepBody(
  executionId: string,
  frameId: string
): Promise<Record<string, unknown> | undefined> {
  const response = await fetch(
    `/api/executions/${encodeURIComponent(executionId)}/steps/${encodeURIComponent(frameId)}`,
    { headers: buildAuthHeaders(getAuth()) }
  );
  if (!response.ok) {
    throw new Error(`step HTTP ${response.status}`);
  }
  const json = (await response.json()) as {
    step?: { data?: Record<string, unknown> };
  };
  return json.step?.data;
}
