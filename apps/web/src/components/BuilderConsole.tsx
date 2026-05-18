/**
 * The Builder's bottom Console: a single logging hook (`useConsoleLog`) plus
 * the docked, collapsible/resizable panel that renders the log.
 *
 * Pure formatting/state lives in ../lib/consoleLog.ts (unit-tested); this
 * file is the React/DOM glue only.
 */
import React, { useCallback, useMemo, useReducer, useRef, useState } from "react";
import {
  appendEntry,
  describeError,
  emptyConsole,
  formatApiError,
  redact,
  summarizeRequest,
  type ConsoleState,
  type LogEntry,
  type LogLevel
} from "../lib/consoleLog.ts";

type Action =
  | { type: "append"; entry: Omit<LogEntry, "id" | "ts"> }
  | { type: "clear" };

function reducer(state: ConsoleState, action: Action): ConsoleState {
  if (action.type === "clear") return emptyConsole();
  return appendEntry(state, action.entry);
}

export interface ConsoleLog {
  entries: LogEntry[];
  clear: () => void;
  /** Free-form line at an explicit level (used for guards / local notes). */
  log: (level: LogLevel, label: string, detail?: unknown) => void;
  /** "→ request" line: method + path + redacted body summary. */
  request: (method: string, path: string, body?: unknown) => void;
  /** "← result" line: success level, status badge, response body detail. */
  result: (label: string, status: number, body: unknown) => void;
  /** Error line from any thrown value (ApiError / network / unknown). */
  failure: (label: string, error: unknown, http?: { method: string; path: string }) => void;
}

/**
 * The one logging entry point every Builder action routes through. Replaces
 * the old inspector `report`/`reportError` + `<pre>{log}</pre>`.
 */
export function useConsoleLog(): ConsoleLog {
  const [state, dispatch] = useReducer(reducer, undefined, emptyConsole);

  const log = useCallback(
    (level: LogLevel, label: string, detail?: unknown) =>
      dispatch({ type: "append", entry: { level, label, detail } }),
    []
  );

  const request = useCallback((method: string, path: string, body?: unknown) => {
    dispatch({
      type: "append",
      entry: {
        level: "info",
        label: `→ ${summarizeRequest(body)}`,
        http: { method, path },
        detail: { request: redact(body) }
      }
    });
  }, []);

  const result = useCallback((label: string, status: number, body: unknown) => {
    dispatch({
      type: "append",
      entry: {
        level: status >= 200 && status < 400 ? "success" : "warn",
        label: `← ${label}`,
        http: { method: "", path: "", status },
        detail: body
      }
    });
  }, []);

  const failure = useCallback(
    (label: string, error: unknown, http?: { method: string; path: string }) => {
      const f = formatApiError(error);
      dispatch({
        type: "append",
        entry: {
          level: "error",
          label: `${label}: ${describeError(f)}`,
          http: http
            ? { method: http.method, path: http.path, status: f.status }
            : f.status !== undefined
              ? { method: "", path: "", status: f.status }
              : undefined,
          detail: {
            kind: f.kind,
            status: f.status,
            code: f.code,
            message: f.message,
            issues: f.issues
          }
        }
      });
    },
    []
  );

  const clear = useCallback(() => dispatch({ type: "clear" }), []);

  return useMemo(
    () => ({ entries: state.entries, clear, log, request, result, failure }),
    [state.entries, clear, log, request, result, failure]
  );
}

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

function ConsoleRow(props: { entry: LogEntry }) {
  const { entry } = props;
  const [open, setOpen] = useState(false);
  const hasDetail =
    entry.detail !== undefined && entry.detail !== null && entry.detail !== "";
  const badge = entry.http;
  const badgeText =
    badge && (badge.method || badge.status !== undefined)
      ? `${badge.method}${badge.method && badge.status !== undefined ? " " : ""}${
          badge.status !== undefined ? badge.status : ""
        }`.trim()
      : undefined;
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
        {badgeText && <span className="console-badge">{badgeText}</span>}
        <span className="console-label">{entry.label}</span>
        {hasDetail && <span className="console-caret">{open ? "▾" : "▸"}</span>}
      </button>
      {hasDetail && open && <pre className="console-detail">{detailText(entry.detail)}</pre>}
    </li>
  );
}

/**
 * Docked console panel. Lives in the builder grid (its own row) so the canvas
 * shrinks instead of the page scrolling. Collapsible + height-resizable via a
 * top drag handle. The parent renders it full-width below canvas+inspector.
 */
export function BuilderConsole(props: { log: ConsoleLog }) {
  const { entries, clear } = props.log;
  const [collapsed, setCollapsed] = useState(false);
  const [height, setHeight] = useState(200);
  const listRef = useRef<HTMLUListElement | null>(null);
  const lastCount = useRef(0);

  // Auto-scroll to newest while expanded and a new entry arrived.
  React.useEffect(() => {
    if (collapsed) return;
    if (entries.length !== lastCount.current) {
      lastCount.current = entries.length;
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [entries.length, collapsed]);

  const startResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startH = height;
    const move = (ev: MouseEvent) => {
      const next = startH + (startY - ev.clientY);
      setHeight(Math.round(Math.min(560, Math.max(90, next))));
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
  }, [height]);

  const copyAll = useCallback(() => {
    const text = entries
      .map((e) => {
        const b =
          e.http && (e.http.method || e.http.status !== undefined)
            ? ` [${e.http.method}${
                e.http.status !== undefined ? ` ${e.http.status}` : ""
              }]`
            : "";
        const d =
          e.detail !== undefined && e.detail !== null && e.detail !== ""
            ? `\n${detailText(e.detail)}`
            : "";
        return `${fmtTime(e.ts)} ${e.level.toUpperCase()}${b} ${e.label}${d}`;
      })
      .join("\n");
    void navigator.clipboard?.writeText(text);
  }, [entries]);

  const errors = entries.filter((e) => e.level === "error").length;

  return (
    <section
      className={`builder-console${collapsed ? " collapsed" : ""}`}
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
          {collapsed ? "▸" : "▾"} Console
        </button>
        <span className="console-count">
          {entries.length} entr{entries.length === 1 ? "y" : "ies"}
          {errors > 0 ? ` · ${errors} error${errors === 1 ? "" : "s"}` : ""}
        </span>
        <span className="console-spacer" />
        <button type="button" onClick={copyAll} disabled={entries.length === 0}>
          Copy all
        </button>
        <button type="button" onClick={clear} disabled={entries.length === 0}>
          Clear
        </button>
        <button type="button" onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? "Expand" : "Collapse"}
        </button>
      </header>
      {!collapsed && (
        <ul className="console-list" ref={listRef}>
          {entries.length === 0 && (
            <li className="console-row console-info">
              <span className="console-label muted">
                No activity yet. Toolbar actions log here.
              </span>
            </li>
          )}
          {entries.map((e) => (
            <ConsoleRow key={e.id} entry={e} />
          ))}
        </ul>
      )}
    </section>
  );
}
