/**
 * Phase 11.2: stable per-dataset colour derived from the dataset slug.
 *
 * Two pipelines reading from the same Dataset get pills in the same
 * colour, so the "this pipeline shares a corpus with that one" story
 * is visible at a glance on the Pipelines list. Pure function — no
 * server round-trip, no settings to persist.
 *
 * Palette is hand-picked for contrast on the existing settings-card
 * background, biased toward muted tones so the pill chrome doesn't
 * overwhelm the row.
 */
// Vivid base hues; the pill colours are derived from these per theme via
// color-mix (below) so a pill reads correctly on both the dark and light
// surface without a second hardcoded table.
const HUES = [
  "#ef4444", // rose
  "#f97316", // orange
  "#f59e0b", // amber
  "#10b981", // emerald
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#a855f7"  // purple
];

/** DJB2-ish hash collapsed to a hue index. Deterministic per slug. */
function hashIndex(slug: string): number {
  let h = 5381;
  for (let i = 0; i < slug.length; i += 1) {
    h = (h * 33) ^ slug.charCodeAt(i);
  }
  // Force positive and modulo into the palette.
  return Math.abs(h) % HUES.length;
}

export function datasetColor(slug: string): { bg: string; fg: string; border: string } {
  const hue = HUES[hashIndex(slug)];
  // A subtle console-style tag: faint hue wash over the surface, hue-tinted
  // text, and a low-opacity hue border — not a loud highlighter pill. All
  // three adapt to the active theme via color-mix.
  return {
    bg: `color-mix(in srgb, ${hue} 13%, var(--surface))`,
    fg: `color-mix(in srgb, ${hue} 55%, var(--text))`,
    border: `color-mix(in srgb, ${hue} 30%, transparent)`
  };
}
