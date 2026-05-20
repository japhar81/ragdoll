/**
 * Cmd-K command palette built on `cmdk` (the Pacocoursey one used by
 * Linear / Vercel). Indexes a permission-filtered slice of {@link ACTIONS},
 * grouped by section, with our own fuzzy filter so the items match what
 * `filterPalette` (which is unit-tested) returns.
 *
 * Action handling is delegated to the parent via `onRun` so the host owns
 * navigation, drawer open/close, etc. — the palette stays presentational.
 */
import React, { useMemo } from "react";
import * as RDialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import {
  ACTIONS,
  filterPalette,
  type PaletteAction
} from "../../lib/help.ts";

export function CommandPalette(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Auth gating; defaults to "always show" for the unauth login surface. */
  can?: (...perms: string[]) => boolean;
  /** Handle an item activation. */
  onRun: (action: PaletteAction) => void;
}) {
  const [query, setQuery] = React.useState("");
  const can = props.can ?? (() => true);
  const items = useMemo(
    () => filterPalette(ACTIONS, query, can),
    [query, can]
  );

  // Reset the query whenever we open/close so re-opening is fresh.
  React.useEffect(() => {
    if (!props.open) setQuery("");
  }, [props.open]);

  const groups = useMemo(() => {
    const order: PaletteAction["group"][] = [
      "Navigate",
      "Create",
      "Run",
      "Inspect",
      "Help"
    ];
    return order
      .map((g) => ({ group: g, rows: items.filter((i) => i.group === g) }))
      .filter((g) => g.rows.length > 0);
  }, [items]);

  return (
    <RDialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="dlg-overlay" />
        <RDialog.Content
          className="cmdk-dlg"
          // cmdk handles arrow + enter; let it through and stop Radix from
          // hijacking Tab navigation in the listbox.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <RDialog.Title className="sr-only">Command palette</RDialog.Title>
          <Command label="Command palette" shouldFilter={false}>
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Type a command, or search…"
              className="cmdk-input"
            />
            <Command.List className="cmdk-list">
              <Command.Empty className="cmdk-empty">
                No matching commands.
              </Command.Empty>
              {groups.map((g) => (
                <Command.Group key={g.group} heading={g.group}>
                  {g.rows.map((item) => (
                    <Command.Item
                      key={item.id}
                      value={item.id + " " + item.label + " " + (item.hint ?? "")}
                      onSelect={() => {
                        props.onRun(item);
                        props.onOpenChange(false);
                      }}
                    >
                      <span className="cmdk-label">{item.label}</span>
                      {item.hint && <span className="cmdk-hint">{item.hint}</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
