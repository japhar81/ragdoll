import {
  PluginRegistry,
  type InProcessPlugin,
  type PluginManifest,
  type RegisteredPlugin
} from "../../plugin-sdk/src/index.ts";
import {
  ProviderRegistry,
  OpenAIProvider,
  AnthropicProvider,
  OllamaCompatibleProvider
} from "../../providers/src/index.ts";
import {
  isConnectionDriverPlugin,
  registerConnectionDriverPlugin
} from "../../external-connections/src/index.ts";
// In-tree built-in plugin modules. Statically imported so the legacy
// sync `loadPluginRegistry()` keeps working without an `await`.
// The new store-backed path in `loadPluginRegistryWithStore` reaches
// the SAME modules through `lifecycle.loadSource` (dynamic-import of
// the file path) — both code paths converge on the same plugins.
import * as builtinRagSyncModule from "../../../plugins/builtin-rag/src/index.ts";
import * as sampleTextSyncModule from "../../../plugins/sample-text/index.ts";
import { cartographyCrawlManifest } from "../../../plugins/builtin-rag/src/cartography.ts";
import { cloudqueryAwsSyncManifest } from "../../../plugins/builtin-rag/src/cloudquery.ts";
import {
  BUILTIN_SOURCE_ID,
  type PluginSource,
  type PluginSourceStore
} from "./sources.ts";
import {
  buildPluginRegistry,
  PluginRegistryHolder
} from "./registry-holder.ts";

// PLUGIN-ARCH-1 re-exports — the holder + lifecycle + source store
// are the public seam for callers that want refresh, provenance, or
// a custom source store (e.g. the API's DB-backed store).
export {
  PluginRegistryHolder,
  buildPluginRegistry,
  refreshPluginRegistry,
  type RefreshReport
} from "./registry-holder.ts";
export {
  BUILTIN_SOURCES,
  BUILTIN_SOURCE_ID,
  SAMPLE_TEXT_SOURCE_ID,
  DbPluginSourceStore,
  InMemoryPluginSourceStore,
  type PluginSource,
  type PluginSourceStore
} from "./sources.ts";
export {
  loadSource,
  __clearPluginCacheForTests,
  type LoadOpts,
  type SourceLoadStatus
} from "./lifecycle.ts";

/**
 * Duck-types a module export as an `InProcessPlugin`.
 *
 * We deliberately avoid `instanceof` (plugins are plain objects) and instead
 * check for the structural contract: a `manifest` with a string `id` and an
 * `execute` function. Non-plugin exports (helpers, classes, constants) are
 * skipped safely.
 */
export function isInProcessPlugin(value: unknown): value is InProcessPlugin {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { manifest?: unknown; execute?: unknown };
  if (typeof candidate.execute !== "function") return false;
  const manifest = candidate.manifest as { id?: unknown } | undefined;
  if (!manifest || typeof manifest !== "object") return false;
  return typeof (manifest as { id?: unknown }).id === "string";
}

/**
 * Manifest for the external `crawl4ai_crawler` data source. The configSchema
 * mirrors the {@link PluginManifest} JsonSchemaLike shape used by the builtin
 * manifests so the web pipeline builder renders a real form.
 */
const CRAWL4AI_MANIFEST: PluginManifest = {
  id: "crawl4ai_crawler",
  name: "Crawl4AI Crawler",
  version: "1.0.0",
  category: "datasource",
  description:
    "Crawls one or more URLs via the Crawl4AI engine and emits markdown/text documents for ingestion.",
  configSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Single seed URL to crawl. Use this or `urls`."
      },
      urls: {
        type: "array",
        items: { type: "string" },
        description: "Multiple seed URLs to crawl. Use this or `url`."
      },
      maxPages: {
        type: "integer",
        default: 10,
        description: "Maximum number of pages to fetch."
      },
      maxDepth: {
        type: "integer",
        default: 1,
        description: "Maximum link depth to follow from each seed URL."
      },
      sameDomainOnly: {
        type: "boolean",
        default: true,
        description: "Restrict crawling to the seed URL's domain."
      },
      allowedDomains: {
        type: "array",
        items: { type: "string" },
        description: "Additional domains the crawler may visit."
      },
      extract: {
        type: "string",
        enum: ["markdown", "text"],
        default: "markdown",
        description: "Content extraction format for fetched pages."
      },
      timeoutMs: {
        type: "integer",
        default: 60000,
        description: "Per-page fetch timeout in milliseconds."
      },
      allowPrivateNetworks: {
        type: "boolean",
        default: false,
        description: "Allow crawling private/loopback addresses (SSRF guard off)."
      }
    },
    additionalProperties: false
  },
  secretsSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  outputPorts: [
    { name: "documents", description: "Array of crawled documents with markdown/text content + source URL." }
  ],
  capabilities: ["ingestion"],
  ui: {
    icon: "spider",
    color: "#0ea5e9",
    formHints: {
      url: { widget: "text" },
      urls: { widget: "tags" },
      maxPages: { widget: "number", min: 1, step: 1 },
      maxDepth: { widget: "number", min: 0, step: 1 },
      sameDomainOnly: { widget: "checkbox" },
      allowedDomains: { widget: "tags" },
      extract: { widget: "select" },
      timeoutMs: { widget: "number", min: 1000, step: 1000 },
      allowPrivateNetworks: { widget: "checkbox" }
    }
  }
};

/**
 * Manifest for the external `scrapy_spider` data source. See
 * {@link CRAWL4AI_MANIFEST} for the schema/ui conventions.
 */
const SCRAPY_MANIFEST: PluginManifest = {
  id: "scrapy_spider",
  name: "Scrapy Spider",
  version: "1.0.0",
  category: "datasource",
  description:
    "Runs a Scrapy spider across the given start URLs and emits crawled documents for ingestion.",
  configSchema: {
    type: "object",
    properties: {
      startUrls: {
        type: "array",
        items: { type: "string" },
        description: "Seed URLs the spider starts from."
      },
      allowedDomains: {
        type: "array",
        items: { type: "string" },
        description: "Domains the spider is permitted to follow links into."
      },
      maxPages: {
        type: "integer",
        default: 20,
        description: "Maximum number of pages to fetch."
      },
      maxDepth: {
        type: "integer",
        default: 2,
        description: "Maximum link depth to follow."
      },
      allowPrivateNetworks: {
        type: "boolean",
        default: false,
        description: "Allow crawling private/loopback addresses (SSRF guard off)."
      }
    },
    required: ["startUrls"],
    additionalProperties: false
  },
  secretsSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  outputPorts: [
    { name: "documents", description: "Array of crawled documents with extracted content + source URL." }
  ],
  capabilities: ["ingestion"],
  ui: {
    icon: "bug",
    color: "#16a34a",
    formHints: {
      startUrls: { widget: "tags" },
      allowedDomains: { widget: "tags" },
      maxPages: { widget: "number", min: 1, step: 1 },
      maxDepth: { widget: "number", min: 0, step: 1 },
      allowPrivateNetworks: { widget: "checkbox" }
    }
  }
};

/**
 * If `process.env.PYTHON_PLUGIN_URL` is set, registers the `crawl4ai_crawler`
 * and `scrapy_spider` plugins as external HTTP plugins pointed at that base
 * URL. When the env var is unset this is a no-op, so default/offline behavior
 * is unchanged. Registration is additive to in-process auto-discovery.
 *
 * Exported so the holder-aware code path
 * (`loadPluginRegistryWithStore` + `refreshPluginRegistry`'s
 * `postRegister` hook) can re-apply these env-driven plugins to
 * EVERY freshly-built registry. The source store doesn't know about
 * them — they're a runtime capability of the python-plugins sidecar,
 * not a git-loadable source.
 */
export function registerExternalPlugins(registry: PluginRegistry): void {
  const baseUrl = process.env.PYTHON_PLUGIN_URL;
  if (!baseUrl) return;
  const timeoutMs = Number(process.env.PYTHON_PLUGIN_TIMEOUT_MS ?? 300000);
  // cartography_crawl gets a longer timeout because real cloud crawls
  // routinely run for tens of minutes (default 30 from the manifest);
  // the per-invocation Connect call needs to outlive the cartography
  // CLI itself. The handler still enforces its own `config.timeoutMs`
  // server-side — this is just the wire deadline.
  const cartographyTimeoutMs = Number(
    process.env.PYTHON_PLUGIN_CARTOGRAPHY_TIMEOUT_MS ?? 1_800_000
  );
  // cloudquery syncs are the same shape as cartography crawls — real
  // multi-region AWS syncs run for tens of minutes. Same env-overridable
  // budget so operators can lift it for megafleets without a code change.
  const cloudqueryTimeoutMs = Number(
    process.env.PYTHON_PLUGIN_CLOUDQUERY_TIMEOUT_MS ?? 1_800_000
  );
  const externalRegistrations: Array<{ manifest: PluginManifest; timeoutMs: number }> = [
    { manifest: CRAWL4AI_MANIFEST, timeoutMs },
    { manifest: SCRAPY_MANIFEST, timeoutMs },
    { manifest: cartographyCrawlManifest, timeoutMs: cartographyTimeoutMs },
    { manifest: cloudqueryAwsSyncManifest, timeoutMs: cloudqueryTimeoutMs }
  ];
  for (const { manifest, timeoutMs: perPluginTimeout } of externalRegistrations) {
    const registered: RegisteredPlugin = {
      mode: "external",
      manifest,
      external: {
        // Connect transport (default). httpVersion stays at 1.1 for
        // compatibility with the python-plugins sidecar's hypercorn
        // setup; bump to "2" once we standardise on h2 across the
        // python service.
        baseUrl,
        timeoutMs: perPluginTimeout
      }
    };
    registry.register(registered);
  }
}

/**
 * Builds a `PluginRegistry` containing every in-process and external
 * plugin known to the runtime.
 *
 * PLUGIN-ARCH-1 made the source list a first-class abstraction
 * (`PluginSourceStore` — DB-backed in production, in-memory in
 * tests). This function preserves the legacy "no async" call
 * signature for callers that don't care about source rows by
 * loading only the in-tree built-ins synchronously plus the external
 * PYTHON_PLUGIN_URL plugins. Callers that want the full architecture
 * (DB-backed sources, refresh, provenance reporting) use
 * `buildPluginRegistry({store})` directly + a `PluginRegistryHolder`
 * — see `apps/api/src/server.ts` for the canonical wiring.
 *
 * Iteration over the built-in module namespaces is preserved —
 * plugins added to `plugins/builtin-rag` are still picked up without
 * any edits here.
 */
export function loadPluginRegistry(): PluginRegistry {
  // Synchronous in-tree load — kept compatible with the legacy
  // signature. Uses the same scan/duck-type as the new lifecycle so
  // adding a plugin to plugins/builtin-rag/src works identically
  // through both code paths.
  const registry = new PluginRegistry();
  void registerInTreeBuiltins(registry);
  registerExternalPlugins(registry);
  return registry;
}

/**
 * PLUGIN-ARCH-1: async loader that consumes a source store. The API +
 * worker wire this through a `PluginRegistryHolder` so the refresh
 * endpoint can swap the registry atomically.
 *
 * `extraSources` is for tests / staging — sources beyond what the
 * store returns (the in-memory test store handles this directly, so
 * production callers leave it empty).
 */
export async function loadPluginRegistryWithStore(args: {
  store: PluginSourceStore;
  extraSources?: PluginSource[];
}): Promise<{ holder: PluginRegistryHolder; statuses: SourceLoadStatusFromLifecycle[] }> {
  const { registry, statuses } = await buildPluginRegistry({
    store: args.extraSources?.length
      ? wrapStoreWithExtras(args.store, args.extraSources)
      : args.store
  });
  // External PYTHON_PLUGIN_URL plugins are layered on top — they
  // aren't part of the source-store world (they're a runtime
  // capability of the sidecar). Registering them HERE keeps the
  // existing operator-facing semantics: set PYTHON_PLUGIN_URL +
  // cartography/crawl4ai/scrapy/cloudquery_aws_sync show up.
  registerExternalPlugins(registry);
  const holder = new PluginRegistryHolder(registry, statuses);
  return { holder, statuses };
}

type SourceLoadStatusFromLifecycle = Awaited<
  ReturnType<typeof buildPluginRegistry>
>["statuses"][number];

function wrapStoreWithExtras(
  base: PluginSourceStore,
  extras: PluginSource[]
): PluginSourceStore {
  return {
    async list(opts) {
      const inner = await base.list(opts);
      return [...inner, ...(opts?.enabledOnly ? extras.filter((s) => s.enabled) : extras)];
    },
    markLoadResult: (a) => base.markLoadResult(a)
  };
}

/**
 * Sync register the in-tree built-in plugin modules. Used by the
 * legacy-signature `loadPluginRegistry()` for callers that don't
 * want to plumb a source store. The new lifecycle does the same
 * work for the canonical store-backed code path.
 *
 * Kept here (not deleted) because:
 *   - The API + worker tests still call `loadPluginRegistry()` to
 *     exercise the registry without a Postgres dep.
 *   - The frontend dev `pipeline-spec` validator imports the
 *     registry shape from this module.
 */
function registerInTreeBuiltins(registry: PluginRegistry): void {
  for (const moduleNs of [builtinRagSyncModule, sampleTextSyncModule]) {
    for (const exported of Object.values(moduleNs)) {
      if (isConnectionDriverPlugin(exported)) {
        registerConnectionDriverPlugin(exported);
        continue;
      }
      if (!isInProcessPlugin(exported)) continue;
      const plugin = exported;
      registry.register({
        mode: "in_process",
        manifest: plugin.manifest,
        implementation: plugin,
        source: {
          repoId: BUILTIN_SOURCE_ID,
          kind: "local"
        }
      });
    }
  }
}

/**
 * Builds a `ProviderRegistry` with the OpenAI, Anthropic, and
 * Ollama-compatible adapters registered (keyed by adapter `id`).
 */
export function loadProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(new OpenAIProvider());
  registry.register(new AnthropicProvider());
  registry.register(new OllamaCompatibleProvider());
  return registry;
}

export interface LoadedRegistries {
  plugins: PluginRegistry;
  providers: ProviderRegistry;
}

/**
 * Convenience loader returning both the plugin and provider registries.
 */
export function loadRegistries(): LoadedRegistries {
  return {
    plugins: loadPluginRegistry(),
    providers: loadProviderRegistry()
  };
}
