import React from "react";
import { ApiError } from "../lib/api.ts";

/**
 * Shared admin-screen chrome: a Metis-style page heading (`<h1>` + optional
 * lead paragraph), then a content slot. Loading and error states render
 * inline so the page heading stays put while the request settles.
 *
 * No `<section>` wrapper — the parent `.admin-main.with-pad` already supplies
 * the padding and scroll container.
 */
export function Screen(props: {
  title: string;
  description?: string;
  isLoading?: boolean;
  error?: unknown;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="page-heading">
        <h1>{props.title}</h1>
        {props.description && <p className="lead">{props.description}</p>}
      </div>
      {props.isLoading && <p className="muted">Loading…</p>}
      {props.error && (
        <div className="alert alert-danger" role="alert">
          {props.error instanceof ApiError
            ? `HTTP ${props.error.status}: ${JSON.stringify(props.error.body)}`
            : props.error instanceof Error
              ? props.error.message
              : "Request failed (is the API running on :3001?)"}
        </div>
      )}
      {!props.isLoading && !props.error && props.children}
    </>
  );
}

export function Table(props: { columns: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="table-responsive">
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
    </div>
  );
}
