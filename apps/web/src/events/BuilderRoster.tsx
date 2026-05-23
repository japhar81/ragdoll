import type { BuilderPresence } from "../../../../packages/events/src/index.ts";

/**
 * "Who else is editing this pipeline" — a compact stack of avatar initials in
 * the Builder toolbar. The list comes from the server's room roster, which
 * includes the local connection so users can see themselves in the group.
 */
export function BuilderRoster(props: {
  members: BuilderPresence[];
  selfConnectionId: string | null;
}) {
  if (props.members.length === 0) return null;
  const others = props.members.length - 1; // total minus self
  return (
    <div className="builder-roster" aria-label="Editors in this pipeline">
      {props.members.slice(0, 5).map((m) => (
        <span
          key={m.connectionId}
          className={
            "builder-roster-avatar" +
            (m.connectionId === props.selfConnectionId ? " self" : "")
          }
          title={
            m.label +
            (m.focusNodeId ? ` · editing ${m.focusNodeId}` : "") +
            (m.connectionId === props.selfConnectionId ? " (you)" : "")
          }
        >
          {m.initials}
        </span>
      ))}
      {props.members.length > 5 && (
        <span className="builder-roster-avatar" title={`${others - 4} more`}>
          +{props.members.length - 5}
        </span>
      )}
      <span className="builder-roster-count">
        {others <= 0 ? "just you" : `${others} other${others === 1 ? "" : "s"}`}
      </span>
    </div>
  );
}
