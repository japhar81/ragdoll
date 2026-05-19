import React, { useEffect, useRef, useState } from "react";

/**
 * A toolbar dropdown: a trigger button that toggles a popover panel holding
 * arbitrary controls (inputs, selects, buttons). Closes on outside click,
 * Escape, or after an action button inside it is clicked — so it behaves
 * like a normal menu while still hosting form fields.
 */
export function ToolbarMenu({
  label,
  children,
  align = "left"
}: {
  label: string;
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="tb-menu" ref={ref}>
      <button
        type="button"
        className="tb-menu-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        <span className="tb-menu-caret">▾</span>
      </button>
      {open && (
        <div
          className={`tb-menu-panel${align === "right" ? " align-right" : ""}`}
          // An action button inside fires its own onClick first (it's the
          // event target); this bubble handler then dismisses the menu.
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("button")) setOpen(false);
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
