/**
 * Inline "?" affordance with a popover. Wraps Radix Popover so callers can
 * either supply a plain `text` description or arbitrary `children`.
 *
 * Typical use next to a form-field label:
 *
 *   <label>
 *     Cron expression <FieldHelp text="5-field crontab; see Schedules docs." />
 *     <input ... />
 *   </label>
 */
import React from "react";
import * as RPopover from "@radix-ui/react-popover";

export function FieldHelp(props: {
  /** Short plain-text help. Ignored when `children` is supplied. */
  text?: string;
  /** Rich help (e.g. a small list, links). */
  children?: React.ReactNode;
  /** Label rendered to screen-readers as the trigger's accessible name. */
  ariaLabel?: string;
}) {
  return (
    <RPopover.Root>
      <RPopover.Trigger asChild>
        <button
          type="button"
          className="field-help-btn"
          aria-label={props.ariaLabel ?? "Help"}
        >
          ?
        </button>
      </RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          side="top"
          sideOffset={6}
          className="field-help-pop"
        >
          {props.children ?? <p>{props.text}</p>}
          <RPopover.Arrow className="field-help-arrow" />
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}
