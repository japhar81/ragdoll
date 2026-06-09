/**
 * Live tail of `execution.*` events for the Executions screen.
 *
 * Reuses the visual + layout primitives from BuilderConsole (collapsible,
 * resizable, copy-all, clear), but its event stream is the WebSocket
 * (EventsProvider) — every event the signed-in user is authorized to see,
 * aggregated across every running pipeline AND every worker, since they
 * all publish onto the same change bus that the API fans out.
 */
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useChangeEvents } from "../events/EventsProvider.tsx";
import {
  appendEntry,
  emptyConsole,
  type ConsoleState,
  type LogEntry
} from "../lib/consoleLog.ts";
import { api } from "../lib/api.ts";
import {
  entryForEvent,
  backfillEntries
} from "./executionsConsoleEntries.ts";

type Action =
  | { type: "append"; entry: Omit<LogEntry, "id" | "ts"> & { ts?: number } }
  | { type: "clear" };

function reducer(state: ConsoleState, action: Action): ConsoleState {
  if (action.type === "clear") return emptyConsole();
  return appendEntry(state, action.entry);
}

// entryForEvent + backfillEntries live in ./executionsConsoleEntries.ts
// so node --test (which strips .ts but rejects .tsx) can unit-test them.
// See apps/web/test/executionsConsole.test.ts.

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(
    d.getMilliseconds(),
    3
  )}`;
}

function detailText(detail: unknown): string {
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

function ConsoleRow(props: {
  entry: LogEntry;
  onJumpToExecution?: (executionId: string) => void;
}) {
  const { entry } = props;
  const [open, setOpen] = useState(false);
  const hasDetail =
    entry.detail !== undefined && entry.detail !== null && entry.detail !== "";
  // Read the FULL execution UUID from the detail payload. Every entry
  // produced by entryForEvent / backfillEntries stamps this field. We
  // intentionally do NOT fall back to a regex over the label — the
  // label only carries the 8-char prefix for readability, and feeding
  // that short id into /api/executions/:id/trace 404s (bug 1).
  const execId = (entry.detail as { executionId?: string } | undefined)?.executionId;
  return (
    <li className={`console-row console-${entry.level}`}>
      <button
        type="button"
        className="console-line"
        onClick={() => hasDetail && setOpen((v) => !v)}
        style={{ cursor: hasDetail ? "pointer" : "default" }}
        title={hasDetail ? "Click to expand details" : undefined}
      >
        <span className="console-time">{fmtTime(entry.ts)}</span>
        <span className={`console-level lvl-${entry.level}`}>{entry.level}</span>
        <span className="console-label">{entry.label}</span>
        {execId && props.onJumpToExecution && (
          <span
            className="console-badge"
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              props.onJumpToExecution!(execId);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                props.onJumpToExecution!(execId);
              }
            }}
            title="Open this execution's trace"
            style={{ cursor: "pointer" }}
          >
            jump
          </span>
        )}
        {hasDetail && <span className="console-caret">{open ? "▾" : "▸"}</span>}
      </button>
      {hasDetail && open && (
        <pre className="console-detail">{detailText(entry.detail)}</pre>
      )}
    </li>
  );
}

const MAX_ENTRIES = 500;

/** Trim the entry list from the front so a long-running session
 *  doesn't grow unbounded. We keep the most recent MAX_ENTRIES rows
 *  — older history lives in /audit + each execution's trace. */
function capEntries(state: ConsoleState): ConsoleState {
  if (state.entries.length <= MAX_ENTRIES) return state;
  return {
    entries: state.entries.slice(state.entries.length - MAX_ENTRIES),
    seq: state.seq
  };
}

/**
 * The live-tail panel.
 *
 * Optional `onJumpToExecution` lets the parent select a row in the
 * grid when the user clicks the `jump` badge on an event line.
 *
 * Optional `scopeExecutionId` puts the console into focused mode (Bug 2
 * fix): the entry stream is filtered to ONLY that execution AND the
 * console seeds itself with the run's historical trace so the user
 * sees the full story of the run (pre-jump events included) instead
 * of an empty panel waiting for the next live event. When the prop
 * clears, the console returns to the global "everything I'm authorized
 * to see" view.
 */
export function ExecutionsConsole(props: {
  onJumpToExecution?: (executionId: string) => void;
  scopeExecutionId?: string;
}) {
  const [state, dispatch] = useReducer(
    (s: ConsoleState, a: Action) => capEntries(reducer(s, a)),
    undefined,
    emptyConsole
  );
  const [collapsed, setCollapsed] = useState(false);
  const [height, setHeight] = useState(220);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const listRef = useRef<HTMLUListElement | null>(null);
  const lastCount = useRef(0);
  // Closure-captured ref so the WS subscriber sees the latest scope
  // (matches the pausedRef pattern — useChangeEvents holds its
  // callback for the subscription's lifetime).
  const scopeRef = useRef<string | undefined>(props.scopeExecutionId);
  scopeRef.current = props.scopeExecutionId;

  // Scope change: clear current entries, then (when scope is set)
  // backfill from the execution's recorded trace so the panel shows
  // the run's full history before live events start arriving.
  useEffect(() => {
    const scope = props.scopeExecutionId;
    dispatch({ type: "clear" });
    if (!scope) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getExecutionTrace(scope);
        if (cancelled) return;
        const seeds = backfillEntries({
          executionId: scope,
          execution: data.execution,
          nodes: data.nodes ?? []
        });
        for (const entry of seeds) dispatch({ type: "append", entry });
      } catch {
        // Don't poison the panel on a failed backfill — live events
        // for the same execution will still stream in normally.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.scopeExecutionId]);

  useChangeEvents((event) => {
    if (pausedRef.current) return;
    // Bug 2: when a specific execution is selected, suppress every
    // event for OTHER executions so the panel stays focused on the
    // run the user is investigating.
    if (scopeRef.current && event.targetId !== scopeRef.current) return;
    const entry = entryForEvent(event);
    if (entry) dispatch({ type: "append", entry });
  });

  useEffect(() => {
    if (collapsed) return;
    if (state.entries.length !== lastCount.current) {
      lastCount.current = state.entries.length;
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [state.entries.length, collapsed]);

  const startResize = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const startY = event.clientY;
      const startH = height;
      const move = (ev: MouseEvent) => {
        const next = startH + (startY - ev.clientY);
        setHeight(Math.round(Math.min(560, Math.max(120, next))));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [height]
  );

  const copyAll = useCallback(() => {
    const text = state.entries
      .map((e) => {
        const d =
          e.detail !== undefined && e.detail !== null && e.detail !== ""
            ? `\n${detailText(e.detail)}`
            : "";
        return `${fmtTime(e.ts)} ${e.level.toUpperCase()} ${e.label}${d}`;
      })
      .join("\n");
    void navigator.clipboard?.writeText(text);
  }, [state.entries]);

  const errors = useMemo(
    () => state.entries.filter((e) => e.level === "error").length,
    [state.entries]
  );

  return (
    <section
      className={`builder-console exec-console${collapsed ? " collapsed" : ""}`}
      style={collapsed ? undefined : { height }}
    >
      {!collapsed && (
        <div
          className="console-resizer"
          onMouseDown={startResize}
          role="separator"
          aria-orientation="horizontal"
          title="Drag to resize the console"
        />
      )}
      <header className="console-head">
        <button
          type="button"
          className="console-toggle"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? "Expand console" : "Collapse console"}
        >
          {collapsed ? "▸" : "▾"} Live tail
        </button>
        <span className="console-count">
          {state.entries.length} entr{state.entries.length === 1 ? "y" : "ies"}
          {errors > 0
            ? ` · ${errors} error${errors === 1 ? "" : "s"}`
            : ""}
        </span>
        <span className="console-spacer" />
        <button
          type="button"
          onClick={() => setPaused((v) => !v)}
          title={paused ? "Resume live updates" : "Pause live updates"}
        >
          {paused ? "Resume" : "Pause"}
        </button>
        <button
          type="button"
          onClick={copyAll}
          disabled={state.entries.length === 0}
        >
          Copy all
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: "clear" })}
          disabled={state.entries.length === 0}
        >
          Clear
        </button>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? "Expand" : "Collapse"}
        </button>
      </header>
      {!collapsed && (
        <ul className="console-list" ref={listRef}>
          {state.entries.length === 0 && (
            <li className="console-row console-info">
              <span className="console-label muted">
                Waiting for execution events… Start a pipeline to see live
                progress here.
              </span>
            </li>
          )}
          {state.entries.map((e) => (
            <ConsoleRow
              key={e.id}
              entry={e}
              onJumpToExecution={props.onJumpToExecution}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Optional helper export — gives a Pipelines screen / dashboard a
 *  one-line way to deep-link to the Executions screen + select a
 *  row. Not used internally; exported because callers asked for it. */
export function useExecutionsNavigator(): (executionId: string) => void {
  const navigate = useNavigate();
  return useCallback(
    (executionId: string) => {
      navigate(`/executions?selected=${encodeURIComponent(executionId)}`);
    },
    [navigate]
  );
}
