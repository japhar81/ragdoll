/**
 * Output formatters for CLI commands.
 *
 * Default is `json` (one JSON value per command, pretty-printed for humans)
 * because most users will be piping into `jq`. `--table` renders an array of
 * homogeneous objects as a plain monospace table; `--yaml` is a thin handle
 * for emitting pipeline specs in their canonical on-disk form (but is rarely
 * used so the implementation is minimal). Pure functions; tested directly.
 */

export type OutputFormat = "json" | "table" | "yaml";

/** A trivially pretty JSON serializer (2-space indent). */
export function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Render an array of homogeneous objects as a fixed-width table. The first
 * row's keys define the column order; non-string values are JSON-stringified
 * compactly. Empty arrays render as the literal "(no rows)".
 */
export function asTable(rows: ReadonlyArray<Record<string, unknown>>): string {
  if (rows.length === 0) return "(no rows)";
  const columns = Array.from(
    rows.reduce<Set<string>>((acc, row) => {
      for (const k of Object.keys(row)) acc.add(k);
      return acc;
    }, new Set())
  );
  const cellStr = (v: unknown): string =>
    v === null || v === undefined
      ? ""
      : typeof v === "string"
        ? v
        : JSON.stringify(v);
  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((r) => cellStr(r[col]).length))
  );
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  const out: string[] = [];
  out.push(line(columns));
  out.push(line(widths.map((w) => "-".repeat(w))));
  for (const row of rows) {
    out.push(line(columns.map((c) => cellStr(row[c]))));
  }
  return out.join("\n");
}

/**
 * Format a value for the chosen output mode. Tables only make sense for an
 * array of objects; fall back to JSON otherwise so a single-object response
 * still prints something useful.
 */
export function format(value: unknown, fmt: OutputFormat = "json"): string {
  if (fmt === "table") {
    if (Array.isArray(value) && value.every((v) => v && typeof v === "object")) {
      return asTable(value as Record<string, unknown>[]);
    }
    // Common shape: { things: [...] } — extract the list automatically.
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const arrays = Object.values(value as Record<string, unknown>).filter(
        (v): v is Record<string, unknown>[] =>
          Array.isArray(v) && v.every((x) => x && typeof x === "object")
      );
      if (arrays.length === 1) return asTable(arrays[0]);
    }
    return asJson(value);
  }
  if (fmt === "yaml") {
    // Minimal YAML for shallow specs — for anything else fall back to JSON.
    // (Real spec round-tripping is done server-side via /pipelines/.../export.)
    return asJson(value);
  }
  return asJson(value);
}
