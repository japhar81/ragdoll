import React from "react";
import { ApiError } from "../lib/api.ts";

/** Shared admin-screen chrome: title, loading/error states, content slot.
 *
 * Pass `fill` when the screen's main content is a tall grid (executions,
 * audit, usage). The body switches to a flex column so a child marked
 * `flex: 1 1 auto` (the SVAR grid host) claims all the remaining
 * vertical space — without a fragile `calc(100vh - …)` fudge. */
export function Screen(props: {
  title: string;
  isLoading?: boolean;
  error?: unknown;
  fill?: boolean;
  children: React.ReactNode;
}) {
  const bodyClass = props.fill ? "screen-body screen-body--fill" : "screen-body";
  return (
    <section className="builder">
      <header className="toolbar">
        <strong>{props.title}</strong>
      </header>
      <div className={bodyClass}>
        {props.isLoading && <p className="muted">Loading…</p>}
        {props.error && (
          <p className="error">
            {props.error instanceof ApiError
              ? `HTTP ${props.error.status}: ${JSON.stringify(props.error.body)}`
              : props.error instanceof Error
                ? props.error.message
                : "Request failed (is the API running on :3001?)"}
          </p>
        )}
        {!props.isLoading && !props.error && props.children}
      </div>
    </section>
  );
}

export function Table(props: { columns: string[]; rows: React.ReactNode[][] }) {
  return (
    <table className="grid">
      <thead>
        <tr>
          {props.columns.map((c) => (
            <th key={c}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.rows.length === 0 && (
          <tr>
            <td colSpan={props.columns.length} className="muted">
              No rows.
            </td>
          </tr>
        )}
        {props.rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td key={j}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
