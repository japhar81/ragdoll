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
 *  - replaces SVAR's default header with a custom title + sort arrow
 *    + filter button (popover model — click button to open input,
 *    click again to clear and close). State is driven through SVAR's
 *    api.exec("sort-rows" / "filter-rows") actions so the grid stays
 *    in charge of the actual sort/filter pass over rows;
 *  - per-column resize handles, default on;
 *  - auto-sizes columns without an explicit `width` to fit their
 *    content (canvas-measured against the first page of rows, then
 *    frozen so subsequent page loads don't reshape the grid);
 *  - surfaces a "Load more" affordance via virtual-scroll auto-fetch
 *    for cursor-paged callers;
 *  - falls back to an empty-state row instead of an empty viewport.
 *
 * Heavy CSS (`@svar-ui/react-grid/all.css`) is imported once from
 * `main.tsx` so the bundle only pays for it on app boot.
 */
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
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
  /** Defaults to true — flip to false to hide the header filter button. */
  filter?: boolean;
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

const AUTO_WIDTH_SAMPLE = 80;
const AUTO_WIDTH_MIN = 80;
const AUTO_WIDTH_MAX = 480;
const CELL_PADDING_PX = 24;
// Header padding reserves room for the sort arrow + the filter button
// next to the title. ~72px is enough for both controls plus a bit of
// breathing room.
const HEADER_PADDING_PX = 72;
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
// Custom header cell — title + sort arrow + filter button popover
// ---------------------------------------------------------------------------

type SortOrder = "asc" | "desc";

interface HeaderCellProps {
  title: string;
  columnId: string;
  sortable: boolean;
  filterable: boolean;
  sortOrder: SortOrder | undefined;
  filterValue: string | undefined;
  isOpen: boolean;
  onSortToggle: (columnId: string) => void;
  onFilterButtonClick: (columnId: string, anchor: HTMLElement) => void;
}

/**
 * Header cell rendered inside every column. Layout:
 *
 *   [ title ▲ ]  [ 🔍 ]
 *      |           |
 *      |           +--- filter button: click opens a popover (rendered
 *      |                by the parent SvarDataGrid, not here — SVAR's
 *      |                Svelte/React bridge re-mounts our cell on every
 *      |                column-prop change, which would lose any state
 *      |                we kept locally and remount the <input>). The
 *      |                popover stays open while the user types until
 *      |                they press Enter, Esc, or click outside.
 *      +--- title click cycles sort: none → asc → desc → none.
 *
 * Sort and "which column's filter popover is open" both live in the
 * parent; this component is purely presentational.
 */
function HeaderCell(props: HeaderCellProps) {
  const {
    title,
    columnId,
    sortable,
    filterable,
    sortOrder,
    filterValue,
    isOpen,
    onSortToggle,
    onFilterButtonClick
  } = props;
  const filterActive = filterValue !== undefined && filterValue !== "";

  const onTitleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (sortable) onSortToggle(columnId);
  };

  const onClickButton = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onFilterButtonClick(columnId, e.currentTarget);
  };

  return (
    <div className="grid-hcell">
      <button
        type="button"
        className={`grid-hcell-title${sortable ? " sortable" : ""}`}
        onClick={onTitleClick}
        title={sortable ? `Sort by ${title}` : title}
      >
        <span className="grid-hcell-text">{title}</span>
        <span className="grid-hcell-sort" aria-hidden>
          {sortOrder === "asc" ? "▲" : sortOrder === "desc" ? "▼" : ""}
        </span>
      </button>
      {filterable && (
        <button
          type="button"
          className={`grid-hcell-filter-btn${filterActive ? " active" : ""}${
            isOpen ? " open" : ""
          }`}
          onClick={onClickButton}
          title={
            isOpen
              ? `Clear and close filter on ${title}`
              : filterActive
                ? `Filter on ${title} is active — click to edit`
                : `Filter ${title}`
          }
          aria-label={`Filter ${title}`}
          aria-pressed={isOpen}
        >
          <FilterIcon />
        </button>
      )}
    </div>
  );
}

/** Viewport-relative anchor rect captured from the trigger button. */
interface PopAnchor {
  left: number;
  top: number;
  right: number;
}

interface FilterPopoverProps {
  title: string;
  anchor: PopAnchor;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
}

/**
 * Filter popover rendered at the top of the SvarDataGrid component
 * (NOT inside SVAR's column cell). Lives in our stable React tree so
 * neither the popover container nor the input is unmounted when SVAR
 * re-renders its header cells in response to a parent-state change
 * (every keystroke updates the parent's `filters` map). That's the
 * difference vs. the previous attempt that kept the popover inside
 * the cell and lost focus + closed after one keypress.
 *
 * Positioning is `fixed`, anchored to the trigger button's
 * `getBoundingClientRect()` captured at click time. The popover
 * stays put if the operator scrolls; that's a deliberate trade-off
 * — re-anchoring on every scroll event was jittery. Operators
 * dismiss via Enter / Esc / click-outside instead.
 */
function FilterPopover(props: FilterPopoverProps) {
  const { title, anchor, value, onChange, onClose } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    // Move the caret to the end if there's existing text so the
    // operator can extend the filter rather than overwrite it.
    const el = inputRef.current;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // Click-outside closes the popover without clearing the filter —
  // but with ONE explicit exception: clicks that land on ANY header
  // filter button. Those buttons own the open / clear / switch
  // toggle themselves (see `onFilterButtonClick` in the wrapper).
  // Without this skip, our microtask-deferred onClose would land
  // BEFORE the button's onClick, leaving popState=undefined; the
  // button would then read that and open the popover instead of
  // clearing it. The race was the cause of the "clear doesn't
  // work" bug.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const root = rootRef.current;
      if (!root || root.contains(e.target as Node)) return;
      const target = e.target as HTMLElement | null;
      if (target && target.closest(".grid-hcell-filter-btn")) return;
      queueMicrotask(onClose);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Esc / Enter close the popover. Esc keeps the filter; Enter is
  // also "commit and close" since the filter is already applied
  // live on every keystroke.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      className="grid-hcell-filter-pop"
      role="dialog"
      // Right-align with the trigger button when possible; fall back
      // to left-align if it would overflow the viewport. We compute
      // left such that the popover's right edge sits at `anchor.right`
      // but never less than 8px from the viewport left edge.
      style={{
        position: "fixed",
        top: anchor.top,
        left: Math.max(8, anchor.right - 224),
        minWidth: 220
      }}
    >
      <input
        ref={inputRef}
        type="text"
        className="grid-hcell-filter-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`Filter ${title}…`}
      />
    </div>
  );
}

function FilterIcon() {
  // Inline SVG funnel — keeps the bundle from pulling an icon set just
  // for one button. Uses currentColor so the .active state can recolor
  // via CSS without swapping the icon.
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M2 3h12l-4.5 5.5V13l-3 1V8.5L2 3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
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

  // Sort + filter state. Owned here so the custom header cells stay
  // dumb-presentational. Changes are pushed to SVAR via api.exec —
  // SVAR's internal store then applies the sort/filter pass over the
  // rows. We don't pass `sortMarks` / `filterValues` as controlled
  // props because SVAR re-creates its data store on data identity
  // change; pushing through the API is the durable path.
  const apiRef = useRef<IApi | undefined>(undefined);
  const [sort, setSort] = useState<{ key: string; order: SortOrder } | undefined>(
    undefined
  );
  const [filters, setFilters] = useState<Record<string, string>>({});
  // Which column's filter popover is currently open, plus the anchor
  // rect captured from the trigger button at click time. Lives here
  // (not inside HeaderCell) because SVAR's React adapter re-mounts
  // header cells whenever the columns prop changes — every keystroke
  // updates `filters`, which would otherwise close the popover and
  // remount the input mid-typing.
  const [popState, setPopState] = useState<
    { columnId: string; title: string; anchor: PopAnchor } | undefined
  >(undefined);

  const onSortToggle = useCallback((columnId: string) => {
    setSort((prev) => {
      let next: { key: string; order: SortOrder } | undefined;
      if (!prev || prev.key !== columnId) next = { key: columnId, order: "asc" };
      else if (prev.order === "asc") next = { key: columnId, order: "desc" };
      else next = undefined; // third click clears
      const api = apiRef.current;
      if (api) {
        if (next) {
          void api.exec("sort-rows", { key: next.key, order: next.order });
        } else {
          // SVAR's clear-sort idiom: omit `order` to reset. We pass
          // the column key so the store knows which mark to remove.
          void api.exec("sort-rows", { key: columnId });
        }
      }
      return next;
    });
  }, []);

  const onFilterChange = useCallback((columnId: string, value: string) => {
    setFilters((prev) => {
      const next = { ...prev };
      if (value === "") delete next[columnId];
      else next[columnId] = value;
      return next;
    });
    const api = apiRef.current;
    if (api) {
      void api.exec("filter-rows", {
        key: columnId,
        value: value === "" ? undefined : value
      });
    }
  }, []);

  // Headers ask the wrapper to open / clear / close the popover. Same
  // button clicked twice clears the column's filter and closes; click
  // on a DIFFERENT column's button switches the popover (without
  // clearing the previous filter). Click on the same button while
  // it's the active popover is the operator's "clear" affordance.
  //
  // We capture the trigger's getBoundingClientRect at click time so
  // the FilterPopover (rendered above with `position: fixed`) lands
  // directly below the button regardless of grid scroll position.
  const onFilterButtonClick = useCallback(
    (columnId: string, anchorEl: HTMLElement) => {
      setPopState((prev) => {
        if (prev?.columnId === columnId) {
          onFilterChange(columnId, "");
          return undefined;
        }
        const rect = anchorEl.getBoundingClientRect();
        const col = columns.find((c) => c.id === columnId);
        return {
          columnId,
          title: col?.header ?? columnId,
          anchor: { left: rect.left, top: rect.bottom + 4, right: rect.right }
        };
      });
    },
    [columns, onFilterChange]
  );

  const closeFilterPopover = useCallback(() => setPopState(undefined), []);

  // Close the popover if the grid scrolls or the window resizes —
  // the captured anchor rect would otherwise drift away from the
  // button. The operator can re-open instantly; their typed filter
  // stays applied.
  useEffect(() => {
    if (!popState) return;
    const onScroll = () => setPopState(undefined);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
    };
  }, [popState]);

  // Map our typed Column<Row> into SVAR's IColumnConfig.
  const svarColumns = useMemo<IColumnConfig[]>(
    () =>
      columns.map((c, idx) => {
        const sortable = c.sort !== false;
        const filterable = c.filter !== false;
        // Custom header cell: shows title + sort arrow + filter button.
        // `text` is omitted because the custom `cell` already renders
        // the title (otherwise SVAR draws both and the cell looks
        // doubled-up). The filter type stays declared so SVAR's
        // createFilter wires the rows-filter pass when api.exec
        // pushes a value.
        const headerCellRenderer = () => (
          <HeaderCell
            title={c.header}
            columnId={c.id}
            sortable={sortable}
            filterable={filterable}
            sortOrder={sort?.key === c.id ? sort.order : undefined}
            filterValue={filters[c.id]}
            isOpen={popState?.columnId === c.id}
            onSortToggle={onSortToggle}
            onFilterButtonClick={onFilterButtonClick}
          />
        );
        const headerCell: Record<string, unknown> = {
          cell: headerCellRenderer
        };
        if (filterable) {
          // Declare the filter type so SVAR's createFilter pass knows
          // how to match against the value we push via api.exec.
          headerCell.filter = "text";
        }
        const cfg: IColumnConfig = {
          id: c.id,
          header: [headerCell],
          // We drive sort ourselves through api.exec, but leaving
          // `sort: true` on the column still lets SVAR's internal
          // store know which columns are sortable (for clear-sort
          // behaviour). The native header sort-on-click is not
          // triggered because our custom header cell stops
          // propagation of its title-button click.
          sort: sortable,
          resize: c.resize !== false,
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
          cfg.cell = ({ row }) => <>{c.cell!(row as Row)}</>;
        }
        return cfg;
      }),
    [
      columns,
      autoWidths,
      footerLabel,
      sort,
      filters,
      popState,
      onSortToggle,
      onFilterButtonClick
    ]
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

  const onInit = (api: IApi): void => {
    apiRef.current = api;
    // Re-apply any pending sort/filter that was set BEFORE the api was
    // ready (e.g. the operator quickly opened the popover and typed
    // before SVAR's `init` callback fired). React's effect order
    // generally means this is a no-op, but it's cheap insurance.
    if (sort) {
      void api.exec("sort-rows", { key: sort.key, order: sort.order });
    }
    for (const [key, value] of Object.entries(filters)) {
      void api.exec("filter-rows", { key, value });
    }
  };

  // Vanilla DOM scroll listener on SVAR's `.wx-scroll` container.
  // Fires `onLoadMore()` whenever we're within `THRESHOLD_PX` of the
  // bottom.
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
    const id = requestAnimationFrame(check);
    return () => {
      scroller.removeEventListener("scroll", check);
      cancelAnimationFrame(id);
    };
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
              footer
              filterValues={{}}
              init={onInit}
            />
          )}
        </Willow>
      </div>
      {props.isLoadingMore && (
        <div className="svar-grid-loadmore" aria-live="polite">
          Loading more rows…
        </div>
      )}
      {/* Filter popover lives at the wrapper level — outside SVAR's
          column-cell render path — so it stays mounted while the
          operator types. Without this lift, SVAR re-mounts the cell
          on every keystroke (parent state update → new columns
          array → fresh React cell instance) and the popover would
          disappear after one character. */}
      {popState && (
        <FilterPopover
          title={popState.title}
          anchor={popState.anchor}
          value={filters[popState.columnId] ?? ""}
          onChange={(v) => onFilterChange(popState.columnId, v)}
          onClose={closeFilterPopover}
        />
      )}
    </div>
  );
}
