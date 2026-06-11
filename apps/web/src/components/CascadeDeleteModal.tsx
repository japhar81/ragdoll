/**
 * CascadeDeleteModal — shared confirm-delete UX that understands the
 * server's `has_dependents` 409 envelope.
 *
 * Single-action flow when the resource has no dependents:
 *   [Open] → "Delete X?" → [Cancel] [Delete] → 204 → onDeleted()
 *
 * Two-step flow when the resource has dependents:
 *   [Open]
 *     → "Delete X?" → [Cancel] [Delete]
 *     → server returns 409 has_dependents
 *     → modal re-renders with the dependents breakdown +
 *       a destructive "Force delete (cascade N items)" button.
 *     → [Cancel] [Force delete] → 204 → onDeleted()
 *
 * The caller passes ONE delete fn (`doDelete(opts)`); the modal calls
 * it without force first, watches for the cascade envelope, and re-
 * invokes with `{force: true}` when the user confirms. This keeps all
 * the UI state — first/second screen, dependents list, in-flight,
 * error — owned by ONE component callers can drop in by ID.
 */
import { useState, type ReactElement } from "react";
import {
  isHasDependentsError,
  totalDependents,
  type HasDependentsBody
} from "../lib/cascadeDelete.ts";
import { ApiError } from "../lib/api.ts";

export interface CascadeDeleteModalProps {
  open: boolean;
  /** Short, operator-facing label of what's being deleted. E.g. `folder "Demos"`. */
  resourceLabel: string;
  /** Optional one-line context shown above the dependents list. */
  description?: string;
  /** Issues the DELETE. When `opts.force` is true, the server will cascade.
   *  Reject on the server's 409 has_dependents envelope so the modal can
   *  re-render with the breakdown. */
  doDelete: (opts: { force: boolean }) => Promise<void>;
  /** Fired after the delete (forced or not) succeeds; close the modal here. */
  onDeleted: () => void;
  onClose: () => void;
}

export function CascadeDeleteModal(props: CascadeDeleteModalProps): ReactElement | null {
  const [phase, setPhase] = useState<"idle" | "submitting" | "blocked">("idle");
  const [blockedBody, setBlockedBody] = useState<HasDependentsBody | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  if (!props.open) return null;

  async function attempt(force: boolean): Promise<void> {
    setPhase("submitting");
    setErrorMessage(undefined);
    try {
      await props.doDelete({ force });
      // Reset before the parent unmounts us so a re-open starts fresh.
      setPhase("idle");
      setBlockedBody(undefined);
      props.onDeleted();
    } catch (err) {
      const dep = isHasDependentsError(err);
      if (dep) {
        setBlockedBody(dep);
        setPhase("blocked");
        return;
      }
      const msg =
        err instanceof ApiError
          ? (() => {
              const body = err.body as { message?: string } | undefined;
              return body?.message || err.message;
            })()
          : err instanceof Error
            ? err.message
            : String(err);
      setErrorMessage(msg);
      setPhase("idle");
    }
  }

  function close(): void {
    setPhase("idle");
    setBlockedBody(undefined);
    setErrorMessage(undefined);
    props.onClose();
  }

  const submitting = phase === "submitting";
  const blocked = phase === "blocked" && blockedBody !== undefined;
  const cascadeTotal = blockedBody ? totalDependents(blockedBody) : 0;

  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 520 }}
      >
        <header className="modal-head">
          <strong>{blocked ? "Cascade delete?" : `Delete ${props.resourceLabel}?`}</strong>
          <button className="link-btn" onClick={close} disabled={submitting}>
            close
          </button>
        </header>

        {!blocked && (
          <>
            {props.description && (
              <p className="muted">{props.description}</p>
            )}
            <p>
              Delete <code>{props.resourceLabel}</code>?
            </p>
            {errorMessage && (
              <p className="error" role="alert">
                {errorMessage}
              </p>
            )}
            <footer className="modal-foot">
              <button className="link-btn" onClick={close} disabled={submitting}>
                Cancel
              </button>
              <button
                className="link-btn danger"
                onClick={() => void attempt(false)}
                disabled={submitting}
              >
                {submitting ? "Deleting…" : "Delete"}
              </button>
            </footer>
          </>
        )}

        {blocked && blockedBody && (
          <>
            <p className="muted">
              <code>{props.resourceLabel}</code> has {cascadeTotal} dependent
              {cascadeTotal === 1 ? "" : "s"} that would be orphaned. Force-delete
              cascades through ALL of these in one transaction.
            </p>
            <ul className="cascade-deps">
              {Object.entries(blockedBody.dependents).map(([kind, count]) => (
                <li key={kind}>
                  <strong>{count}</strong> {humaniseKind(kind, count)}
                </li>
              ))}
            </ul>
            <p className="error" role="alert" style={{ marginTop: 8 }}>
              This is permanent. Cascade-deleted resources do not move to a
              trash — they are removed from the database.
            </p>
            <footer className="modal-foot">
              <button className="link-btn" onClick={close} disabled={submitting}>
                Cancel
              </button>
              <button
                className="link-btn danger"
                onClick={() => void attempt(true)}
                disabled={submitting}
              >
                {submitting
                  ? "Cascading…"
                  : `Force delete (nukes ${cascadeTotal} item${cascadeTotal === 1 ? "" : "s"})`}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

/** Friendly-up the snake-case dependent kind labels the server returns.
 *  Pluralised by count so "1 pipeline" reads naturally. Falls back to
 *  the raw key for kinds we haven't enumerated. */
function humaniseKind(kind: string, count: number): string {
  const labels: Record<string, [string, string]> = {
    pipelines: ["pipeline", "pipelines"],
    subfolders: ["sub-folder", "sub-folders"],
    versions: ["pipeline version", "pipeline versions"],
    deployments: ["deployment", "deployments"],
    activations: ["activation", "activations"],
    schedules: ["schedule", "schedules"],
    bindings: ["binding override", "binding overrides"],
    aliases: ["dataset alias", "dataset aliases"],
    pipelineReferences: ["pipeline that references this", "pipelines that reference this"],
    pipelineAssociations: ["tenant-pipeline association", "tenant-pipeline associations"],
    datasets: ["dataset", "datasets"],
    connections: ["connection", "connections"],
    environments: ["environment", "environments"],
    grants: ["RBAC grant", "RBAC grants"]
  };
  const pair = labels[kind];
  if (!pair) return `${kind} (count: ${count})`;
  return count === 1 ? pair[0] : pair[1];
}
