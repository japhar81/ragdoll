/**
 * Lightweight datagrid with column-level filtering + sorting.
 *
 * Why a custom one instead of a library: every existing table in the
 * UI already uses the `table.grid` CSS we ship; pulling in TanStack
 * Table / AG Grid / etc. would either drag a styling layer along OR
 * force a re-skin. The interesting features (sort, per-column text /
 * select filter) are small enough to roll cleanly.
 *
 * Generic over Row. Each column declares:
 *   - `key`       unique id (used for filter / sort state)
 *   - `header`    string shown in the column header
 *   - `accessor`  pull a sortable / filterable scalar off the row
 *                 (returns string | number | boolean | null | undefined)
 *   - `cell`      optional custom render (defaults to String(accessor))
 *   - `filter`    "text" (default) | "select" (auto-derived from
 *                 distinct accessor values) | "none"
 *   - `sortable`  default true
 *   - `width`     optional CSS width
 *
 * State lives in this component — no router / URL persistence yet.
 * Filters apply as the user types; sort toggles ascending /
 * descending / off on header click.
 */
import { useMemo, useState, type ReactNode } from "react";

export type DataGridScalar = string | number | boolean | null | undefined;

export interface DataGridColumn<Row> {
  key: string;
  header: string;
  accessor: (row: Row) => DataGridScalar;
  cell?: (row: Row) => ReactNode;
  filter?: "text" | "select" | "none";
  sortable?: boolean;
  width?: string;
  /** Optional explicit list of select-filter options. Auto-derived
   *  from the rows otherwise. */
  filterOptions?: () => string[];
  /** Right-align numeric / status columns. Default: left. */
  align?: "left" | "right";
}

export interface DataGridProps<Row> {
  columns: DataGridColumn<Row>[];
  rows: Row[];
  /** Unique row id for React keys — falls back to row index. */
  rowKey?: (row: Row, index: number) => string;
  /** Optional row-level className (e.g. highlight selected row). */
  rowClassName?: (row: Row) => string | undefined;
  /** Empty-state text. Defaults to "No rows." */
  emptyMessage?: string;
}

interface SortState {
  key: string;
  direction: "asc" | "desc";
}

function toComparable(v: DataGridScalar): string | number {
  if (v === null || v === undefined) return ""; // nulls sort first
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  return v.toLowerCase();
}

function matchesFilter(value: DataGridScalar, needle: string): boolean {
  if (!needle) return true;
  if (value === null || value === undefined) return false;
  return String(value).toLowerCase().includes(needle.toLowerCase());
}

export function DataGrid<Row>(props: DataGridProps<Row>) {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<SortState | null>(null);

  // Distinct accessor values per "select" column — computed once per
  // (rows, columns) change so the dropdown options stay stable.
  const selectOptions = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const col of props.columns) {
      if (col.filter !== "select") continue;
      if (col.filterOptions) {
        out[col.key] = col.filterOptions();
        continue;
      }
      const seen = new Set<string>();
      for (const row of props.rows) {
        const v = col.accessor(row);
        if (v === null || v === undefined) continue;
        seen.add(String(v));
      }
      out[col.key] = [...seen].sort();
    }
    return out;
  }, [props.columns, props.rows]);

  const visible = useMemo(() => {
    let out = props.rows;
    // Apply each column's filter independently (AND across columns).
    for (const col of props.columns) {
      const needle = filters[col.key];
      if (!needle) continue;
      out = out.filter((row) => {
        const v = col.accessor(row);
        if (col.filter === "select") {
          return v !== null && v !== undefined && String(v) === needle;
        }
        return matchesFilter(v, needle);
      });
    }
    // Stable sort.
    if (sort) {
      const col = props.columns.find((c) => c.key === sort.key);
      if (col) {
        const direction = sort.direction === "asc" ? 1 : -1;
        out = [...out].sort((a, b) => {
          const av = toComparable(col.accessor(a));
          const bv = toComparable(col.accessor(b));
          if (av < bv) return -1 * direction;
          if (av > bv) return 1 * direction;
          return 0;
        });
      }
    }
    return out;
  }, [props.rows, props.columns, filters, sort]);

  function cycleSort(key: string): void {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, direction: "asc" };
      if (prev.direction === "asc") return { key, direction: "desc" };
      return null;
    });
  }

  return (
    <table className="grid datagrid">
      <thead>
        <tr>
          {props.columns.map((col) => {
            const sortIcon =
              sort?.key === col.key
                ? sort.direction === "asc"
                  ? "▲"
                  : "▼"
                : "";
            const sortable = col.sortable !== false;
            return (
              <th
                key={col.key}
                style={{
                  width: col.width,
                  textAlign: col.align ?? "left",
                  cursor: sortable ? "pointer" : "default",
                  userSelect: "none"
                }}
                onClick={(e) => {
                  // Only the header label area cycles sort; click on
                  // the filter input shouldn't toggle.
                  if ((e.target as HTMLElement).tagName === "INPUT") return;
                  if ((e.target as HTMLElement).tagName === "SELECT") return;
                  if (sortable) cycleSort(col.key);
                }}
                title={sortable ? "Click to sort" : undefined}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                  <span>{col.header}</span>
                  <span className="muted" style={{ fontSize: "0.75em" }}>{sortIcon}</span>
                </div>
                {col.filter !== "none" && (
                  col.filter === "select" ? (
                    <select
                      className="datagrid-filter"
                      value={filters[col.key] ?? ""}
                      onChange={(e) =>
                        setFilters((prev) => ({ ...prev, [col.key]: e.target.value }))
                      }
                    >
                      <option value="">all</option>
                      {(selectOptions[col.key] ?? []).map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="datagrid-filter"
                      type="text"
                      placeholder="filter…"
                      value={filters[col.key] ?? ""}
                      onChange={(e) =>
                        setFilters((prev) => ({ ...prev, [col.key]: e.target.value }))
                      }
                    />
                  )
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {visible.length === 0 && (
          <tr>
            <td colSpan={props.columns.length} className="muted">
              {props.emptyMessage ?? "No rows."}
            </td>
          </tr>
        )}
        {visible.map((row, i) => (
          <tr
            key={props.rowKey?.(row, i) ?? String(i)}
            className={props.rowClassName?.(row)}
          >
            {props.columns.map((col) => (
              <td key={col.key} style={{ textAlign: col.align ?? "left" }}>
                {col.cell ? col.cell(row) : String(col.accessor(row) ?? "")}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
