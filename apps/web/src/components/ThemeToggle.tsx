import { toggleTheme, useTheme } from "../lib/theme";

/**
 * Sidebar control that flips the console between the dark (default) and light
 * paddock themes. Lives in the always-dark sidebar, so it's styled as chrome.
 */
export function ThemeToggle() {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => toggleTheme()}
    >
      <span className="theme-toggle-glyph" aria-hidden="true">
        {theme === "dark" ? "☀" : "☾"}
      </span>
      <span>{theme === "dark" ? "Light" : "Dark"} mode</span>
    </button>
  );
}
