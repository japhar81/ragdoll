/**
 * Palette coverage regression — every registered plugin must land in
 * one of the canonical groups declared in `PALETTE_GROUP_ORDER`. If
 * any plugin falls into the trailing "Other" bucket (because someone
 * set `ui.paletteGroup` to a string that's not in the order, or
 * because a new category was added to `PluginCategory` without
 * extending the `CATEGORY_GROUP` map), this test fails with the
 * offending plugin id + the bad group string.
 *
 * The "Other" bucket has been a recurring source of operator
 * confusion: plugins silently end up there when an author picks a
 * cute group name. This test is the seatbelt — adding a new group
 * means appending it to `PALETTE_GROUP_ORDER` AND documenting it in
 * `docs/developer/plugin-development.md`, which is enforced by code
 * review of the diff this test forces.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PALETTE_GROUP_ORDER, groupForPlugin } from "../src/lib/palette.ts";
import type { PluginInfo } from "../src/lib/api.ts";
import { loadPluginRegistry } from "../../../packages/plugin-loader/src/index.ts";

const KNOWN = new Set<string>(PALETTE_GROUP_ORDER as readonly string[]);

test("every registered plugin lands in a canonical palette group (no 'Other' bucket)", () => {
  // Set PYTHON_PLUGIN_URL so the loader also registers the external
  // sidecar plugins (cartography_crawl, crawl4ai_crawler, …); without
  // it those skip registration and the coverage test wouldn't notice
  // an off-list paletteGroup on a sidecar plugin.
  const prev = process.env.PYTHON_PLUGIN_URL;
  process.env.PYTHON_PLUGIN_URL = "http://python-plugins:8000";
  try {
    const registry = loadPluginRegistry();
    const offenders: Array<{ id: string; group: string }> = [];
    for (const p of registry.list()) {
      // Skip connection_driver plugins — they're catalog entries for
      // the Connections screen, not items the palette renders.
      if (p.manifest.category === "connection_driver") continue;
      const info: PluginInfo = {
        id: p.manifest.id,
        name: p.manifest.name,
        version: p.manifest.version,
        category: p.manifest.category,
        ui: p.manifest.ui as PluginInfo["ui"]
      };
      const g = groupForPlugin(info);
      if (!KNOWN.has(g) || g === "Other") {
        offenders.push({ id: info.id, group: g });
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `plugins fell into a non-canonical group. Either fix their ui.paletteGroup ` +
        `to one of [${[...KNOWN].join(", ")}] or remove the override and let the ` +
        `category default apply. Offenders:\n${offenders
          .map((o) => `  - ${o.id}: paletteGroup="${o.group}"`)
          .join("\n")}`
    );
  } finally {
    if (prev === undefined) delete process.env.PYTHON_PLUGIN_URL;
    else process.env.PYTHON_PLUGIN_URL = prev;
  }
});
