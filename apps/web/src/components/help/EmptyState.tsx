/**
 * Consistent empty-state across every list view.
 *
 *   <EmptyState
 *     title="No schedules yet"
 *     body="Schedules fire a pipeline on a cron expression…"
 *     action={{ label: "Create a schedule", onClick: () => focusForm() }}
 *   />
 *
 * Keep `title` short (one phrase); put the *why* and *how* in `body`. The
 * optional action should be the most likely next step (it is rendered as a
 * primary button so it stands out).
 */
import React from "react";

export function EmptyState(props: {
  title: string;
  body?: React.ReactNode;
  action?: { label: string; onClick: () => void };
  /** Small emoji / symbol shown above the title (default: "✨"). */
  icon?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon" aria-hidden>
        {props.icon ?? "✨"}
      </div>
      <div className="empty-state-title">{props.title}</div>
      {props.body && <div className="empty-state-body">{props.body}</div>}
      {props.action && (
        <button
          type="button"
          className="primary"
          onClick={props.action.onClick}
        >
          {props.action.label}
        </button>
      )}
    </div>
  );
}
