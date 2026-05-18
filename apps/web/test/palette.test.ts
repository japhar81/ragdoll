import test from "node:test";
import assert from "node:assert/strict";
import {
  PALETTE_GROUP_ORDER,
  decodePaletteDrag,
  defaultConfigFromSchema,
  encodePaletteDrag,
  filterAndGroupPalette,
  groupForPlugin,
  groupPalette,
  newNodeFromPlugin,
  pluginMatchesFilter,
  type PaletteDragItem
} from "../src/lib/palette.ts";
import type { PluginInfo, JsonSchemaLike } from "../src/lib/api.ts";

function plugin(p: Partial<PluginInfo> & { id: string }): PluginInfo {
  return {
    id: p.id,
    name: p.name ?? p.id,
    version: p.version ?? "1.0.0",
    category: p.category ?? "tool",
    description: p.description,
    ui: p.ui,
    configSchema: p.configSchema
  };
}

// ---- defaultConfigFromSchema -------------------------------------------

test("defaultConfigFromSchema keeps only top-level properties with a default", () => {
  const schema: JsonSchemaLike = {
    type: "object",
    properties: {
      top_k: { type: "integer", default: 5 },
      model: { type: "string", default: "gpt-4o-mini" },
      // No default -> skipped (inspector form fills it).
      api_base: { type: "string" },
      // default explicitly undefined -> skipped.
      maybe: { type: "string", default: undefined },
      // Falsy-but-real defaults are preserved.
      enabled: { type: "boolean", default: false },
      threshold: { type: "number", default: 0 },
      tag: { type: "string", default: "" }
    }
  };
  assert.deepEqual(defaultConfigFromSchema(schema), {
    top_k: 5,
    model: "gpt-4o-mini",
    enabled: false,
    threshold: 0,
    tag: ""
  });
});

test("defaultConfigFromSchema is missing / garbage safe and never throws", () => {
  assert.deepEqual(defaultConfigFromSchema(undefined), {});
  assert.deepEqual(defaultConfigFromSchema({}), {});
  assert.deepEqual(defaultConfigFromSchema({ type: "object" }), {});
  assert.deepEqual(
    defaultConfigFromSchema({ properties: {} as Record<string, never> }),
    {}
  );
  // properties not an object -> {} (no throw)
  assert.deepEqual(
    defaultConfigFromSchema({ properties: null as never }),
    {}
  );
  assert.deepEqual(
    defaultConfigFromSchema("nope" as unknown as JsonSchemaLike),
    {}
  );
  // Only TOP-LEVEL defaults — nested defaults are NOT pulled up.
  const nested: JsonSchemaLike = {
    properties: {
      retrieval: {
        type: "object",
        properties: { top_k: { type: "integer", default: 9 } }
      }
    }
  };
  assert.deepEqual(defaultConfigFromSchema(nested), {});
});

// ---- newNodeFromPlugin --------------------------------------------------

test("newNodeFromPlugin carries the exact ref and seeds schema-default config", () => {
  const node = newNodeFromPlugin(
    {
      category: "datasource",
      id: "crawl4ai_crawler",
      version: "2.1.0",
      configSchema: {
        properties: {
          start_url: { type: "string" },
          max_depth: { type: "integer", default: 3 }
        }
      }
    },
    "crawl4ai_crawler"
  );
  assert.equal(node.id, "crawl4ai_crawler");
  assert.deepEqual(node.plugin, {
    category: "datasource",
    id: "crawl4ai_crawler",
    version: "2.1.0"
  });
  // start_url has no default (skipped); max_depth seeded.
  assert.deepEqual(node.config, { max_depth: 3 });
  assert.equal(node.type, undefined);
});

test("newNodeFromPlugin yields empty config when schema absent", () => {
  const node = newNodeFromPlugin(
    { category: "tool", id: "static_value_tool", version: "1.0.0" },
    "t1"
  );
  assert.deepEqual(node.config, {});
  assert.equal(node.plugin?.id, "static_value_tool");
});

// ---- groupForPlugin / groupPalette -------------------------------------

test("groupForPlugin prefers ui.paletteGroup, else maps category", () => {
  assert.equal(
    groupForPlugin(plugin({ id: "a", category: "llm" })),
    "Models"
  );
  assert.equal(
    groupForPlugin(plugin({ id: "b", category: "datasource" })),
    "Sources"
  );
  // Explicit paletteGroup wins over category mapping.
  assert.equal(
    groupForPlugin(
      plugin({ id: "c", category: "llm", ui: { paletteGroup: "Crawling" } })
    ),
    "Crawling"
  );
  // Unknown category with no hint -> Other.
  assert.equal(
    groupForPlugin(plugin({ id: "d", category: "weird_thing" })),
    "Other"
  );
});

test("groupPalette groups by paletteGroup||category in fixed order, name-sorted", () => {
  const plugins: PluginInfo[] = [
    plugin({ id: "zeta_llm", name: "Zeta LLM", category: "llm" }),
    plugin({ id: "alpha_llm", name: "Alpha LLM", category: "llm" }),
    plugin({ id: "src", name: "Source One", category: "datasource" }),
    plugin({
      id: "crawler",
      name: "Crawler",
      category: "datasource",
      ui: { paletteGroup: "Crawling" }
    }),
    plugin({ id: "mystery", name: "Mystery", category: "totally_unknown" })
  ];
  const groups = groupPalette(plugins);
  const names = groups.map((g) => g.group);
  // Sources before Models before Crawling before Other (PALETTE_GROUP_ORDER).
  assert.deepEqual(names, ["Sources", "Models", "Crawling", "Other"]);

  const models = groups.find((g) => g.group === "Models")!;
  // Items sorted by name (case-insensitive): Alpha before Zeta.
  assert.deepEqual(
    models.items.map((i) => i.id),
    ["alpha_llm", "zeta_llm"]
  );

  const other = groups.find((g) => g.group === "Other")!;
  assert.deepEqual(other.items.map((i) => i.id), ["mystery"]);
});

test("groupPalette is deterministic regardless of input order", () => {
  const a = plugin({ id: "a", name: "A", category: "llm" });
  const b = plugin({ id: "b", name: "B", category: "retriever" });
  const c = plugin({ id: "c", name: "C", category: "embedder" });
  const g1 = groupPalette([a, b, c]);
  const g2 = groupPalette([c, b, a]);
  assert.deepEqual(JSON.stringify(g1), JSON.stringify(g2));
  // "Other" (when present) always sorts last and is in the fixed order list.
  assert.equal(PALETTE_GROUP_ORDER[PALETTE_GROUP_ORDER.length - 1], "Other");
});

test("groupPalette tolerates empty / missing input", () => {
  assert.deepEqual(groupPalette([]), []);
  assert.deepEqual(groupPalette(undefined as unknown as PluginInfo[]), []);
});

// ---- encode / decode palette drag --------------------------------------

test("encodePaletteDrag / decodePaletteDrag round-trip (io + plugin)", () => {
  const io: PaletteDragItem = { kind: "io", io: "input" };
  assert.deepEqual(decodePaletteDrag(encodePaletteDrag(io)), io);
  const out: PaletteDragItem = { kind: "io", io: "output" };
  assert.deepEqual(decodePaletteDrag(encodePaletteDrag(out)), out);
  const pl: PaletteDragItem = {
    kind: "plugin",
    category: "datasource",
    id: "scrapy_spider",
    version: "1.2.0"
  };
  assert.deepEqual(decodePaletteDrag(encodePaletteDrag(pl)), pl);
});

test("decodePaletteDrag returns undefined for garbage / legacy payloads", () => {
  assert.equal(decodePaletteDrag(""), undefined);
  assert.equal(decodePaletteDrag("not json {{{"), undefined);
  // Legacy bare-category string is no longer valid JSON descriptor.
  assert.equal(decodePaletteDrag("datasource"), undefined);
  assert.equal(decodePaletteDrag("null"), undefined);
  assert.equal(decodePaletteDrag("[]"), undefined);
  assert.equal(decodePaletteDrag('{"kind":"io"}'), undefined);
  assert.equal(decodePaletteDrag('{"kind":"io","io":"middle"}'), undefined);
  assert.equal(
    decodePaletteDrag('{"kind":"plugin","id":"x","version":"1"}'),
    undefined
  );
  assert.equal(
    decodePaletteDrag('{"kind":"plugin","category":"","id":"x","version":"1"}'),
    undefined
  );
  assert.equal(decodePaletteDrag('{"kind":"mystery"}'), undefined);
  assert.equal(
    decodePaletteDrag(undefined as unknown as string),
    undefined
  );
});

// ---- pluginMatchesFilter / filterAndGroupPalette ------------------------

test("pluginMatchesFilter matches name / category / id / id@version", () => {
  const p = plugin({
    id: "crawl4ai_crawler",
    name: "Crawl4AI Crawler",
    category: "datasource",
    version: "2.0.0"
  });
  assert.equal(pluginMatchesFilter(p, ""), true);
  assert.equal(pluginMatchesFilter(p, "   "), true);
  assert.equal(pluginMatchesFilter(p, "crawl4ai"), true);
  assert.equal(pluginMatchesFilter(p, "CRAWLER"), true); // case-insensitive
  assert.equal(pluginMatchesFilter(p, "datasource"), true);
  assert.equal(pluginMatchesFilter(p, "crawl4ai_crawler@2.0.0"), true);
  // Multi-term: every whitespace-separated term must hit.
  assert.equal(pluginMatchesFilter(p, "crawl datasource"), true);
  assert.equal(pluginMatchesFilter(p, "crawl nope"), false);
  assert.equal(pluginMatchesFilter(p, "scrapy"), false);
});

test("filterAndGroupPalette drops empty groups after filtering", () => {
  const plugins: PluginInfo[] = [
    plugin({ id: "qdrant_retriever", name: "Qdrant", category: "retriever" }),
    plugin({ id: "provider_chat", name: "Chat", category: "llm" })
  ];
  const all = filterAndGroupPalette(plugins, "");
  assert.deepEqual(all.map((g) => g.group).sort(), ["Models", "Retrieval"]);
  const filtered = filterAndGroupPalette(plugins, "qdrant");
  assert.deepEqual(filtered.map((g) => g.group), ["Retrieval"]);
  assert.equal(filtered[0].items.length, 1);
  // No match -> no groups at all.
  assert.deepEqual(filterAndGroupPalette(plugins, "zzzz"), []);
});
