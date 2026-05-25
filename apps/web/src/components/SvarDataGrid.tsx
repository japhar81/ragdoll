/**
 * Thin React wrapper over @svar-ui/react-grid.
 *
 * SVAR ships a feature-rich, virtualized grid (virtual scroll, header
 * menu sort/filter, frozen columns, context menu, themes). The bespoke
 * `DataGrid` we built earlier covered the basics — we keep that for
 * one-shot lists — but the activity tables (executions, usage, audit)
 * grow without bound and benefit hugely from real virtualization.
 *
 * The wrapper:
 *  - applies the Willow theme so the grid matches our slate-on-white
 *    palette out of the box;
 *  - exposes a `Column<Row>` type that maps to SVAR's IColumnConfig
 *    with a typed `cell` renderer, so screens stay TypeScript-strict;
 *  - surfaces a `LoadMoreButton` below the grid for cursor-paged
 *    callers (the activity screens use this with `useInfiniteQuery`);
 *  - falls back to an empty-state row instead of an empty viewport,
 *    matching the look of the rest of the app.
 *
 * Heavy CSS (`@svar-ui/react-grid/all.css`) is imported once from
 * `main.tsx` so the bundle only pays for it on app boot.
 */
import { type ReactNode, useMemo } from "react";
import { Grid, Willow, type IColumnConfig } from "@svar-ui/react-grid";

export interface SvarColumn<Row> {
  /** Field key on the row. Required — SVAR uses it for sort + filter. */
  id: string;
  header: string;
  /** Optional custom renderer. Receives the row directly (NOT SVAR's
   *  `ICellProps`) so the cell prop reads like our previous DataGrid. */
  cell?: (row: Row) => ReactNode;
  width?: number;
  /** Defaults to true — flip to false to keep this column from sorting. */
  sort?: boolean;
  align?: "left" | "right" | "center";
}

export interface SvarDataGridProps<Row> {
  rows: Row[];
  columns: SvarColumn<Row>[];
  /** Used as SVAR's row key. Defaults to `(row as any).id`. */
  rowKey?: (row: Row) => string | number;
  emptyMessage?: string;
  /** Pixel height the grid claims. Defaults to letting the surrounding
   *  flex container size it. Use a fixed number on screens where the
   *  grid is the entire content (executions / audit). */
  height?: number | string;
  /** Render a "Load more" affordance under the grid. Disable / hide by
   *  omitting `onLoadMore`. */
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
}

export function SvarDataGrid<Row>(props: SvarDataGridProps<Row>) {
  const { rows, columns } = props;
  // Map our typed Column<Row> into SVAR's IColumnConfig. SVAR's cell FC
  // receives ICellProps with `.row` typed loosely — wrap with our
  // typed `cell` callback so column definitions stay type-safe.
  const svarColumns = useMemo<IColumnConfig[]>(
    () =>
      columns.map((c) => {
        const cfg: IColumnConfig = {
          id: c.id,
          header: c.header,
          sort: c.sort !== false
        };
        if (c.width !== undefined) cfg.width = c.width;
        // SVAR aligns through the cell renderer + flex; we mirror via
        // a wrapped element if the caller asked for explicit alignment.
        const userCell = c.cell;
        if (c.align && c.align !== "left") {
          cfg.cell = ({ row }) => (
            <div style={{ textAlign: c.align, width: "100%" }}>
              {userCell ? userCell(row as Row) : String((row as Record<string, unknown>)[c.id] ?? "")}
            </div>
          );
        }
        if (c.cell && !cfg.cell) {
          // SVAR's `cell` is an FC<ICellProps>; we adapt by reading
          // `row` off the props and handing it to the typed cb.
          cfg.cell = ({ row }) => <>{c.cell!(row as Row)}</>;
        }
        return cfg;
      }),
    [columns]
  );

  // Always provide an `id` field on every row; SVAR uses it as the row
  // identity. If the caller's row doesn't have an `id`, fall back to
  // the array index — duplicates won't matter for our read-only grids.
  const data = useMemo(() => {
    const fallback = props.rowKey;
    if (!fallback) return rows as Array<Row & { id?: unknown }>;
    return rows.map((row, i) => {
      const r = row as Row & { id?: unknown };
      if (r.id !== undefined) return r;
      return { ...r, id: fallback(row) ?? i };
    });
  }, [rows, props.rowKey]);

  const heightStyle =
    typeof props.height === "number"
      ? `${props.height}px`
      : (props.height ?? "100%");

  return (
    <div className="svar-grid-wrap">
      <Willow>
        <div
          className="svar-grid-host"
          style={{ height: heightStyle, minHeight: 200 }}
        >
          {rows.length === 0 ? (
            <div className="svar-grid-empty">
              {props.emptyMessage ?? "No rows."}
            </div>
          ) : (
            <Grid
              data={data}
              columns={svarColumns}
              autoRowHeight
              filterValues={{}}
            />
          )}
        </div>
      </Willow>
      {props.onLoadMore && (props.hasMore ?? false) && (
        <div className="svar-grid-loadmore">
          <button
            type="button"
            className="link-btn"
            onClick={() => props.onLoadMore?.()}
            disabled={props.isLoadingMore}
          >
            {props.isLoadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
