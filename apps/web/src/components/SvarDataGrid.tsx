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
 *  - turns sort, resize, and header-filter ON BY DEFAULT — every
 *    column gets a draggable resize handle, a clickable sort header,
 *    and a text-filter input below the title. Per-column opt-outs
 *    (`sort: false`, `filter: false`, `resize: false`) cover the
 *    odd action column;
 *  - auto-sizes columns without an explicit `width` to fit their
 *    content (canvas-measured against the first page of rows, then
 *    frozen so subsequent page loads don't reshape the grid);
 *  - surfaces a "Load more" affordance via virtual-scroll auto-fetch
 *    for cursor-paged callers (the activity screens use this with
 *    `useInfiniteQuery`);
 *  - falls back to an empty-state row instead of an empty viewport,
 *    matching the look of the rest of the app.
 *
 * Heavy CSS (`@svar-ui/react-grid/all.css`) is imported once from
 * `main.tsx` so the bundle only pays for it on app boot.
 */
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
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
  /** Pixel width. When set, takes precedence over the auto-sizer. */
  width?: number;
  /** Defaults to true — flip to false to keep this column from sorting. */
  sort?: boolean;
  /** Header filter widget. Defaults to a text input. Set `false` for
   *  columns where filtering makes no sense (e.g. an actions column). */
  filter?: false | "text" | "richselect";
  /** Defaults to true — flip false to lock the column width. */
  resize?: boolean;
  /** Defaults to true when no explicit `width` is set; opts the column
   *  into the canvas-measured auto-sizer. Set false to fall back to
   *  SVAR's default flex-grow distribution. */
  autoWidth?: boolean;
  /** Returns the plain-text content the auto-sizer should measure for
   *  a given row. Used when the `cell` renderer derives content from
   *  outside the row (e.g. an id → name lookup) — without this the
   *  sizer would measure the raw UUID and pick the wrong width. */
  measure?: (row: Row) => string;
  align?: "left" | "right" | "center";
}

export interface SvarDataGridProps<Row> {
  rows: Row[];
  columns: SvarColumn<Row>[];
  /** Used as SVAR's row key. Defaults to `(row as any).id`. */
  rowKey?: (row: Row) => string | number;
  emptyMessage?: string;
  /** Singular noun for the footer row-count summary (e.g. "execution",
   *  "audit entry"). Defaults to "row". */
  rowNoun?: string;
  /** Total rows the API reports under the same filter. When set the
   *  footer reads "N of M <noun>"; when omitted it falls back to the
   *  loaded slice count. */
  totalRows?: number;
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

// ---------------------------------------------------------------------------
// Auto-width measurement
// ---------------------------------------------------------------------------

/**
 * Number of leading rows the auto-sizer measures to derive each
 * column's width. Big enough to cover the realistic worst case in the
 * first page, small enough that the measurement loop stays under a
 * frame. Subsequent pages do NOT trigger a re-measurement.
 */
const AUTO_WIDTH_SAMPLE = 80;
/** Min and max widths the auto-sizer will assign. */
const AUTO_WIDTH_MIN = 80;
const AUTO_WIDTH_MAX = 480;
/** Padding around the measured text inside a cell, plus the sort/
 *  filter icons in the header. */
const CELL_PADDING_PX = 24;
const HEADER_PADDING_PX = 56;
/** Canvas font used for measurement — matches the SVAR Willow theme's
 *  body font. */
const MEASURE_FONT = "13px system-ui, -apple-system, 'Segoe UI', sans-serif";

let measureCanvas: HTMLCanvasElement | undefined;
function measureText(text: string): number {
  if (typeof document === "undefined") return text.length * 8;
  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  const ctx = measureCanvas.getContext("2d");
  if (!ctx) return text.length * 8;
  ctx.font = MEASURE_FONT;
  return ctx.measureText(text).width;
}

function measureCellText<Row>(row: Row, col: SvarColumn<Row>): string {
  if (col.measure) return col.measure(row);
  const raw = (row as Record<string, unknown>)[col.id];
  if (raw === null || raw === undefined) return "";
  // Stringify primitives directly; for objects fall back to JSON so the
  // sizer doesn't trip on `[object Object]` (and still bounds at MAX).
  if (typeof raw === "object") {
    try {
      return JSON.stringify(raw);
    } catch {
      return "";
    }
  }
  return String(raw);
}

function computeAutoWidths<Row>(
  columns: SvarColumn<Row>[],
  rows: Row[]
): Record<string, number> {
  const out: Record<string, number> = {};
  const sample = rows.slice(0, AUTO_WIDTH_SAMPLE);
  for (const col of columns) {
    if (col.width !== undefined) continue;
    if (col.autoWidth === false) continue;
    let maxPx = measureText(col.header) + HEADER_PADDING_PX;
    for (const row of sample) {
      const text = measureCellText(row, col);
      const px = measureText(text) + CELL_PADDING_PX;
      if (px > maxPx) maxPx = px;
    }
    out[col.id] = Math.round(
      Math.min(AUTO_WIDTH_MAX, Math.max(AUTO_WIDTH_MIN, maxPx))
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SvarDataGrid<Row>(props: SvarDataGridProps<Row>) {
  const { rows, columns } = props;
  const rowNoun = props.rowNoun ?? "row";
  // Footer text logic:
  //   - if the API gave us a total AND it differs from the loaded
  //     slice (i.e. more pages exist), show "N of M …";
  //   - if total == loaded, just show "N …" (no point repeating);
  //   - if no total was passed, fall back to the slice count.
  const loadedFmt = rows.length.toLocaleString();
  const noun = rows.length === 1 ? rowNoun : `${rowNoun}s`;
  const footerLabel =
    props.totalRows !== undefined && props.totalRows !== rows.length
      ? `${loadedFmt} of ${props.totalRows.toLocaleString()} ${rowNoun}s`
      : `${loadedFmt} ${noun}`;

  // Auto-width: measure ONCE per columns identity, the first time we
  // see a non-empty rows array. Subsequent rows changes (paginated
  // loads) don't trigger a remeasure — that would reshape the grid out
  // from under the operator. User resizes via SVAR's drag handle are
  // preserved by the grid's internal state regardless of what we set
  // here.
  const [autoWidths, setAutoWidths] = useState<Record<string, number>>({});
  const measuredKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (rows.length === 0) return;
    const key = columns.map((c) => `${c.id}:${c.width ?? ""}`).join("|");
    if (measuredKey.current === key) return;
    measuredKey.current = key;
    setAutoWidths(computeAutoWidths(columns, rows));
  }, [columns, rows]);

  // Map our typed Column<Row> into SVAR's IColumnConfig.
  const svarColumns = useMemo<IColumnConfig[]>(
    () =>
      columns.map((c, idx) => {
        const wantsFilter = c.filter !== false;
        const filterType = c.filter === false ? undefined : c.filter ?? "text";
        // SVAR's filter input lives on the HEADER cell, not on the
        // column directly. To get a filterable header we have to pass
        // the structured `IHeaderCell` shape instead of a plain
        // string. The `text` field becomes the title shown above the
        // filter input.
        const headerCell = wantsFilter
          ? [{ text: c.header, filter: filterType }]
          : c.header;
        const cfg: IColumnConfig = {
          id: c.id,
          header: headerCell,
          sort: c.sort !== false,
          resize: c.resize !== false,
          // Footer cell: SVAR pins it to the bottom of the grid when
          // `footer={true}` is set on <Grid>. We put the loaded-row
          // count in the first column and leave the rest blank.
          footer: idx === 0 ? footerLabel : ""
        };
        const explicit = c.width;
        const measured = autoWidths[c.id];
        if (explicit !== undefined) {
          cfg.width = explicit;
        } else if (measured !== undefined) {
          cfg.width = measured;
        } else {
          // Pre-measurement (no rows yet) — flex-grow so the row line
          // still reaches the right edge instead of leaving a band of
          // empty space. As soon as the first page arrives we switch
          // to measured widths.
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
    [columns, autoWidths, footerLabel]
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

  // Mirror the current loader callbacks into a ref so the scroll
  // listener bound below doesn't have to re-bind on every render
  // (and lose intermediate scroll events while React tears it down).
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
  };

  // Vanilla DOM scroll listener on SVAR's `.wx-scroll` container — the
  // version-shifting internal `api.on("scroll", …)` payload didn't
  // give us a reliable bottom-of-viewport signal, so we just watch
  // scrollTop / scrollHeight / clientHeight directly. Fires
  // `onLoadMore()` whenever we're within `THRESHOLD_PX` of the bottom.
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = hostRef.current;
    if (!root) return;
    const scroller = root.querySelector(".wx-scroll") as HTMLElement | null;
    if (!scroller) return;
    const THRESHOLD_PX = 300;
    const check = (): void => {
      const cur = latest.current;
      if (!cur.hasMore || cur.isLoadingMore || !cur.onLoadMore) return;
      const remaining =
        scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
      if (remaining <= THRESHOLD_PX) cur.onLoadMore();
    };
    scroller.addEventListener("scroll", check, { passive: true });
    // Also check after layout in case the initial page didn't fill the
    // viewport (then scroll never fires and the user is stuck).
    const id = requestAnimationFrame(check);
    return () => {
      scroller.removeEventListener("scroll", check);
      cancelAnimationFrame(id);
    };
    // Re-bind whenever the loaded row count changes — SVAR re-renders
    // the scroller and the previous listener target gets detached.
  }, [rows.length]);

  return (
    <div className="svar-grid-wrap">
      <div
        ref={hostRef}
        className="svar-grid-host"
        style={heightStyle ? { height: heightStyle, minHeight: 200 } : undefined}
      >
        <Willow>
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
              footer
              // filterValues is the initial filter state. SVAR mutates
              // its own copy as the user types in the header filters,
              // so we hand back an empty object on every mount — the
              // filter inputs we declared per column do the real work.
              filterValues={{}}
              init={onInit}
            />
          )}
        </Willow>
      </div>
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
