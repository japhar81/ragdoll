/**
 * "?" keyboard-shortcuts overlay (Radix dialog over the rest of the app).
 *
 * Triggered by the bare `?` key globally — the parent App owns the open
 * state so the same key handler can also drive the command palette + go-to
 * chords (see {@link useGlobalHelpKeys}).
 */
import React from "react";
import * as RDialog from "@radix-ui/react-dialog";
import { SHORTCUTS } from "../../lib/help.ts";

export function ShortcutsOverlay(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const byScope = {
    global: SHORTCUTS.filter((s) => s.scope === "global"),
    palette: SHORTCUTS.filter((s) => s.scope === "palette"),
    drawer: SHORTCUTS.filter((s) => s.scope === "drawer")
  };
  return (
    <RDialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="dlg-overlay" />
        <RDialog.Content className="dlg shortcuts-dlg">
          <RDialog.Title className="dlg-title">Keyboard shortcuts</RDialog.Title>
          <RDialog.Description className="muted small">
            Press <kbd>Esc</kbd> to close.
          </RDialog.Description>

          {(["global", "palette", "drawer"] as const).map((scope) =>
            byScope[scope].length === 0 ? null : (
              <section key={scope} className="shortcut-group">
                <h4>
                  {scope === "global"
                    ? "Global"
                    : scope === "palette"
                      ? "Command palette"
                      : "Overlays"}
                </h4>
                <dl className="shortcut-list">
                  {byScope[scope].map((s, i) => (
                    <React.Fragment key={`${scope}-${i}`}>
                      <dt>
                        {s.keys.map((k, j) => (
                          <React.Fragment key={j}>
                            <kbd>{k}</kbd>
                            {j < s.keys.length - 1 && <span className="kbd-sep">+</span>}
                          </React.Fragment>
                        ))}
                      </dt>
                      <dd>{s.description}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              </section>
            )
          )}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
