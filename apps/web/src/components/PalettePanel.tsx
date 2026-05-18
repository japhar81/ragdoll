import React, { useMemo, useState } from "react";
import type { PluginInfo } from "../lib/api.ts";
import {
  DND_MIME,
  nodeTheme,
  styleKeyFor,
  type StyleKey
} from "../lib/graph.ts";
import {
  encodePaletteDrag,
  filterAndGroupPalette,
  type PaletteDragItem
} from "../lib/palette.ts";

/**
 * The fixed "Flow" group: Input and Output sentinels. These never come from
 * the plugin registry — they map to `newIoNode` on add.
 */
const IO_ITEMS: Array<{ io: "input" | "output"; label: string }> = [
  { io: "input", label: "Input" },
  { io: "output", label: "Output" }
];

/** A swatch + emoji reusing the canvas node theme for visual consistency. */
function Swatch({ styleKey }: { styleKey: StyleKey }) {
  const theme = nodeTheme(styleKey);
  return (
    <span
      className="palette-swatch"
      style={{ background: theme.color }}
      aria-hidden="true"
    >
      {theme.icon}
    </span>
  );
}

function startDrag(event: React.DragEvent, item: PaletteDragItem) {
  event.dataTransfer.setData(DND_MIME, encodePaletteDrag(item));
  event.dataTransfer.effectAllowed = "move";
}

export interface PalettePanelProps {
  plugins: PluginInfo[];
  isLoading: boolean;
  isError: boolean;
  /** Add a node at the default position (click path; drag uses onDrop). */
  onAdd: (item: PaletteDragItem) => void;
}

/**
 * Plugin-granular Node Palette. A fixed Flow group (Input/Output) then every
 * registered plugin as its own draggable + clickable row, grouped by
 * `ui.paletteGroup || category` in a deterministic order. A quick-filter at
 * the top narrows by name / category / id. Never crashes the builder: loading,
 * empty and error states all degrade gracefully.
 */
export function PalettePanel({
  plugins,
  isLoading,
  isError,
  onAdd
}: PalettePanelProps) {
  const [filter, setFilter] = useState("");
  // Collapsed groups (by name). Default: every group expanded.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const groups = useMemo(
    () => filterAndGroupPalette(plugins, filter),
    [plugins, filter]
  );

  const toggle = (group: string) =>
    setCollapsed((c) => ({ ...c, [group]: !c[group] }));

  const totalShown = groups.reduce((acc, g) => acc + g.items.length, 0);

  return (
    <aside className="palette">
      <h2>Node Palette</h2>
      <p className="muted">Click to add, or drag onto the canvas.</p>
      <input
        className="palette-filter"
        type="text"
        placeholder="Filter plugins…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        aria-label="Filter plugins"
      />

      {/* Fixed Flow group: io sentinels, always present. */}
      <div className="palette-group">
        <div className="palette-group-head" aria-hidden="true">
          <span className="palette-group-name">Flow</span>
          <span className="palette-group-count">{IO_ITEMS.length}</span>
        </div>
        <div className="palette-group-items">
          {IO_ITEMS.map(({ io, label }) => {
            const item: PaletteDragItem = { kind: "io", io };
            return (
              <button
                key={io}
                type="button"
                className="palette-item"
                draggable
                onDragStart={(e) => startDrag(e, item)}
                onClick={() => onAdd(item)}
                title={`Add an ${label} node`}
              >
                <Swatch styleKey={io} />
                <span className="palette-item-text">
                  <span className="palette-item-name">{label}</span>
                  <span className="palette-item-sub">flow / {io}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {isLoading && <p className="muted">Loading plugins…</p>}
      {isError && !isLoading && (
        <p className="error" title="GET /api/plugins failed">
          plugins unavailable
        </p>
      )}
      {!isLoading && !isError && plugins.length === 0 && (
        <p className="muted">No plugins registered.</p>
      )}
      {!isLoading && !isError && plugins.length > 0 && totalShown === 0 && (
        <p className="muted">No plugins match “{filter}”.</p>
      )}

      {groups.map(({ group, items }) => {
        const isCollapsed = !!collapsed[group];
        return (
          <div className="palette-group" key={group}>
            <button
              type="button"
              className="palette-group-head"
              onClick={() => toggle(group)}
              aria-expanded={!isCollapsed}
            >
              <span className="palette-group-caret">
                {isCollapsed ? "▸" : "▾"}
              </span>
              <span className="palette-group-name">{group}</span>
              <span className="palette-group-count">{items.length}</span>
            </button>
            {!isCollapsed && (
              <div className="palette-group-items">
                {items.map((p) => {
                  const item: PaletteDragItem = {
                    kind: "plugin",
                    category: p.category,
                    id: p.id,
                    version: p.version
                  };
                  const styleKey = styleKeyFor({
                    id: p.id,
                    plugin: {
                      category: p.category as never,
                      id: p.id,
                      version: p.version
                    }
                  });
                  return (
                    <button
                      key={`${p.category}/${p.id}/${p.version}`}
                      type="button"
                      className="palette-item"
                      draggable
                      onDragStart={(e) => startDrag(e, item)}
                      onClick={() => onAdd(item)}
                      title={p.description ?? `${p.category} / ${p.id}`}
                    >
                      <Swatch styleKey={styleKey} />
                      <span className="palette-item-text">
                        <span className="palette-item-name">{p.name}</span>
                        <span className="palette-item-sub">
                          {p.category} · {p.id}@{p.version}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </aside>
  );
}

export default PalettePanel;
