/**
 * Global keyboard listener that drives every help surface:
 *
 *   ⌘K / Ctrl-K        toggle command palette
 *   ?                  show shortcuts overlay (unless typing in a field)
 *   g <letter>         "go to" chord — pipelines / scheduler / executions / users
 *   Esc                handled by the dialog primitives themselves
 *
 * The hook returns the open/close state for the palette and the shortcuts
 * dialog so the host owns rendering. Chord buffer is local — no global state.
 */
import { useEffect, useState } from "react";
import { parseGoShortcut } from "../../lib/help.ts";

function isTypingTarget(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export interface GlobalHelpKeys {
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (open: boolean) => void;
}

export function useGlobalHelpKeys(args: {
  /** Called with `pipelines | scheduler | executions | users` for `g <letter>`. */
  onGoTo: (target: string) => void;
}): GlobalHelpKeys {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    // Two-key chord buffer; cleared after 700ms or after any handled key.
    let chord = "";
    let chordTimer: ReturnType<typeof setTimeout> | undefined;
    const clearChord = () => {
      chord = "";
      if (chordTimer) clearTimeout(chordTimer);
      chordTimer = undefined;
    };

    function onKey(e: KeyboardEvent): void {
      // ⌘K / Ctrl-K toggles the palette from anywhere, even from inside an
      // input — that's the universal expectation (Linear / Vercel / GitHub).
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }

      // Anything below this point should NOT fire while the user is typing.
      if (isTypingTarget(e.target)) return;
      // Bare modifier keys don't drive any of our shortcuts.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // `?` toggles the shortcuts overlay (shift+/ on US layouts).
      if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
        return;
      }

      // `g <letter>` chord.
      if (e.key === "g") {
        chord = "g";
        if (chordTimer) clearTimeout(chordTimer);
        chordTimer = setTimeout(clearChord, 700);
        return;
      }
      if (chord === "g" && /^[a-z]$/.test(e.key)) {
        const target = parseGoShortcut("g" + e.key);
        clearChord();
        if (target) {
          e.preventDefault();
          args.onGoTo(target);
        }
        return;
      }
    }

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearChord();
    };
  }, [args]);

  return { paletteOpen, setPaletteOpen, shortcutsOpen, setShortcutsOpen };
}
