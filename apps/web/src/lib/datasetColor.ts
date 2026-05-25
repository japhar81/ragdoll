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
const PALETTE = [
  { bg: "#fee2e2", fg: "#991b1b" }, // rose
  { bg: "#ffedd5", fg: "#9a3412" }, // orange
  { bg: "#fef3c7", fg: "#92400e" }, // amber
  { bg: "#d1fae5", fg: "#065f46" }, // emerald
  { bg: "#cffafe", fg: "#155e75" }, // cyan
  { bg: "#dbeafe", fg: "#1e40af" }, // blue
  { bg: "#e0e7ff", fg: "#3730a3" }, // indigo
  { bg: "#ede9fe", fg: "#5b21b6" }, // violet
  { bg: "#fce7f3", fg: "#9d174d" }, // pink
  { bg: "#f3e8ff", fg: "#6b21a8" }  // purple
];

/** DJB2-ish hash collapsed to a palette index. Deterministic per slug. */
function hashIndex(slug: string): number {
  let h = 5381;
  for (let i = 0; i < slug.length; i += 1) {
    h = (h * 33) ^ slug.charCodeAt(i);
  }
  // Force positive and modulo into the palette.
  return Math.abs(h) % PALETTE.length;
}

export function datasetColor(slug: string): { bg: string; fg: string } {
  return PALETTE[hashIndex(slug)];
}
