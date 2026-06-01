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
import * as builtinRagModule from "../../../plugins/builtin-rag/src/index.ts";
import * as sampleTextModule from "../../../plugins/sample-text/index.ts";

/**
 * The set of plugin module namespaces we scan for `InProcessPlugin` exports.
 * Adding a new plugin export to any of these modules (e.g. another agent
 * extending builtin-rag) is automatically picked up because we iterate
 * `Object.values()` of each namespace.
 */
const PLUGIN_MODULES: Array<Record<string, unknown>> = [
  builtinRagModule as unknown as Record<string, unknown>,
  sampleTextModule as unknown as Record<string, unknown>
];

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
 */
function registerExternalPlugins(registry: PluginRegistry): void {
  const baseUrl = process.env.PYTHON_PLUGIN_URL;
  if (!baseUrl) return;
  const timeoutMs = Number(process.env.PYTHON_PLUGIN_TIMEOUT_MS ?? 300000);
  for (const manifest of [CRAWL4AI_MANIFEST, SCRAPY_MANIFEST]) {
    const registered: RegisteredPlugin = {
      mode: "external",
      manifest,
      external: {
        // Connect transport (default). The crawl4ai sidecar will dual-host
        // Connect endpoints alongside its legacy FastAPI routes in Phase B;
        // until then the runtime still talks JSON-over-HTTP, just through the
        // PluginRuntime service contract. `protocol: "connect"` is the default
        // and is omitted; httpVersion stays at 1.1 for compatibility.
        baseUrl,
        timeoutMs
      }
    };
    registry.register(registered);
  }
}

/**
 * Builds a `PluginRegistry` containing every `InProcessPlugin` exported by the
 * builtin-rag and sample-text modules. Each is registered as an in-process
 * plugin keyed by `category:id:version` (see `pluginKey`).
 *
 * Iteration is over `Object.values(moduleNamespace)`, so plugins added
 * concurrently to those modules are automatically included with no edits here.
 *
 * When `process.env.PYTHON_PLUGIN_URL` is set, the external Python crawler
 * plugins are also registered (additive; see {@link registerExternalPlugins}).
 */
export function loadPluginRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  for (const moduleNamespace of PLUGIN_MODULES) {
    for (const exported of Object.values(moduleNamespace)) {
      if (!isInProcessPlugin(exported)) continue;
      const plugin = exported;
      const registered: RegisteredPlugin = {
        mode: "in_process",
        manifest: plugin.manifest,
        implementation: plugin
      };
      registry.register(registered);
    }
  }
  registerExternalPlugins(registry);
  return registry;
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
