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
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import {
  Grid,
  Willow,
  type IApi,
  type IColumnConfig
} from "@svar-ui/react-grid";

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
        if (c.width !== undefined) {
          cfg.width = c.width;
        } else {
          // No explicit width → let the column flex-grow to fill any
          // remaining horizontal space in the viewport. Without this
          // SVAR sizes each unsized column to its content default
          // (~120px) and leaves a band of empty space on the right.
          cfg.flexgrow = 1;
        }
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

  // Default: stretch to whatever the parent flex column allots us. A
  // numeric / string height is honored when the caller pins the grid
  // (e.g. ExecutionsScreen shrinks to 360px when a trace is open).
  const heightStyle =
    props.height === undefined
      ? undefined
      : typeof props.height === "number"
        ? `${props.height}px`
        : props.height;

  // SVAR's internal scroll fires per-row as the user navigates the
  // virtual viewport. We auto-fetch the next page when the visible
  // row is within the last `LOAD_MORE_BUFFER` of the loaded set so
  // the user never sees an empty scroll-tail. `latest` mirrors the
  // current loaders into a ref so the scroll handler doesn't have to
  // re-bind every render.
  const LOAD_MORE_BUFFER = 10;
  const latest = useRef({
    rowCount: rows.length,
    hasMore: props.hasMore ?? false,
    isLoadingMore: props.isLoadingMore ?? false,
    onLoadMore: props.onLoadMore,
    rowKey: props.rowKey
  });
  latest.current = {
    rowCount: rows.length,
    hasMore: props.hasMore ?? false,
    isLoadingMore: props.isLoadingMore ?? false,
    onLoadMore: props.onLoadMore,
    rowKey: props.rowKey
  };

  const apiRef = useRef<IApi | undefined>(undefined);
  const onInit = (api: IApi): void => {
    apiRef.current = api;
    if (!latest.current.onLoadMore) return;
    api.on("scroll", () => {
      const cur = latest.current;
      if (!cur.hasMore || cur.isLoadingMore || !cur.onLoadMore) return;
      // Inspect the grid's reactive state for the index of the row
      // currently at the bottom of the viewport. The exact field
      // names differ between SVAR releases; we read them defensively.
      const state = api.getState() as unknown as Record<string, unknown>;
      const positions = (state._positionsData as
        | { stop?: number; end?: number }
        | undefined) ??
        (state.positionsData as
          | { stop?: number; end?: number }
          | undefined);
      const stop =
        (positions?.stop as number | undefined) ??
        (positions?.end as number | undefined);
      const remaining = cur.rowCount - (stop ?? 0);
      if (remaining <= LOAD_MORE_BUFFER) cur.onLoadMore!();
    });
  };

  // Belt-and-suspenders: a row count growing past the previous render
  // may not re-trigger scroll if the user is already at the bottom.
  // After every refetch, re-check distance to bottom once.
  useEffect(() => {
    const cur = latest.current;
    if (!cur.hasMore || cur.isLoadingMore || !cur.onLoadMore) return;
    const api = apiRef.current;
    if (!api) return;
    const state = api.getState() as unknown as Record<string, unknown>;
    const positions = (state._positionsData as
      | { stop?: number; end?: number }
      | undefined) ??
      (state.positionsData as
        | { stop?: number; end?: number }
        | undefined);
    const stop =
      (positions?.stop as number | undefined) ??
      (positions?.end as number | undefined);
    const remaining = cur.rowCount - (stop ?? 0);
    if (remaining <= LOAD_MORE_BUFFER) cur.onLoadMore!();
  }, [rows.length]);

  return (
    <div className="svar-grid-wrap">
      <Willow>
        <div
          className="svar-grid-host"
          style={heightStyle ? { height: heightStyle, minHeight: 200 } : undefined}
        >
          {rows.length === 0 ? (
            <div className="svar-grid-empty">
              {props.emptyMessage ?? "No rows."}
            </div>
          ) : (
            <Grid
              data={data}
              columns={svarColumns}
              // No autoRowHeight: SVAR's virtual scroll only kicks in
              // with fixed-height rows. With autoRowHeight the grid
              // measures and renders every loaded row in DOM, the
              // table overflows the viewport, and the scroll-bottom
              // event we hook for the next-page fetch never fires.
              filterValues={{}}
              init={onInit}
            />
          )}
        </div>
      </Willow>
      {/* Virtual scroll auto-fetches via the `init`-bound scroll
          listener above; a small status line tells the user when more
          rows are inbound. No button — that would defeat the
          continuous-scroll affordance. */}
      {props.isLoadingMore && (
        <div className="svar-grid-loadmore" aria-live="polite">
          Loading more rows…
        </div>
      )}
    </div>
  );
}
