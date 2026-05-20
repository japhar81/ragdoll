/**
 * Thin Radix tooltip wrapper, styled to match the rest of the chrome.
 *
 * Wrap any trigger element (button, icon, link) and pass `label` to get an
 * accessible delayed tooltip. Provider is mounted at the app root so callers
 * don't have to think about it.
 */
import React from "react";
import * as RTooltip from "@radix-ui/react-tooltip";

export function TooltipProvider(props: { children: React.ReactNode }) {
  return (
    <RTooltip.Provider delayDuration={250} skipDelayDuration={100}>
      {props.children}
    </RTooltip.Provider>
  );
}

export function Tooltip(props: {
  label: React.ReactNode;
  children: React.ReactNode;
  /** "top" | "right" | "bottom" | "left"; default "top". */
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{props.children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={props.side ?? "top"}
          sideOffset={6}
          className="tip"
        >
          {props.label}
          <RTooltip.Arrow className="tip-arrow" />
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}
