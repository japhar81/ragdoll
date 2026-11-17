/**
 * Theme state for the console. Dark is the default (the paddock aesthetic);
 * the choice persists per browser. The authoritative current value is the
 * `data-theme` attribute on <html> (set before first paint by the inline
 * script in index.html); localStorage is the durable backing store.
 */
import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "ragdoll-theme";

export function getTheme(): Theme {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  try {
    return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage unavailable (private mode / blocked) — the attribute still
    // applies for this session; we just can't remember the choice.
  }
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

/**
 * Subscribe a component to the live theme. Re-renders whenever `data-theme`
 * on <html> changes, so theme-dependent UI (e.g. the SVAR grid, which mounts a
 * different theme wrapper per mode) flips without a reload.
 */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, getTheme, () => "dark");
}
