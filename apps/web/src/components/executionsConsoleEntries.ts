/**
 * Pure, DOM-free helpers extracted from ExecutionsConsole.tsx so they
 * can be unit-tested with node --test (which strips types from .ts
 * files but rejects .tsx).
 *
 * Two responsibilities:
 *   - entryForEvent: turn a `ChangeEvent` into a console row, with the
 *     FULL execution UUID stamped into `detail.executionId` (fix for
 *     bug 1 — the previous label-regex fallback only got the 8-char
 *     prefix, which 404'd the trace API).
 *   - backfillEntries: synthesize a row sequence from a historical
 *     trace document so the live tail shows the full story when a
 *     user jumps into a finished run (bug 2).
 */

import type { LogEntry, LogLevel } from "../lib/consoleLog.ts";
import type { ChangeEvent } from "../../../../packages/events/src/index.ts";

export function entryForEvent(
  event: ChangeEvent
): Omit<LogEntry, "id" | "ts"> | null {
  if (!event.action.startsWith("execution.")) return null;
  const exec = event.targetId.slice(0, 8);
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const status = String(payload.status ?? "");
  const nodeId = payload.nodeId ? String(payload.nodeId) : undefined;
  const error = payload.error ? String(payload.error) : undefined;
  // Merge the full execution id into the detail so consumers can read
  // it reliably — `executionId` wins over any same-key field in the
  // payload (paranoid: payloads shouldn't carry their own executionId
  // since it's already on the ChangeEvent at .targetId).
  const detail = { ...payload, executionId: event.targetId };
  switch (event.action) {
    case "execution.started":
      return {
        level: "info",
        label: `▶ ${exec} started`,
        http: { method: "", path: "" },
        detail
      };
    case "execution.node.started":
      return {
        level: "info",
        label: `  · ${exec} ${nodeId ?? "?"} running`,
        detail
      };
    case "execution.node.completed": {
      const lvl: LogLevel = status === "failed" ? "error" : "success";
      return {
        level: lvl,
        label: `  · ${exec} ${nodeId ?? "?"} ${status || "completed"}`,
        detail
      };
    }
    case "execution.completed":
      return {
        level: "success",
        label: `✓ ${exec} succeeded`,
        detail
      };
    case "execution.failed":
      return {
        level: "error",
        label: `✗ ${exec} failed${error ? `: ${error.slice(0, 200)}` : ""}`,
        detail
      };
    case "execution.denied":
      return {
        level: "error",
        label: `✗ ${exec} denied`,
        detail
      };
    case "execution.updated":
      // Skip noisy intermediates — completed/failed cover the terminal
      // states and node.* covers per-step progress.
      return null;
    default:
      return null;
  }
}

export function backfillEntries(args: {
  executionId: string;
  execution: { startedAt?: string; completedAt?: string | null; status: string; error?: string | null };
  nodes: Array<{
    nodeId: string;
    status: string;
    startedAt?: string;
    completedAt?: string | null;
    latencyMs?: number;
    error?: string | null;
  }>;
}): Array<Omit<LogEntry, "id" | "ts"> & { ts?: number }> {
  const exec = args.executionId.slice(0, 8);
  const out: Array<Omit<LogEntry, "id" | "ts"> & { ts?: number }> = [];
  const detailBase = { executionId: args.executionId };
  const startedTs = args.execution.startedAt
    ? Date.parse(args.execution.startedAt)
    : undefined;
  out.push({
    level: "info",
    label: `▶ ${exec} started`,
    http: { method: "", path: "" },
    detail: { ...detailBase, startedAt: args.execution.startedAt },
    ts: startedTs
  });
  for (const n of args.nodes) {
    const nodeStartedTs = n.startedAt ? Date.parse(n.startedAt) : undefined;
    const nodeCompletedTs = n.completedAt ? Date.parse(n.completedAt) : undefined;
    out.push({
      level: "info",
      label: `  · ${exec} ${n.nodeId} running`,
      detail: { ...detailBase, nodeId: n.nodeId, status: "running" },
      ts: nodeStartedTs
    });
    const lvl: LogLevel =
      n.status === "failed" ? "error" : n.status === "skipped" ? "warn" : "success";
    out.push({
      level: lvl,
      label: `  · ${exec} ${n.nodeId} ${n.status}${
        n.latencyMs !== undefined ? ` (${Math.round(n.latencyMs)}ms)` : ""
      }`,
      detail: {
        ...detailBase,
        nodeId: n.nodeId,
        status: n.status,
        latencyMs: n.latencyMs,
        error: n.error ?? undefined
      },
      ts: nodeCompletedTs
    });
  }
  const completedTs = args.execution.completedAt
    ? Date.parse(args.execution.completedAt)
    : undefined;
  if (args.execution.status === "succeeded") {
    out.push({
      level: "success",
      label: `✓ ${exec} succeeded`,
      detail: { ...detailBase, status: "succeeded" },
      ts: completedTs
    });
  } else if (args.execution.status === "failed") {
    out.push({
      level: "error",
      label: `✗ ${exec} failed${
        args.execution.error ? `: ${args.execution.error.slice(0, 200)}` : ""
      }`,
      detail: { ...detailBase, status: "failed", error: args.execution.error },
      ts: completedTs
    });
  } else if (args.execution.status === "denied") {
    out.push({
      level: "error",
      label: `✗ ${exec} denied`,
      detail: { ...detailBase, status: "denied" },
      ts: completedTs
    });
  }
  // Non-terminal (running / cancelled mid-flight) — no bookend; live
  // events will fill it in as they arrive.
  return out;
}
